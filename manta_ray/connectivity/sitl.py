"""Minimal vehicle model for demonstrating the stop-and-surface handoff."""

from collections.abc import Callable
from threading import Lock
from time import monotonic

from .receiver import VehicleStatus


class DemoVehicle:
    """Begin at 2 m depth, cruise at 0.4 m/s, and surface at 0.5 m/s."""

    def __init__(self, clock: Callable[[], float] = monotonic) -> None:
        self._clock = clock
        self._lock = Lock()
        self._ascent_started_at: float | None = None
        self._events: list[str] = []

    def stop_and_surface(self) -> bool:
        with self._lock:
            if self._ascent_started_at is not None:
                return False
            self._ascent_started_at = self._clock()
            self._events.extend(("command_received", "forward_motion_stopped"))
            return True

    def status(self) -> VehicleStatus:
        with self._lock:
            if self._ascent_started_at is None:
                return VehicleStatus("surveying", 2.0, 0.4, ())

            elapsed_s = self._clock() - self._ascent_started_at
            depth_m = max(0.0, 2.0 - 0.5 * elapsed_s)
            state = "surfacing"
            if depth_m == 0.0:
                state = "surfaced"
                if self._events[-1] != "surface_reached":
                    self._events.append("surface_reached")
            return VehicleStatus(state, depth_m, 0.0, tuple(self._events))
