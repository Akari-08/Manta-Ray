"""Local HTTP interface between a dashboard and a SITL vehicle controller."""

import json
from dataclasses import asdict, dataclass
from functools import partial
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Protocol


@dataclass(frozen=True)
class VehicleStatus:
    state: str
    depth_m: float
    forward_speed_mps: float
    events: tuple[str, ...]


class VehicleController(Protocol):
    """Implement both methods safely for concurrent HTTP requests."""

    def status(self) -> VehicleStatus:
        """Return the latest vehicle state and stop-and-surface event history."""
        ...

    def stop_and_surface(self) -> bool:
        """Return True if newly accepted, or False if already requested this mission."""
        ...


class _CommandHandler(BaseHTTPRequestHandler):
    def __init__(self, *args, controller: VehicleController, **kwargs):
        self.controller = controller
        super().__init__(*args, **kwargs)

    def setup(self) -> None:
        self.request.settimeout(5)
        super().setup()

    def _json(self, status: HTTPStatus, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path != "/status":
            self._json(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint"})
            return
        self._json(HTTPStatus.OK, asdict(self.controller.status()))

    def do_POST(self) -> None:
        if self.path != "/commands":
            self._json(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint"})
            return
        if self.headers.get_content_type() != "application/json":
            self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "expected application/json"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") is not None or len(lengths) != 1:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "expected one Content-Length header"})
            return
        try:
            size = int(lengths[0])
        except ValueError:
            size = 0
        if not 1 <= size <= 1024:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "expected a JSON body of 1 to 1024 bytes"})
            return
        try:
            body = self.rfile.read(size)
        except TimeoutError:
            self._json(HTTPStatus.REQUEST_TIMEOUT, {"error": "request body timed out"})
            return
        if len(body) != size:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "incomplete request body"})
            return
        try:
            command = json.loads(body)
        except (ValueError, RecursionError):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            return
        if command != {"command": "STOP_AND_SURFACE"}:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "expected STOP_AND_SURFACE"})
            return

        accepted = self.controller.stop_and_surface()
        self._json(
            HTTPStatus.ACCEPTED if accepted else HTTPStatus.OK,
            {
                "command": "STOP_AND_SURFACE",
                "result": "accepted" if accepted else "already_requested",
                "status": asdict(self.controller.status()),
            },
        )


def create_server(controller: VehicleController, port: int = 8765) -> ThreadingHTTPServer:
    """Bind to loopback for local SITL testing and dashboard integration."""
    return ThreadingHTTPServer(("127.0.0.1", port), partial(_CommandHandler, controller=controller))
