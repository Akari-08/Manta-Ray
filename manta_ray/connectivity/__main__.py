"""Serve commands and telemetry for the local SITL demo."""

import argparse

from .receiver import create_server
from .sitl import DemoVehicle


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765, help="loopback port (default: 8765)")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535")

    try:
        with create_server(DemoVehicle(), port=args.port) as server:
            print(f"Manta Ray SITL receiver at http://127.0.0.1:{server.server_port}", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass
    except OSError as error:
        parser.exit(1, f"Cannot start the SITL receiver: {error}\n")


if __name__ == "__main__":
    main()
