"""Measure survey imagery and align provenance-labeled TDS observations."""

import argparse
from collections import Counter
import csv
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shutil
from statistics import median
import subprocess
import tempfile
import time

from .metrics import FRAME_BYTES, WIDTH, analyze, numeric_fields, write_mask, write_overlay
from .water import WaterData, finite_number
from .assessment import assess, catalog

FIELDS = (
    "timestamp_s", "status", "candidate_green_cover_pct", "vegetation_cover_pct",
    "valid_pixels", "median_luma", "contrast_p90_p10", "dark_pixel_pct",
    "clipped_pixel_pct", "mean_gradient", "tds_ppm", "tds_source",
    "tds_sample_timestamp_s", "tds_time_offset_s", "tds_comparison",
    "tds_calibration_id", "tds_method", "tds_temperature_c",
    "simulated_tds_ppm", "overlay", "mask",
)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def parse_roi(text):
    try:
        x, y, width, height = map(float, text.split(","))
    except ValueError as error:
        raise argparse.ArgumentTypeError("ROI must be x,y,width,height in normalized coordinates") from error
    if (not all(math.isfinite(value) for value in (x, y, width, height))
            or min(x, y) < 0 or min(width, height) <= 0
            or x + width > 1 or y + height > 1):
        raise argparse.ArgumentTypeError("ROI must be a positive rectangle within [0,1]")
    return x, y, width, height


def run(args):
    started = time.monotonic()
    source = args.video.resolve()
    destination = args.output.resolve()
    if not source.is_file():
        raise ValueError(f"Input video does not exist: {source}")
    if destination.exists():
        raise ValueError(f"Output already exists; choose a new directory: {destination}")
    assessment_request = {}
    if args.assessment_input:
        assessment_request = json.loads(args.assessment_input.read_text(encoding="utf-8-sig"))
        if not isinstance(assessment_request, dict):
            raise ValueError("Assessment input must be a JSON object")
    assessment_request.setdefault("method", args.assessment_method or "camera_tds")
    if args.assessment_method:
        assessment_request["method"] = args.assessment_method
    if args.include_simulated_assessment:
        assessment_request["include_simulated"] = True
    if assessment_request["method"] not in {method["id"] for method in catalog()}:
        raise ValueError("Unknown assessment method")
    ffmpeg = shutil.which(args.ffmpeg)
    ffprobe = shutil.which(args.ffprobe)
    if not ffmpeg or not ffprobe:
        raise ValueError("FFmpeg and FFprobe are required; use --ffmpeg and --ffprobe for installed paths.")
    water = WaterData(args.tds_csv, args.tds_ppm, args.site_id, args.tds_reference,
                      simulated_variation_ppm=args.simulated_tds_variation,
                      simulated_seed=args.simulated_tds_seed)
    probe = subprocess.run([
        ffprobe, "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,width,height,avg_frame_rate,duration,color_space,color_transfer,color_primaries:format=duration",
        "-of", "json", str(source),
    ], capture_output=True, text=True, check=False)
    if probe.returncode:
        raise ValueError(f"FFmpeg could not decode the video metadata: {probe.stderr.strip()}")
    metadata = json.loads(probe.stdout)
    if not metadata.get("streams"):
        raise ValueError("Input has no video stream")
    duration_value = metadata.get("format", {}).get("duration") or metadata["streams"][0].get("duration")
    known_duration = None
    if duration_value is not None:
        try:
            known_duration = finite_number(duration_value, "video duration")
        except ValueError:
            pass
    if known_duration is not None and args.start >= known_duration:
        raise ValueError("--start is beyond the video duration")
    version = subprocess.run([ffmpeg, "-version"], capture_output=True, text=True, check=True).stdout.splitlines()[0]
    source_hash = file_hash(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent, prefix=".ecology-") as temporary:
        result = Path(temporary) / "result"
        result.mkdir()
        (result / "overlays").mkdir()
        (result / "masks").mkdir()
        # Resampling uses a defined sample grid. Sample times are relative to the
        # original clip, distinct from timestamps of any TDS readings joined to them.
        filters = []
        fallback = {}
        video_stream = metadata["streams"][0]
        for tag, parameter in (("color_space", "colorspace"), ("color_transfer", "color_trc"),
                               ("color_primaries", "color_primaries")):
            if video_stream.get(tag) == "reserved":
                fallback[parameter] = "bt709"
        if fallback:
            filters.append("setparams=" + ":".join(f"{key}={value}" for key, value in fallback.items()))
        filters.append(f"fps={1 / args.interval:.12g}:start_time=0:round=up")
        if args.roi is not None:
            x, y, width, height = args.roi
            filters.append(f"crop=iw*{width}:ih*{height}:iw*{x}:ih*{y}")
        filters.extend([
            f"scale={WIDTH}:{WIDTH}:force_original_aspect_ratio=decrease",
            "format=rgb24", "format=rgba",
            f"pad={WIDTH}:{WIDTH}:(ow-iw)/2:(oh-ih)/2:black@0",
        ])
        duration = ["-t", str(args.duration)] if args.duration else []
        command = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin",
            "-threads", "1", "-filter_threads", "1",
            "-ss", str(args.start), "-i", str(source), *duration,
            "-map", "0:v:0", "-vf", ",".join(filters),
            "-frames:v", str(args.max_samples), "-c:v", "rawvideo",
            "-pix_fmt", "rgba", "-threads", "1", "-f", "rawvideo", "pipe:1",
        ]
        statuses = Counter()
        comparisons = Counter()
        matched_readings = {}
        covers = []
        count = 0
        with (
            tempfile.TemporaryFile() as errors,
            (result / "survey.csv").open("w", encoding="utf-8", newline="") as stream,
            subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors) as decoder,
        ):
            writer = csv.DictWriter(stream, fieldnames=FIELDS)
            writer.writeheader()
            try:
                while frame := decoder.stdout.read(FRAME_BYTES):
                    if len(frame) != FRAME_BYTES:
                        raise ValueError("FFmpeg returned an incomplete video frame.")
                    timestamp = args.start + count * args.interval
                    metrics, mask = analyze(
                        frame, args.min_brightness, args.min_contrast,
                        args.green_excess, args.min_saturation,
                    )
                    statuses[metrics.status] += 1
                    overlay = ""
                    mask_path = f"masks/frame_{count:06d}.pgm"
                    write_mask(result / mask_path, mask)
                    if metrics.candidate_green_cover_pct is not None:
                        if len(covers) % args.overlay_every == 0:
                            overlay = f"overlays/frame_{count:06d}.png"
                            write_overlay(result / overlay, frame, mask)
                        covers.append(metrics.candidate_green_cover_pct)
                    reading = water.match(timestamp, args.tds_tolerance)
                    if reading is not None and reading.source == "measured":
                        matched_readings[reading.timestamp_s] = reading.tds_ppm
                    comparison = water.comparison(reading, args.video_source)
                    comparisons[comparison] += 1
                    writer.writerow({
                        **numeric_fields(metrics), "timestamp_s": f"{timestamp:.6f}",
                        "vegetation_cover_pct": "",
                        "tds_ppm": reading.tds_ppm if reading else "",
                        "tds_source": reading.source if reading else "missing",
                        "tds_sample_timestamp_s": reading.timestamp_s if reading else "",
                        "tds_time_offset_s": round(reading.timestamp_s - timestamp, 6) if reading else "",
                        "tds_comparison": comparison,
                        "tds_calibration_id": reading.calibration_id if reading else "",
                        "tds_method": reading.method if reading else "",
                        "tds_temperature_c": reading.temperature_c if reading else "",
                        "simulated_tds_ppm": reading.tds_ppm if reading and reading.source == "simulated" else "",
                        "overlay": overlay, "mask": mask_path,
                    })
                    count += 1
                if decoder.wait():
                    errors.seek(0)
                    message = errors.read().decode("utf-8", errors="replace").strip()
                    raise ValueError(f"FFmpeg could not decode the video: {message}")
            finally:
                if decoder.poll() is None:
                    decoder.kill()
        if count == 0:
            raise ValueError("No video frames were sampled.")
        summary = {
            "schema_version": 3, "created_utc": datetime.now(timezone.utc).isoformat(),
            "source": {"name": source.name, "sha256": source_hash, "type": args.video_source,
                       "site_id": args.site_id or None, "metadata": metadata},
            "method": {
                "name": "green_excess_rgb_v1", "analysis_size": [WIDTH, WIDTH],
                "roi_normalized": args.roi, "roi_confirmed_bottom": args.confirm_bottom_roi,
                "minimum_brightness": args.min_brightness, "minimum_contrast": args.min_contrast,
                "green_excess": args.green_excess, "minimum_saturation": args.min_saturation,
                "interval_s": args.interval, "start_s": args.start, "duration_s": args.duration,
                "maximum_samples": args.max_samples, "tds_tolerance_s": args.tds_tolerance,
                "ffmpeg_version": version, "command": command,
                "reserved_color_metadata_fallback": fallback,
            },
            "imagery": {"sample_count": count, "status_counts": dict(statuses),
                        "usable_view_pct": 100 * len(covers) / count,
                        "candidate_cover_median_pct": median(covers) if covers else None,
                        "candidate_cover_min_pct": min(covers) if covers else None,
                        "candidate_cover_max_pct": max(covers) if covers else None,
                        "vegetation_cover_pct": None, "ground_truth": "unavailable",
                        "aggregation": "descriptive sampled views; repeated areas may overlap"},
            "water": {"input_dataset_summary": water.summary(),
                      "unique_matched_measured_samples": len(matched_readings),
                      "matched_measured_median_ppm": median(matched_readings.values()) if matched_readings else None,
                      "matched_view_comparison_counts": dict(comparisons),
                      "reference_comparison": "user-supplied site range screening; ecological significance unverified",
                      "calibration": "metadata recorded as supplied; calibration accuracy unverified",
                      "units": "input ppm retained; approximately mg/L only for dilute freshwater"},
            "aquatic_life": {
                "status": "not_assessed", "detections": None, "unique_individuals": None,
                "identified_taxa": None,
                "reason": "Organism detection, tracking and species identification are not implemented or validated.",
            },
            "assessment": {
                "lake_health": "insufficient_evidence",
                "trophic_state": "not_assessed",
                "missing_indicators": ["total_phosphorus", "chlorophyll_a", "Secchi_depth",
                                       "dissolved_oxygen_profile", "species_and_reference_site_data"],
                "interpretation": [
                    "Candidate green cover is an image-domain screening metric requiring independent labels.",
                    "Brightness, contrast, clipping and gradient describe imagery quality.",
                    "Simulated TDS is excluded from environmental interpretation.",
                    "TDS reference comparisons flag departures for investigation.",
                    "View summaries cannot establish whole-lake coverage or nutrient removal.",
                ],
            },
            "runtime_seconds": round(time.monotonic() - started, 3),
        }
        for name, path in (("tds_csv", args.tds_csv), ("tds_reference", args.tds_reference)):
            if path:
                summary["source"][name] = {"name": path.name, "sha256": file_hash(path)}
        with (result / "survey.csv").open(encoding="utf-8", newline="") as stream:
            observations = list(csv.DictReader(stream))
        ecological_assessment = assess(assessment_request, summary, observations)
        summary["ecological_assessment"] = ecological_assessment
        (result / "assessment.json").write_text(
            json.dumps(ecological_assessment, indent=2, allow_nan=False) + "\n", encoding="utf-8"
        )
        (result / "summary.json").write_text(json.dumps(summary, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        (result / "report.md").write_text(
            f"# Survey observations\n\nSource: {source.name}\n\n"
            f"Sampled {count} views. Usable views: {100 * len(covers) / count:.1f}%.\n\n"
            f"Median candidate green cover in usable views: {median(covers) if covers else 'unavailable'}.\n\n"
            "Lake health assessment: insufficient evidence.\n\n"
            "The CSV contains image quality measurements and provenance-labeled TDS observations. "
            "Vegetation cover requires independent reference labels. "
            "See summary.json for the method, provenance, missing indicators and interpretation.\n",
            encoding="utf-8",
        )
        with (result / "report.md").open("a", encoding="utf-8") as stream:
            stream.write(
                f"\n## Selected assessment\n\n{ecological_assessment['method_name']}\n\n"
                f"Status: {ecological_assessment['status']}\n\n"
                f"Result: {ecological_assessment['result']['label']}\n\n"
                "The complete calculation, inputs, limitations and sources are retained in assessment.json.\n"
            )
        result.rename(destination)
    print(f"Analyzed {count} views ({len(covers)} usable). Results: {destination / 'summary.json'}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path)
    parser.add_argument("--output", type=Path, default=Path("outputs/ecology"))
    parser.add_argument("--interval", type=float, default=1.0)
    parser.add_argument("--start", type=float, default=0)
    parser.add_argument("--duration", type=float)
    parser.add_argument("--max-samples", type=int, default=3600)
    parser.add_argument("--overlay-every", type=int, default=5)
    parser.add_argument("--roi", type=parse_roi, help="Normalized x,y,width,height of the analysis region")
    parser.add_argument("--confirm-bottom-roi", action="store_true", help="Record operator confirmation that ROI shows lakebed")
    parser.add_argument("--video-source", choices=("unknown", "stock", "survey", "synthetic"), default="unknown")
    parser.add_argument("--site-id", default="")
    parser.add_argument("--assessment-method", choices=("camera_tds", "carlson_tsi", "ccme_wqi"))
    parser.add_argument("--assessment-input", type=Path, help="JSON measurements and assessment settings")
    parser.add_argument("--include-simulated-assessment", action="store_true", help="Enable explicitly labeled scenario calculations")
    tds = parser.add_mutually_exclusive_group()
    tds.add_argument("--simulated-tds-ppm", "--tds-ppm", dest="tds_ppm", type=float)
    tds.add_argument("--tds-csv", type=Path)
    parser.add_argument("--simulated-tds-variation", type=float, default=10,
                        help="Maximum departure from the simulated TDS baseline in ppm")
    parser.add_argument("--simulated-tds-seed", type=int, default=42,
                        help="Seed identifying the repeatable simulated TDS time profile")
    parser.add_argument("--tds-reference", type=Path)
    parser.add_argument("--tds-tolerance", type=float, default=0.5)
    parser.add_argument("--min-brightness", type=int, default=24)
    parser.add_argument("--min-contrast", type=int, default=18)
    parser.add_argument("--green-excess", type=int, default=12)
    parser.add_argument("--min-saturation", type=float, default=0.20)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    args = parser.parse_args(argv)
    try:
        finite_number(args.interval, "--interval", 0.001)
        finite_number(args.start, "--start")
        finite_number(args.tds_tolerance, "--tds-tolerance")
        if args.duration is not None:
            finite_number(args.duration, "--duration", 0.001)
        if args.tds_ppm is not None:
            finite_number(args.tds_ppm, "--simulated-tds-ppm")
        finite_number(args.simulated_tds_variation, "--simulated-tds-variation")
        if not 0 <= args.simulated_tds_seed <= 4294967295:
            raise ValueError("--simulated-tds-seed must be between 0 and 4294967295")
        if args.overlay_every < 1 or args.max_samples < 1:
            raise ValueError("--overlay-every and --max-samples must be positive")
        if not 0 <= args.min_saturation <= 1 or not 1 <= args.green_excess <= 255:
            raise ValueError("Saturation must be in [0,1] and green excess in [1,255]")
        if not all(0 <= value <= 255 for value in (args.min_brightness, args.min_contrast)):
            raise ValueError("Brightness and contrast thresholds must be between 0 and 255")
        if args.confirm_bottom_roi and args.roi is None:
            raise ValueError("--confirm-bottom-roi requires --roi")
        if args.tds_reference and not args.tds_csv:
            raise ValueError("--tds-reference requires --tds-csv")
        run(args)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        parser.exit(1, f"ecology: {error}\n")


if __name__ == "__main__":
    main()
