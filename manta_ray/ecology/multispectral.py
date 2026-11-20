"""Calibrated, registered surface-water multispectral chlorophyll screening.

Camera adapters call assess_multispectral() with the capture contract in
example_request(). The CLI also accepts separate calibrated 8/16-bit grayscale
PGM/TIFF band files, with explicit encoding scale/offset; it does not turn raw
camera DN into reflectance. No vendor SDK or additional Python package is needed.
"""

import argparse
from array import array
from collections import Counter
from copy import deepcopy
import csv
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
import shutil
from statistics import median
import subprocess
import sys
import tempfile

METHOD = "multispectral_ndci"
ALGORITHM_VERSION = "1.0.0"
MAX_PIXELS = 65536
MAX_IMAGE_PIXELS = 16777216
REFERENCES = [
    "https://doi.org/10.1016/j.rse.2011.10.016",
    "https://webapps.usgs.gov/react/",
    "https://pmc.ncbi.nlm.nih.gov/articles/PMC7506868/",
    "https://www.epa.gov/habs/what-are-effects-habs",
]
MASK_FLAGS = {1: "non_water", 2: "glint", 4: "shadow", 8: "bottom_visible",
              16: "vegetation", 32: "saturated", 64: "no_data"}
RADIOMETRY = {"water_leaving_reflectance", "remote_sensing_reflectance_sr-1"}


def example_request():
    """A mathematical fixture, explicitly not an observation of any real lake."""
    return {"method": METHOD, "include_simulated": True, "multispectral": {
        "capture_id": "synthetic-spectral-example", "captured_at": "2026-01-01T00:00:00Z",
        "site_id": "synthetic-example", "sensor_id": "synthetic-camera", "source": "simulated",
        "geometry": "above_water_surface", "radiometry": "water_leaving_reflectance",
        "calibration": {"id": "synthetic-calibration", "method": "known numerical reflectance fixture",
                        "surface_reflection_correction": "Synthetic water-leaving values; no real sky reflection",
                        "reference": "Software test only; not field calibration"},
        "registration": {"verified": True, "method": "identical synthetic pixel grids"},
        "quality_mask": {"reviewed": True, "method": "synthetic mask; bit 2 excludes glint",
                         "values": [0, 0, 2, 0]},
        "width": 2, "height": 2,
        "bands": {"red": {"center_nm": 665, "fwhm_nm": 10, "values": [0.02, 0.03, 0.02, 0.04]},
                  "red_edge": {"center_nm": 705, "fwhm_nm": 10, "values": [0.03, 0.03, 0.08, 0.02]}}}}


def catalog_entry():
    return {"id": METHOD, "name": "Multispectral surface-water chlorophyll screening (NDCI)",
            "scope": "Relative pigment signal; no toxin or whole-ecosystem classification",
            "description": "Calculate red/red-edge NDCI from calibrated, registered water-surface bands. "
                           "Reports index statistics and pixel exclusions; RGB and submerged bottom imagery are unsuitable.",
            "required_inputs": ["multispectral capture with real band centers/FWHM, calibration and acquisition metadata",
                                "Registered red (~665 nm) and red-edge (~705–708 nm) reflectance arrays",
                                "Reviewed water-quality mask excluding glint, shadows, bottom and plants"],
            "reference_urls": REFERENCES, "example": example_request()}


def _text(value, name):
    if not isinstance(value, str) or not value.strip() or len(value) > 1024:
        raise ValueError(f"{name} must be nonempty text of at most 1024 characters")
    return value.strip()


def _number(value, name, low=-math.inf, high=math.inf):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{name} must be a finite number between {low} and {high}")
    return float(value)


def _object(value, name):
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    return value


def _integer(value, name, high):
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= high:
        raise ValueError(f"{name} must be an integer in [1, {high}]")
    return value


def _percentile(values, fraction):
    rank = (len(values) - 1) * fraction
    lower = int(rank)
    return values[lower] + (values[min(lower + 1, len(values) - 1)] - values[lower]) * (rank - lower)


def _pixels(capture):
    width = _integer(capture.get("width"), "width", MAX_PIXELS)
    height = _integer(capture.get("height"), "height", MAX_PIXELS)
    count = width * height
    if count > MAX_PIXELS:
        raise ValueError(f"Inline capture exceeds {MAX_PIXELS} pixels; use the band-file CLI sampling adapter")
    bands = _object(capture.get("bands"), "bands")
    records = {}
    for name in ("red", "red_edge"):
        band = _object(bands.get(name), f"bands.{name}")
        center = _number(band.get("center_nm"), f"{name}.center_nm", 350, 2500)
        bandwidth = _number(band.get("fwhm_nm"), f"{name}.fwhm_nm", 0.01, 1000)
        values = band.get("values")
        if not isinstance(values, list) or len(values) != count:
            raise ValueError(f"{name}.values must be a row-major array of width * height numbers (or null)")
        for value in values:
            if value is not None:
                _number(value, f"{name} pixel")
        records[name] = {"center_nm": center, "fwhm_nm": bandwidth, "values": values}
    mask = _object(capture.get("quality_mask"), "quality_mask")
    flags = mask.get("values")
    if not isinstance(flags, list) or len(flags) != count:
        raise ValueError("quality_mask.values must have width * height integer bit masks")
    if any(isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 127 for value in flags):
        raise ValueError("Quality masks use 0 for valid water and exclusion bits 1,2,4,8,16,32,64")
    return width, height, records, mask


def _calculate(capture):
    """Return exact per-sample values; all summaries use the same eligible pixels."""
    width, height, bands, mask = _pixels(capture)
    exclusions = Counter()
    indexes = []
    eligible = 0
    signal = capture.get("signal_quality")
    minimum_signal = 1e-12
    if signal is not None:
        _object(signal, "signal_quality")
        minimum_signal = _number(signal.get("minimum_band_sum"), "signal_quality.minimum_band_sum", 1e-12, 2)
        _text(signal.get("reference"), "signal_quality.reference")
    for red, edge, flags in zip(bands["red"]["values"], bands["red_edge"]["values"], mask["values"]):
        if flags:
            exclusions.update(name for bit, name in MASK_FLAGS.items() if flags & bit)
            indexes.append(None)
            continue
        eligible += 1
        reason = None
        if red is None or edge is None:
            reason = "missing_reflectance"
        elif red < 0 or edge < 0 or red > 1 or edge > 1:
            reason = "reflectance_out_of_range"
        elif red + edge <= 1e-12:
            reason = "near_zero_denominator"
        elif red + edge < minimum_signal:
            reason = "below_minimum_signal"
        if reason:
            exclusions[reason] += 1
            indexes.append(None)
        else:
            indexes.append((edge - red) / (edge + red))
    values = sorted(value for value in indexes if value is not None)
    quality = {"total_pixels": width * height, "eligible_pixels": eligible,
               "valid_pixels": len(values), "excluded_pixels": width * height - len(values),
               "valid_sample_fraction_pct": 100 * len(values) / (width * height),
               "minimum_band_sum": minimum_signal, "signal_threshold_reference": signal.get("reference") if signal else None,
               "exclusion_reasons": dict(exclusions),
               "counting": "Exclusion reason counts can overlap; total excluded pixels is a unique count."}
    statistics = None if not values else {
        "mean": math.fsum(values) / len(values), "median": median(values),
        "min": values[0], "max": values[-1], "p10": _percentile(values, 0.1),
        "p90": _percentile(values, 0.9), "unit": "dimensionless",
        "aggregation": "Pixel-index statistics within this capture; not a lakewide estimate"}
    return statistics, quality, indexes


def assess_multispectral(request, summary=None, rows=None, engine_version="2.1.0"):
    """Analyse a camera-neutral capture. The API never opens paths supplied in JSON."""
    _object(request, "request")
    if "include_simulated" in request and not isinstance(request["include_simulated"], bool):
        raise ValueError("include_simulated must be true or false")
    if "include_index_map" in request and not isinstance(request["include_index_map"], bool):
        raise ValueError("include_index_map must be true or false")
    canonical = json.dumps({"request": request, "summary": summary or {}, "rows": rows or []},
                           sort_keys=True, separators=(",", ":"), allow_nan=False)
    report = {"schema_version": 1, "engine_version": engine_version, "algorithm_version": ALGORITHM_VERSION,
              "method_id": METHOD, "method_name": catalog_entry()["name"], "status": "awaiting_spectral_inputs",
              "data_origin": "none", "scenario": False,
              "result": {"score": None, "category": None, "label": "Calibrated multispectral capture required",
                         "ndci": None, "chlorophyll_a_ug_l": None, "bloom_status": "not_confirmed",
                         "cyanobacteria_status": "not_determined", "toxin_status": "not_measured",
                         "overall_ecological_health": "not_determined"},
              "input_summary": {}, "components": [], "steps": [], "excluded_inputs": [], "missing_inputs": [],
              "assumptions": ["Acquisition, calibration, registration and mask provenance are operator supplied; external verification is required."],
              "limitations": [
                  "NDCI is an uncalibrated relative chlorophyll signal, not chlorophyll concentration or a universal bloom threshold.",
                  "Bottom, aquatic plants, glint, shadows, suspended sediment and coloured dissolved matter can confound interpretation.",
                  "Surface-water NDCI is not validated for a submerged downward camera; red/red-edge light is attenuated by water.",
                  "Pigment signals do not identify cyanotoxins, algal species, nutrients, dissolved oxygen or wildlife injury.",
                  "A single image footprint does not establish whole-lake ecological health or changes over time.",
                  "Band acceptance ranges are engineering compatibility gates, not scientific validation of a camera or concentration model.",
                  "Water-leaving correction is declared upstream; this adapter does not remove or independently verify reflected sky light.",
              ], "recommendations": [], "reference_urls": REFERENCES,
              "ecological_interpretation": "Elevated or increasing pigment signals can motivate checks for algal enrichment. "
                  "Blooms may shade habitats and deplete oxygen during decomposition; these effects are not measured by NDCI.",
              "input_sha256": hashlib.sha256(canonical.encode()).hexdigest()}
    capture = request.get("multispectral")
    if capture is None:
        report["missing_inputs"] = catalog_entry()["required_inputs"]
        return report
    _object(capture, "multispectral")
    for name in ("capture_id", "site_id", "sensor_id", "captured_at"):
        _text(capture.get(name), name)
    try:
        captured = datetime.fromisoformat(capture["captured_at"].replace("Z", "+00:00"))
        if captured.tzinfo is None:
            raise ValueError("timezone missing")
    except ValueError as error:
        raise ValueError("captured_at requires an ISO timestamp including timezone") from error
    if request.get("site_id") and request["site_id"] != capture["site_id"]:
        raise ValueError("Request and multispectral capture site_id disagree")
    if capture.get("source") not in {"measured", "simulated"}:
        raise ValueError("Multispectral source must be measured or simulated")
    report["input_summary"] = {key: capture[key] for key in ("capture_id", "site_id", "sensor_id", "captured_at", "source")}
    report["input_summary"].update({"geometry": capture.get("geometry"), "radiometry": capture.get("radiometry")})
    if capture["source"] == "simulated" and not request.get("include_simulated", False):
        report["status"] = "insufficient_data"
        report["excluded_inputs"] = [{"capture_id": capture["capture_id"], "reason": "simulated_input_excluded"}]
        return report
    report["data_origin"] = capture["source"]
    report["scenario"] = capture["source"] == "simulated"

    def unavailable(status, label, recommendation):
        report["status"] = status
        report["result"]["label"] = label
        report["recommendations"].append(recommendation)
        return report

    if capture.get("geometry") != "above_water_surface":
        return unavailable("unsupported_acquisition_geometry", "Surface-water inference unavailable",
                           "Acquire a water-surface view from above water; underwater use requires a separately validated optical model.")
    if capture.get("radiometry") not in RADIOMETRY:
        return unavailable("calibration_required", "Calibrated water reflectance required",
                           "Use the camera-specific radiometric pipeline, irradiance/panel calibration and appropriate surface-reflection correction. Raw DN/RGB is not accepted.")
    calibration = capture.get("calibration")
    if not isinstance(calibration, dict) or any(not isinstance(calibration.get(key), str) or not calibration[key].strip()
                                                 for key in ("id", "method", "reference", "surface_reflection_correction")):
        return unavailable("calibration_required", "Calibration provenance required", "Supply calibration id, method, reference and upstream surface_reflection_correction method.")
    for key in ("id", "method", "reference", "surface_reflection_correction"):
        _text(calibration[key], f"calibration.{key}")
    registration = capture.get("registration")
    if not isinstance(registration, dict) or registration.get("verified") is not True or not isinstance(registration.get("method"), str) or not registration["method"].strip():
        return unavailable("registration_required", "Registered same-capture bands required",
                           "Align synchronized bands to the same water pixels and document the verification method.")
    _text(registration["method"], "registration.method")
    width, height, bands, mask = _pixels(capture)
    report["input_summary"].update({"width": width, "height": height, "calibration": calibration,
                                   "registration": registration, "sampling": capture.get("sampling"),
                                   "bands": {key: {name: value for name, value in band.items() if name != "values"}
                                             for key, band in bands.items()}})
    if mask.get("reviewed") is not True or not isinstance(mask.get("method"), str) or not mask["method"].strip():
        return unavailable("quality_control_required", "Reviewed valid-water mask required",
                           "Exclude non-water, glint, shadows, bottom, plants, saturation and no-data pixels; record mask review.")
    _text(mask["method"], "quality_mask.method")
    report["input_summary"]["mask_method"] = mask["method"]
    red, edge = bands["red"], bands["red_edge"]
    if not (650 <= red["center_nm"] <= 680 and 695 <= edge["center_nm"] <= 725
            and red["fwhm_nm"] <= 30 and edge["fwhm_nm"] <= 30):
        return unavailable("unsupported_band_configuration", "Suitable red and red-edge bands required",
                           "This screening implementation accepts narrow red 650–680 nm and red-edge 695–725 nm bands (FWHM <=30 nm). Camera-specific validation remains necessary.")
    if not (660 <= red["center_nm"] <= 670 and 700 <= edge["center_nm"] <= 713):
        report["limitations"].append("Band centers differ from the usual ~665/~705–708 nm configuration; this adapted index is not interchangeable with published calibrations.")
    statistics, quality, indexes = _calculate(capture)
    if capture.get("signal_quality") is None:
        report["limitations"].append("No camera-specific low-signal cutoff supplied. The 1e-12 denominator guard prevents division errors; it does not validate sensor signal-to-noise.")
    report["result"]["pixel_quality"] = quality
    report["result"]["ndci"] = statistics
    report["steps"] = [{"name": "NDCI", "equation": "(R_red_edge - R_red) / (R_red_edge + R_red)",
                        "eligibility": "Reviewed mask == 0, finite reflectance in [0,1], sum > 1e-12 and supplied minimum signal if present",
                        "denominator_epsilon": 1e-12, "result": statistics}]
    if not statistics:
        return unavailable("insufficient_data", "No usable water pixels", "Review capture exposure, calibration, masks and water-surface visibility.")
    report["status"] = "computed"
    report["result"]["label"] = "Relative surface-water chlorophyll signal (NDCI)"
    if report["scenario"]:
        report["result"]["label"] = "SIMULATION SCENARIO · " + report["result"]["label"]
        report["limitations"].insert(0, "Synthetic spectral values test software only; they do not measure the condition of a real water body.")
    rule = request.get("screening_rule")
    if rule is not None:
        _object(rule, "screening_rule")
        threshold = _number(rule.get("ndci_threshold"), "ndci_threshold", -1, 1)
        reference = _text(rule.get("reference"), "screening_rule.reference")
        exceeded = sum(value is not None and value > threshold for value in indexes)
        report["result"]["operator_screening_rule"] = {
            "threshold": threshold, "reference": reference, "comparison": "NDCI > threshold",
            "exceeding_pixels": exceeded, "valid_pixels": quality["valid_pixels"],
            "exceeding_sample_fraction_pct": 100 * exceeded / quality["valid_pixels"],
            "meaning": "Operator-defined screening rule; not a validated bloom, toxin or health classification"}
    if request.get("include_index_map", False):
        report["index_map"] = {"width": width, "height": height, "values": indexes, "invalid": None,
                               "layout": "row-major", "unit": "dimensionless"}
    report["recommendations"].extend([
        "Compare repeat captures using the same camera, calibration, geometry, masks and survey design.",
        "Pair spectral data with field chlorophyll-a samples for a site/camera-specific concentration model and independent error evaluation.",
        "Use dissolved oxygen, nutrients, biological observations and toxin testing as appropriate to investigate ecological effects."])
    return report


def _pgm(filename):
    """Read native unsigned grayscale samples without RGB conversion or rescaling."""
    with filename.open("rb") as stream:
        if stream.read(2) != b"P5":
            raise ValueError("Only binary P5 grayscale PGM is supported")

        def token():
            value = bytearray()
            while True:
                character = stream.read(1)
                if not character:
                    raise ValueError("Truncated PGM header")
                if character == b"#" and not value:
                    stream.readline()
                elif character.isspace():
                    if value:
                        if character == b"\r":
                            following = stream.read(1)
                            if following != b"\n":
                                stream.seek(-1, 1)
                        return int(value)
                else:
                    value.extend(character)

        width, height, maximum = token(), token(), token()
        if not 0 < width * height <= MAX_IMAGE_PIXELS or width <= 0 or height <= 0 or not 1 <= maximum <= 65535:
            raise ValueError("Unsupported PGM dimensions or range")
        data = stream.read(width * height * (2 if maximum > 255 else 1) + 1)
        if len(data) != width * height * (2 if maximum > 255 else 1):
            raise ValueError("PGM pixel byte count mismatch")
    values = array("H" if maximum > 255 else "B")
    values.frombytes(data)
    if maximum > 255 and sys.byteorder == "little":
        values.byteswap()
    if any(value > maximum for value in values):
        raise ValueError("PGM sample exceeds its declared range")
    return width, height, values


def _image(filename, ffmpeg, ffprobe):
    if filename.stat().st_size > 128 * 1024 * 1024:
        raise ValueError("Band file exceeds 128 MiB")
    if filename.suffix.lower() == ".pgm":
        return _pgm(filename)
    if filename.suffix.lower() not in {".tif", ".tiff"}:
        raise ValueError("Use separate grayscale calibrated .pgm/.tif/.tiff band files")
    metadata = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                               "stream=width,height,pix_fmt", "-of", "json", str(filename)],
                              capture_output=True, text=True, timeout=30, check=True)
    stream = json.loads(metadata.stdout)["streams"][0]
    width, height, fmt = stream["width"], stream["height"], stream["pix_fmt"]
    if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS or fmt not in {"gray", "gray16le", "gray16be"}:
        raise ValueError("TIFF must be a separate unsigned 8/16-bit grayscale band, at most 16 megapixels")
    sixteen = fmt != "gray"
    output = subprocess.run([ffmpeg, "-v", "error", "-threads", "1", "-i", str(filename), "-frames:v", "1",
                             "-f", "rawvideo", "-pix_fmt", "gray16le" if sixteen else "gray", "pipe:1"],
                            capture_output=True, timeout=60, check=True)
    if len(output.stdout) != width * height * (2 if sixteen else 1):
        raise ValueError("Decoded band pixel byte count mismatch")
    values = array("H" if sixteen else "B")
    values.frombytes(output.stdout)
    if sixteen and sys.byteorder != "little":
        values.byteswap()
    return width, height, values


def load_request(filename, max_side=64, ffmpeg="ffmpeg", ffprobe="ffprobe"):
    """Resolve local files only in the CLI, sample identical grid locations in every band."""
    filename = Path(filename).resolve()
    if filename.stat().st_size > 2 * 1024 * 1024:
        raise ValueError("Capture JSON exceeds 2 MiB")
    envelope = json.loads(filename.read_text(encoding="utf-8-sig"))
    _object(envelope, "capture JSON")
    request = deepcopy(envelope.get("request", envelope))
    _object(request, "request")
    if request.get("method") != METHOD:
        raise ValueError(f"Capture request method must be {METHOD}")
    capture = _object(request.get("multispectral"), "multispectral")
    bands = _object(capture.get("bands"), "bands")
    file_records = [bands.get("red"), bands.get("red_edge"), capture.get("quality_mask")]
    if not any(isinstance(item, dict) and "path" in item for item in file_records):
        return request
    _integer(max_side, "max_side", 64)
    dimensions = None
    loaded = []
    for index, item in enumerate(file_records):
        _object(item, "band or quality mask")
        if "path" not in item:
            raise ValueError("File captures require paths for both bands and the quality mask")
        relative = Path(_text(item["path"], "band path"))
        path = (filename.parent / relative).resolve()
        if relative.is_absolute() or not path.is_relative_to(filename.parent):
            raise ValueError("Band paths must resolve inside the capture manifest directory")
        width, height, values = _image(path, ffmpeg, ffprobe)
        if dimensions is not None and dimensions != (width, height):
            raise ValueError("Bands and quality mask must have identical registered dimensions")
        dimensions = width, height
        scale = 1 if index == 2 else _number(item.get("scale"), "encoded reflectance scale", 1e-15, 1)
        offset = 0 if index == 2 else _number(item.get("offset"), "encoded reflectance offset", -1, 1)
        loaded.append((item, values, scale, offset))
        item["source_file"] = {"name": relative.as_posix(), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                               "encoding_scale": scale, "encoding_offset": offset}
    original_width, original_height = dimensions
    if any(capture.get(key) is not None and capture[key] != value
           for key, value in (("width", original_width), ("height", original_height))):
        raise ValueError("Declared capture dimensions disagree with band files")
    factor = min(1, max_side / max(dimensions))
    width, height = max(1, int(original_width * factor)), max(1, int(original_height * factor))
    locations = [min(original_height - 1, int((y + 0.5) * original_height / height)) * original_width
                 + min(original_width - 1, int((x + 0.5) * original_width / width))
                 for y in range(height) for x in range(width)]
    for index, (item, values, scale, offset) in enumerate(loaded):
        item["values"] = [values[location] if index == 2 else values[location] * scale + offset for location in locations]
        del item["path"]
        item.pop("scale", None)
        item.pop("offset", None)
    capture.update(width=width, height=height, sampling={
        "method": "nearest_neighbor_regular_grid", "original_width": original_width,
        "original_height": original_height, "sample_width": width, "sample_height": height,
        "interpretation": "Statistics describe sampled pixels; small patches may be missed. Not full-resolution bloom area."})
    return request


def export(request, destination):
    """Write a new, atomic report bundle; never overwrite a previous capture."""
    destination = Path(destination)
    if destination.exists():
        raise ValueError("Output directory already exists; choose a new capture directory")
    report = assess_multispectral(request)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".multispectral-", dir=destination.parent) as temporary:
        folder = Path(temporary) / "result"
        folder.mkdir()
        for name, value in (("report.json", report), ("assessment-request.json", request)):
            # The portable request must fit the existing dashboard's bounded JSON
            # import. Pretty-printing 64x64 band arrays wastes that size budget.
            encoded = json.dumps(value, allow_nan=False, separators=(",", ":")) if name == "assessment-request.json" else json.dumps(value, indent=2, allow_nan=False)
            (folder / name).write_text(encoded + "\n", encoding="utf-8")
        if report["status"] == "computed":
            capture = request["multispectral"]
            _, _, indexes = _calculate(capture)
            width, height = capture["width"], capture["height"]
            with (folder / "ndci.csv").open("w", newline="", encoding="utf-8") as stream:
                writer = csv.writer(stream)
                writer.writerow(("x", "y", "red_reflectance", "red_edge_reflectance", "quality_mask", "ndci"))
                for index, value in enumerate(indexes):
                    writer.writerow((index % width, index // width, capture["bands"]["red"]["values"][index],
                                     capture["bands"]["red_edge"]["values"][index], capture["quality_mask"]["values"][index], value))
            header = f"P5\n{width} {height}\n255\n".encode()
            (folder / "ndci.pgm").write_bytes(header + bytes(0 if value is None else max(1, min(255, round(1 + 254 * (value + 1) / 2))) for value in indexes))
            (folder / "valid-mask.pgm").write_bytes(header + bytes(255 if value is not None else 0 for value in indexes))
        folder.rename(destination)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""Capture contract: --example prints a complete, explicitly synthetic request.
For file captures, replace each band's values with path, scale and offset, e.g.
  \"path\": \"red.tif\", \"scale\": 0.0001, \"offset\": 0
Scale/offset decode ALREADY calibrated reflectance, not uncorrected sensor DN.
Replace quality_mask.values with \"path\": \"quality.pgm\" (native integer flags).
Paths are relative to the manifest directory. Bands and mask must already align.
Mask: 0=valid, 1=non-water, 2=glint, 4=shadow, 8=bottom, 16=plants,
      32=saturated, 64=no-data; combine exclusion flags using bitwise OR.
Optional signal_quality: minimum_band_sum + reference for a camera noise cutoff.
File ingestion uses a common regular grid up to 64x64; this is not full-area mapping.
Import exported assessment-request.json in the dashboard's observation panel.
NDCI preview: ndci.pgm maps -1..1 to 1..255; 0 is excluded; ndci.csv is quantitative.
The caller or vendor SDK supplies synchronized capture, radiometric corrections,
surface-reflection correction, band registration and reviewed masks. No specific
camera driver, underwater optical inversion or concentration model is installed.
""")
    parser.add_argument("--example", action="store_true", help="Print an explicitly simulated inline capture request")
    parser.add_argument("--input", type=Path, help="Capture JSON request; bands may have values or relative PGM/TIFF paths")
    parser.add_argument("--output", type=Path, help="New report directory; contains assessment-request.json for dashboard import")
    parser.add_argument("--max-side", type=int, default=64, help="Largest sampled band dimension, 1–64 (file captures only)")
    parser.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or "ffmpeg")
    parser.add_argument("--ffprobe", default=shutil.which("ffprobe") or "ffprobe")
    args = parser.parse_args(argv)
    try:
        if args.example:
            sys.stdout.write(json.dumps(example_request(), indent=2) + "\n")
            return
        if not args.input or not args.output:
            raise ValueError("Provide --input capture.json and --output a-new-directory, or --example")
        request = load_request(args.input, args.max_side, args.ffmpeg, args.ffprobe)
        report = export(request, args.output)
        sys.stdout.write(json.dumps({"status": report["status"], "output": str(args.output),
                                     "ndci": report["result"]["ndci"]}, allow_nan=False) + "\n")
    except (OSError, ValueError, TypeError, KeyError, OverflowError, subprocess.SubprocessError) as error:
        parser.exit(1, f"multispectral: {error}\n")


if __name__ == "__main__":
    main()
