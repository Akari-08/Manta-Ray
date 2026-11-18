"""TDS provenance, timestamp matching and user-supplied reference comparisons."""

from bisect import bisect_left
import csv
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path
from statistics import median


def finite_number(value, name, minimum=0):
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be numeric") from error
    if not math.isfinite(result) or result < minimum:
        raise ValueError(f"{name} must be finite and at least {minimum}")
    return result


@dataclass(frozen=True)
class TDSReading:
    timestamp_s: float
    tds_ppm: float
    source: str
    site_id: str
    calibration_id: str
    method: str
    temperature_c: float | None


class WaterData:
    def __init__(self, csv_path=None, simulated=None, site_id="", baseline_path=None):
        self.readings = []
        self.simulated = simulated
        self.baseline = None
        if csv_path is not None:
            with Path(csv_path).open(encoding="utf-8-sig", newline="") as stream:
                reader = csv.DictReader(stream)
                required = {"timestamp_s", "tds_ppm", "source", "site_id", "calibration_id", "method", "temperature_c"}
                if not required.issubset(reader.fieldnames or []):
                    raise ValueError(f"TDS CSV requires columns {sorted(required)}")
                for line, row in enumerate(reader, 2):
                    if None in row or any(value is None for value in row.values()):
                        raise ValueError(f"Malformed TDS CSV row {line}")
                    source = row["source"].strip()
                    if source not in {"measured", "simulated"}:
                        raise ValueError(f"Invalid TDS source on row {line}")
                    reading_site = row["site_id"].strip()
                    if source == "measured" and (not site_id or reading_site != site_id):
                        raise ValueError("Measured TDS requires --site-id matching every measured row")
                    self.readings.append(TDSReading(
                        finite_number(row["timestamp_s"], "timestamp_s"),
                        finite_number(row["tds_ppm"], "tds_ppm"), source, reading_site,
                        row["calibration_id"].strip(), row["method"].strip(),
                        finite_number(row["temperature_c"], "temperature_c", -273.15)
                        if row["temperature_c"].strip() else None,
                    ))
            self.readings.sort(key=lambda reading: reading.timestamp_s)
            if not self.readings:
                raise ValueError("TDS CSV has no readings")
            times = [reading.timestamp_s for reading in self.readings]
            if len(times) != len(set(times)):
                raise ValueError("TDS timestamps must be unique")
        self.times = [reading.timestamp_s for reading in self.readings]
        if baseline_path is not None:
            baseline = json.loads(Path(baseline_path).read_text(encoding="utf-8-sig"))
            if not isinstance(baseline, dict):
                raise ValueError("TDS reference must be a JSON object")
            for field in ("site_id", "reference", "context", "method"):
                if not isinstance(baseline.get(field), str) or not baseline[field].strip():
                    raise ValueError(f"TDS reference requires a nonempty {field}")
            if not site_id or baseline["site_id"] != site_id:
                raise ValueError("TDS reference site must match --site-id")
            low = finite_number(baseline.get("min_ppm"), "min_ppm")
            high = finite_number(baseline.get("max_ppm"), "max_ppm")
            if low > high:
                raise ValueError("TDS reference minimum exceeds maximum")
            self.baseline = {**baseline, "min_ppm": low, "max_ppm": high}

    def match(self, timestamp, tolerance):
        if self.simulated is not None:
            return TDSReading(timestamp, self.simulated, "simulated", "", "", "constant_demo", None)
        index = bisect_left(self.times, timestamp)
        candidates = self.readings[max(0, index - 1):index + 1]
        if not candidates:
            return None
        nearest = min(candidates, key=lambda reading: abs(reading.timestamp_s - timestamp))
        return nearest if abs(nearest.timestamp_s - timestamp) <= tolerance else None

    def comparison(self, reading, video_source):
        if reading is None:
            return "missing"
        if reading.source == "simulated":
            return "simulated_excluded"
        if video_source != "survey":
            return "unverified_video_site"
        if not reading.calibration_id or not reading.method:
            return "calibration_unverified"
        if self.baseline is None:
            return "no_site_reference"
        if reading.method != self.baseline["method"]:
            return "incompatible_reference_method"
        return ("within_reference_range" if
                self.baseline["min_ppm"] <= reading.tds_ppm <= self.baseline["max_ppm"]
                else "outside_reference_range")

    def summary(self):
        result = {}
        for source in ("measured", "simulated"):
            readings = [asdict(reading) for reading in self.readings if reading.source == source]
            values = [reading["tds_ppm"] for reading in readings]
            result[source] = {"count": len(values), "median_ppm": median(values) if values else None,
                              "min_ppm": min(values) if values else None,
                              "max_ppm": max(values) if values else None}
        result["constant_simulated_ppm"] = self.simulated
        result["reference"] = self.baseline
        return result
