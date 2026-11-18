import json
import socket
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.client import HTTPConnection

from manta_ray.connectivity.receiver import create_server
from manta_ray.connectivity.sitl import DemoVehicle


class StopAndSurfaceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.now = 0.0
        vehicle = DemoVehicle(clock=lambda: self.now)
        server = create_server(vehicle, port=0)
        self.port = server.server_port
        self.vehicle = vehicle
        self.addCleanup(server.server_close)
        serve_thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        serve_thread.start()
        self.addCleanup(serve_thread.join)
        self.addCleanup(server.shutdown)
        self.connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)
        self.addCleanup(self.connection.close)

    def request(self, method, path, payload=None):
        headers = {"Content-Type": "application/json"} if payload is not None else {}
        body = json.dumps(payload) if payload is not None else None
        self.connection.request(method, path, body=body, headers=headers)
        response = self.connection.getresponse()
        return response.status, json.loads(response.read())

    def test_command_stops_survey_and_surfaces_even_after_retry(self) -> None:
        code, initial = self.request("GET", "/status")
        self.assertEqual(code, 200)
        self.assertEqual(initial["state"], "surveying")
        self.assertGreater(initial["forward_speed_mps"], 0)

        command = {"command": "STOP_AND_SURFACE"}
        code, accepted = self.request("POST", "/commands", command)
        self.assertEqual(code, 202)
        self.assertEqual(accepted["result"], "accepted")
        self.assertEqual(accepted["status"]["state"], "surfacing")
        self.assertEqual(accepted["status"]["forward_speed_mps"], 0)
        self.assertEqual(
            accepted["status"]["events"], ["command_received", "forward_motion_stopped"]
        )

        self.now = 2.0
        code, duplicate = self.request("POST", "/commands", command)
        self.assertEqual(code, 200)
        self.assertEqual(duplicate["result"], "already_requested")
        self.assertAlmostEqual(duplicate["status"]["depth_m"], 1.0)

        self.now = 4.0
        _, status = self.request("GET", "/status")
        self.assertEqual(status["state"], "surfaced")
        self.assertEqual(status["depth_m"], 0)
        self.assertEqual(status["forward_speed_mps"], 0)
        self.assertEqual(
            status["events"], ["command_received", "forward_motion_stopped", "surface_reached"]
        )

    def test_unknown_command_preserves_vehicle_state(self) -> None:
        code, _ = self.request("POST", "/commands", {"command": "TURN"})
        self.assertEqual(code, 400)
        _, status = self.request("GET", "/status")
        self.assertEqual(status["state"], "surveying")
        self.assertEqual(status["events"], [])

    def raw_request(self, request):
        with socket.create_connection(("127.0.0.1", self.port), timeout=7) as client:
            client.sendall(request)
            client.shutdown(socket.SHUT_WR)
            response = bytearray()
            while data := client.recv(4096):
                response.extend(data)
        head, body = bytes(response).split(b"\r\n\r\n", 1)
        return int(head.split(b" ")[1]), json.loads(body)

    def test_malformed_requests_leave_vehicle_surveying(self) -> None:
        valid = b'{"command":"STOP_AND_SURFACE"}'
        cases = [
            (b"Content-Type: text/plain\r\nContent-Length: 2", b"{}", 415),
            (b"Content-Type: application/json", b"", 400),
            (b"Content-Type: application/json\r\nContent-Length: invalid", b"{}", 400),
            (b"Content-Type: application/json\r\nContent-Length: -1", b"", 400),
            (b"Content-Type: application/json\r\nContent-Length: 1025", b"{}", 400),
            (b"Content-Type: application/json\r\nContent-Length: 100", valid, 400),
            (b"Content-Type: application/json\r\nContent-Length: 1", b"\xff", 400),
            (b"Content-Type: application/json\r\nContent-Length: 1", b"{", 400),
            (
                b"Content-Type: application/json\r\nContent-Length: 29\r\n"
                b"Content-Length: 29",
                valid,
                400,
            ),
            (
                b"Content-Type: application/json\r\nContent-Length: 29\r\n"
                b"Transfer-Encoding: chunked",
                valid,
                400,
            ),
        ]
        for headers, body, expected in cases:
            with self.subTest(headers=headers, body=body):
                code, response = self.raw_request(
                    b"POST /commands HTTP/1.0\r\n" + headers + b"\r\n\r\n" + body
                )
                self.assertEqual(code, expected)
                self.assertIn("error", response)
                self.assertEqual(self.vehicle.status().state, "surveying")
        for payload in (None, [], "STOP_AND_SURFACE", 1, True, {}, {"command": 1}):
            with self.subTest(payload=payload):
                body = json.dumps(payload).encode()
                code, _ = self.raw_request(
                    b"POST /commands HTTP/1.0\r\nContent-Type: application/json\r\n"
                    + f"Content-Length: {len(body)}\r\n\r\n".encode() + body
                )
                self.assertEqual(code, 400)
                self.assertEqual(self.vehicle.status().state, "surveying")

    def test_concurrent_retries_accept_only_one_command(self) -> None:
        barrier = threading.Barrier(12)

        def send_command(_):
            with closing(HTTPConnection("127.0.0.1", self.port, timeout=10)) as connection:
                barrier.wait(timeout=10)
                connection.request(
                    "POST", "/commands", json.dumps({"command": "STOP_AND_SURFACE"}),
                    {"Content-Type": "application/json"},
                )
                response = connection.getresponse()
                return response.status, json.loads(response.read())

        with ThreadPoolExecutor(max_workers=12) as workers:
            responses = list(workers.map(send_command, range(12)))
        self.assertEqual(sum(code == 202 for code, _ in responses), 1)
        self.assertEqual(sum(code == 200 for code, _ in responses), 11)
        self.assertEqual(
            self.vehicle.status().events, ("command_received", "forward_motion_stopped")
        )
        self.now = 4
        for _ in range(10):
            code, body = self.request("POST", "/commands", {"command": "STOP_AND_SURFACE"})
            self.assertEqual(code, 200)
            self.assertEqual(body["status"]["depth_m"], 0)
            self.assertEqual(body["status"]["events"].count("surface_reached"), 1)

    def test_incomplete_body_times_out_without_accepting_command(self) -> None:
        with socket.create_connection(("127.0.0.1", self.port), timeout=7) as client:
            client.sendall(
                b"POST /commands HTTP/1.0\r\nContent-Type: application/json\r\n"
                b"Content-Length: 100\r\n\r\n{"
            )
            response = bytearray()
            while data := client.recv(4096):
                response.extend(data)
        self.assertTrue(bytes(response).startswith(b"HTTP/1.0 408"))
        self.assertEqual(self.vehicle.status().state, "surveying")

    def test_unknown_paths_do_not_accept_commands(self) -> None:
        self.assertEqual(self.request("GET", "/missing")[0], 404)
        self.assertEqual(self.request("POST", "/missing", {"command": "STOP_AND_SURFACE"})[0], 404)
        self.assertEqual(self.vehicle.status().state, "surveying")


class RealClockAscentTest(unittest.TestCase):
    def test_vehicle_surfaces_after_four_seconds_of_real_elapsed_time(self) -> None:
        vehicle = DemoVehicle()
        self.assertTrue(vehicle.stop_and_surface())
        previous = vehicle.status()
        self.assertEqual(previous.forward_speed_mps, 0)
        started = time.monotonic()
        while previous.state != "surfaced" and time.monotonic() - started < 6:
            time.sleep(0.1)
            current = vehicle.status()
            self.assertLessEqual(current.depth_m, previous.depth_m)
            self.assertGreaterEqual(current.depth_m, 0)
            self.assertEqual(current.forward_speed_mps, 0)
            previous = current
        self.assertEqual(previous.state, "surfaced")
        self.assertGreaterEqual(time.monotonic() - started, 3.9)
        self.assertFalse(vehicle.stop_and_surface())
        self.assertEqual(
            previous.events, ("command_received", "forward_motion_stopped", "surface_reached")
        )
