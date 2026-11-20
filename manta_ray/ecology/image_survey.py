"""Reviewed image-point cover and video count observations; no lake-health score."""

import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import json
import math
from pathlib import Path
import random
import re
from statistics import mean
import zipfile

from .metrics import WIDTH, write_overlay

POINT_REFERENCE = "https://doi.org/10.1016/j.cageo.2005.11.009"
ANNOTATION_REFERENCE = "https://doi.org/10.1371/journal.pone.0130312"
FISH_REFERENCE = "https://doi.org/10.1071/MF23166"
CLASSES = ("macrophyte", "filamentous_algae", "bare_sediment", "rock",
           "detritus", "other_benthos", "unknown", "not_bottom")
METHODS = ("benthic_point_cover", "video_maxn")
CSV_FIELDS = ("frame_id", "point_id", "timestamp_s", "image", "x_px", "y_px",
              "suggested_label", "label", "reviewer", "sampling_unit", "bottom_confirmed", "source")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _number(value, name, low=0, high=math.inf):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{name} must be a finite number in [{low}, {high}]")
    return value


def _text(value, name):
    if not isinstance(value, str) or not value.strip() or len(value) > 256:
        raise ValueError(f"{name} requires nonempty text of at most 256 characters")
    return value.strip()


def _hash(value, name):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError(f"{name} must be a lowercase SHA-256")
    return value


def _provenance(record, summary):
    source = record.get("source")
    if source not in {"measured", "simulated"}:
        raise ValueError("Annotation source must be measured or simulated")
    _text(record.get("reviewer"), "reviewer")
    _text(record.get("annotation_method"), "annotation_method")
    sha = _hash(record.get("source_sha256"), "source_sha256")
    known = summary.get("source", {}).get("sha256")
    if source == "measured" and known and sha != known:
        raise ValueError("Reviewed observations belong to a different source video")
    return source


def _source_time(timestamp, source, summary):
    if source == "measured":
        duration = summary.get("source", {}).get("metadata", {}).get("format", {}).get("duration")
        if duration is not None and timestamp > float(duration):
            raise ValueError("Reviewed timestamp exceeds the source video duration")


def catalog():
    points = [{"point_id": i, "x_px": i * 20, "y_px": 40, "label": label}
              for i, label in enumerate(("macrophyte", "rock", "unknown"), 1)]
    frame = {"frame_id": "example-1", "timestamp_s": 0, "sampling_unit": "example-transect",
             "source": "simulated", "source_sha256": "0" * 64, "image_sha256": "1" * 64,
             "reviewer": "synthetic example", "annotation_method": "human_point_intercept",
             "bottom_confirmed": True, "quality_status": "usable", "points": points}
    return [
        {"id": "benthic_point_cover", "name": "Reviewed photoquadrat point cover",
         "scope": "Camera-based benthic composition",
         "description": "Estimate macrophyte, visible algae and substrate cover from reviewed random image points. Unknown points remain explicit. This adapts published image-point methods to freshwater; it is not a lake-health index.",
         "required_inputs": ["point_frames with image/source hashes, point labels, reviewer and sampling unit",
                             "Confirmed bottom region and usable image quality"],
         "reference_urls": [POINT_REFERENCE, ANNOTATION_REFERENCE],
         "example": {"method": "benthic_point_cover", "include_simulated": True, "point_frames": [frame]}},
        {"id": "video_maxn", "name": "Reviewed aquatic-life video counts",
         "scope": "Camera-based relative abundance observations",
         "description": "Calculate maximum simultaneous visible count per taxon. Stationary, fully reviewed recordings support MaxN; moving-camera counts stay descriptive. No population size, density or health score is inferred.",
         "required_inputs": ["video_review with source hash, reviewer, taxa, frame counts and review interval",
                             "Camera mode and explicit full-review declaration"],
         "reference_urls": [FISH_REFERENCE],
         "example": {"method": "video_maxn", "include_simulated": True, "video_review": {
             "source": "simulated", "source_sha256": "0" * 64, "reviewer": "synthetic example",
             "annotation_method": "human_video_count", "camera_mode": "stationary", "review_complete": True,
             "start_s": 0, "end_s": 60, "taxa": ["fish_unidentified"],
             "frames": [{"timestamp_s": 0, "counts": {"fish_unidentified": 0}},
                        {"timestamp_s": 30, "counts": {"fish_unidentified": 3}}]}}},
    ]


def _point_cover(request, summary, report):
    frames = request.get("point_frames", [])
    if not isinstance(frames, list) or len(frames) > 1000:
        raise ValueError("point_frames must be an array of at most 1000 reviewed frames")
    identities, times, used, results = set(), set(), [], []
    for frame in frames:
        if not isinstance(frame, dict):
            raise ValueError("Each point frame must be an object")
        identity = _text(frame.get("frame_id"), "frame_id")
        timestamp = _number(frame.get("timestamp_s"), "timestamp_s")
        if identity in identities or timestamp in times:
            raise ValueError("Duplicate frame ID or timestamp")
        identities.add(identity)
        times.add(timestamp)
        source = _provenance(frame, summary)
        _source_time(timestamp, source, summary)
        _hash(frame.get("image_sha256"), "image_sha256")
        unit = _text(frame.get("sampling_unit"), "sampling_unit")
        if not isinstance(frame.get("bottom_confirmed"), bool):
            raise ValueError("bottom_confirmed must be a boolean")
        quality = _text(frame.get("quality_status"), "quality_status")
        points = frame.get("points")
        if not isinstance(points, list) or not 1 <= len(points) <= 1000:
            raise ValueError("Each frame needs 1..1000 reviewed points")
        counts, point_ids, coordinates = Counter(), set(), set()
        for point in points:
            if not isinstance(point, dict):
                raise ValueError("Point labels must be objects")
            point_id = point.get("point_id")
            if isinstance(point_id, bool) or not isinstance(point_id, int) or not 1 <= point_id <= 1000:
                raise ValueError("point_id must be an integer in 1..1000")
            coordinate = (point.get("x_px"), point.get("y_px"))
            if any(isinstance(v, bool) or not isinstance(v, int) or not 0 <= v < WIDTH for v in coordinate):
                raise ValueError("Point coordinates must be integer pixels in the 320x320 review image")
            if point_id in point_ids or coordinate in coordinates:
                raise ValueError("Duplicate point identity or coordinates")
            point_ids.add(point_id)
            coordinates.add(coordinate)
            if point.get("label") not in CLASSES:
                raise ValueError("Each point requires one supported label, including unknown if uncertain")
            counts[point["label"]] += 1
        reason = None
        if source == "simulated" and not request.get("include_simulated", False):
            reason = "simulated annotation excluded"
        elif not frame["bottom_confirmed"] or quality != "usable":
            reason = "bottom unconfirmed or quality rejected"
        if reason:
            report["excluded_inputs"].append({"frame_id": identity, "reason": reason})
            continue
        eligible = len(points) - counts["not_bottom"]
        classified = eligible - counts["unknown"]
        if not eligible:
            report["excluded_inputs"].append({"frame_id": identity, "reason": "no visible-bottom points"})
            continue
        results.append({
            "frame_id": identity, "timestamp_s": timestamp, "sampling_unit": unit,
            "counts": {label: counts[label] for label in CLASSES}, "sampled_points": len(points),
            "eligible_bottom_points": eligible, "classified_points": classified,
            "unknown_pct_of_bottom": 100 * counts["unknown"] / eligible,
            "class_cover_pct_of_classified": {
                label: 100 * counts[label] / classified if classified else None
                for label in CLASSES if label not in {"unknown", "not_bottom"}},
            "macrophyte_cover_pct_classified": 100 * counts["macrophyte"] / classified if classified else None,
            "macrophyte_unknown_bounds_pct": [100 * counts["macrophyte"] / eligible,
                                                100 * (counts["macrophyte"] + counts["unknown"]) / eligible],
        })
        used.append(frame)
    groups = defaultdict(list)
    for result in results:
        groups[result["sampling_unit"]].append(result)
    units = []
    for name, group in sorted(groups.items()):
        scorable = [row["macrophyte_cover_pct_classified"] for row in group if row["macrophyte_cover_pct_classified"] is not None]
        units.append({"sampling_unit": name, "frame_count": len(group),
                      "scorable_frame_count": len(scorable),
                      "macrophyte_cover_pct_classified": mean(scorable) if scorable else None,
                      "unknown_bounds_pct": [mean(row["macrophyte_unknown_bounds_pct"][i] for row in group) for i in (0, 1)]})
    covers = [unit["macrophyte_cover_pct_classified"] for unit in units if unit["macrophyte_cover_pct_classified"] is not None]
    report["result"].update({
        "label": "Reviewed visible-bottom composition", "category": "observations",
        "frame_count": len(results), "sampling_unit_count": len(units),
        "macrophyte_cover_pct_classified": mean(covers) if covers else None,
        "unknown_bounds_pct": [mean(unit["unknown_bounds_pct"][i] for unit in units) for i in (0, 1)] if units else None,
        "confidence_interval": None,
        "confidence_interval_reason": "No inferential interval: declared units and overlapping video views do not establish independent spatial replicates.",
        "aggregation": "Equal frame means within each declared sampling unit, then equal unit means; conditional cover excludes unknown points.",
        "sampling_units": units, "frames": results,
    })
    report["steps"] = [{"name": "Point cover", "equation": "100 * class hits / classified bottom hits"},
                       {"name": "Unknown-label bounds", "equation": "100 * [plant hits, plant hits + unknown hits] / all bottom hits; these are bounds, not confidence intervals"}]
    report["limitations"].extend(["Freshwater adaptation of published benthic image-point methods; not an official lake-condition classification.",
                                  "Classified-point percentages are conditional on successful identification; inspect unknown bounds and excluded views.",
                                  "More vegetation or visible algae does not by itself mean poorer ecological condition.",
                                  "Projected image cover is not biomass, nutrient concentration, or lakewide area. Overlap and unequal footprints require a sampling design."])
    return used


def _video_counts(request, summary, report):
    review = request.get("video_review")
    if review is None:
        return []
    if not isinstance(review, dict):
        raise ValueError("video_review must be an object")
    source = _provenance(review, summary)
    start = _number(review.get("start_s"), "start_s")
    end = _number(review.get("end_s"), "end_s")
    _source_time(end, source, summary)
    if end <= start:
        raise ValueError("Video review end must be after start")
    if review.get("camera_mode") not in {"stationary", "moving", "unknown"} or not isinstance(review.get("review_complete"), bool):
        raise ValueError("Declare camera_mode and boolean review_complete")
    taxa = review.get("taxa")
    if not isinstance(taxa, list) or not 1 <= len(taxa) <= 200:
        raise ValueError("Declare 1..200 taxon labels")
    taxa = [_text(taxon, "taxon label") for taxon in taxa]
    if len(set(taxa)) != len(taxa):
        raise ValueError("Duplicate taxon labels")
    frames = review.get("frames")
    if not isinstance(frames, list) or not 1 <= len(frames) <= 5000:
        raise ValueError("Video review requires 1..5000 timestamped count records")
    maxima, times = dict.fromkeys(taxa, 0), set()
    for frame in frames:
        if not isinstance(frame, dict):
            raise ValueError("Count frames must be objects")
        timestamp = _number(frame.get("timestamp_s"), "timestamp_s", start, end)
        counts = frame.get("counts")
        if timestamp in times or not isinstance(counts, dict) or set(counts) != set(taxa):
            raise ValueError("Each timestamp must be unique and explicitly count every declared taxon, including zeros")
        times.add(timestamp)
        for taxon, count in counts.items():
            if isinstance(count, bool) or not isinstance(count, int) or not 0 <= count <= 100000:
                raise ValueError("Visible counts must be nonnegative integers")
            maxima[taxon] = max(maxima[taxon], count)
    if source == "simulated" and not request.get("include_simulated", False):
        report["excluded_inputs"].append({"reason": "simulated video review excluded"})
        return []
    stationary = review["camera_mode"] == "stationary" and review["review_complete"]
    report["result"].update({
        "label": "Reviewed aquatic-life video observations", "category": "observations",
        "metric": "MaxN" if stationary else "maximum visible count in reviewed frames",
        "maxn_by_taxon": maxima if stationary else None, "maximum_visible_count_by_taxon": maxima,
        "observed_taxon_labels": [taxon for taxon in taxa if maxima[taxon] > 0],
        "unique_individuals": None, "population_size": None, "density_per_m2": None,
        "review_duration_s": end - start, "reviewed_count_frames": len(frames),
        "camera_mode": review["camera_mode"], "full_interval_review_declared": review["review_complete"],
    })
    report["steps"] = [{"name": "Maximum simultaneous count", "equation": "max(visible count at one instant), separately for each declared taxon; never sum counts across frames"}]
    report["limitations"].extend(["MaxN is a relative video count, not total unique fish, population size or calibrated density.",
                                  "Camera movement, field of view, visibility, duration and animal behavior affect comparability.",
                                  "Taxon labels may be coarse groups; their number is not verified species richness.",
                                  "Full-review and taxonomic claims are supplied by the reviewer, not independently verified."])
    return [review]


def assess_images(request, summary, rows, version):
    entry = next(item for item in catalog() if item["id"] == request["method"])
    report = {"schema_version": 1, "engine_version": version, "method_id": entry["id"], "method_name": entry["name"],
              "status": "awaiting_annotations", "data_origin": "none", "scenario": False,
              "result": {"score": None, "category": None, "label": "Reviewed camera observations required", "lake_health": "not_classified"},
              "steps": [], "components": [], "input_summary": {}, "excluded_inputs": [], "missing_inputs": [],
              "assumptions": ["Annotation identities, camera mode, sampling units and reviewer metadata are user declarations; raw imagery and labels must be retained."],
              "limitations": ["No automatic vegetation/species model has been validated on these stock clips."],
              "recommendations": ["Review source-linked observations and validate a trained model on held-out recording sessions before automating labels."],
              "reference_urls": entry["reference_urls"],
              "input_sha256": digest({"request": request, "summary": summary, "rows": rows})}
    used = _point_cover(request, summary, report) if entry["id"] == "benthic_point_cover" else _video_counts(request, summary, report)
    origins = Counter(item["source"] for item in used)
    report["data_origin"] = "mixed" if len(origins) > 1 else next(iter(origins), "none")
    report["scenario"] = "simulated" in origins
    if used:
        report["status"] = "computed"
    else:
        report["missing_inputs"] = entry["required_inputs"]
    if report["scenario"]:
        report["result"]["label"] = "SIMULATION SCENARIO · " + report["result"]["label"]
    report["input_summary"] = {"used_annotation_records": len(used), "origins": dict(origins),
                               "site_id": request.get("site_id"), "declared_context": request.get("context"),
                               "include_simulated": request.get("include_simulated", False)}
    return report


def export_frame(directory, frame, mask, timestamp, index, source_sha, quality, count=50, seed=42):
    """Export untinted imagery and a reproducible sample of eligible image pixels."""
    image = f"review/frame_{index:06d}.png"
    (directory / "review").mkdir(exist_ok=True)
    write_overlay(directory / image, frame, bytes([128]) * len(mask))
    eligible = [pixel for pixel, label in enumerate(mask) if label != 128]
    rng = random.Random(f"{source_sha}:{timestamp:.6f}:{seed}")
    selected = rng.sample(eligible, min(count, len(eligible)))
    return {"frame_id": f"frame_{index:06d}", "timestamp_s": timestamp,
            "image": image, "image_sha256": hashlib.sha256((directory / image).read_bytes()).hexdigest(),
            "source_sha256": source_sha, "quality_status": quality,
            "points": [{"point_id": i, "x_px": pixel % WIDTH, "y_px": pixel // WIDTH,
                        "suggested_label": "green_candidate" if mask[pixel] == 255 else "not_green_candidate"}
                       for i, pixel in enumerate(selected, 1)]}


def finish_export(directory, frames, seed):
    plan = {"schema_version": 1, "method": "uniform_random_eligible_pixels_without_replacement",
            "seed": seed, "analysis_size": [WIDTH, WIDTH], "classes": CLASSES, "frames": frames}
    (directory / "point-plan.json").write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
    resources = Path(__file__).parent
    template = (resources / "review_template.html").read_text(encoding="utf-8")
    (directory / "review.html").write_text(template.replace("__POINT_PLAN_JSON__", json.dumps(plan).replace("<", "\\u003c")), encoding="utf-8")
    (directory / "point_review.js").write_bytes((resources / "point_review.js").read_bytes())
    with (directory / "review-points.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for frame in frames:
            for point in frame["points"]:
                writer.writerow({"frame_id": frame["frame_id"], "timestamp_s": frame["timestamp_s"],
                                 "image": frame["image"], **point})
    with zipfile.ZipFile(directory / "review-bundle.zip", "w") as archive:
        for name in ["point-plan.json", "review-points.csv", "review.html", "point_review.js", *(frame["image"] for frame in frames)]:
            archive.write(directory / name, name)
    return {"status": "awaiting_human_labels", "plan_sha256": digest(plan), "frame_count": len(frames),
            "point_count": sum(len(frame["points"]) for frame in frames),
            "suggestions": "Color-rule hints only; never accepted automatically as biological labels",
            "downloads": ["review-bundle.zip", "point-plan.json", "review-points.csv"]}


def package_review(directory, csv_path):
    directory = directory.resolve()
    plan = json.loads((directory / "point-plan.json").read_text(encoding="utf-8-sig"))
    expected = {}
    for frame in plan["frames"]:
        image = (directory / frame["image"]).resolve()
        if not image.is_relative_to(directory) or not image.is_file() or hashlib.sha256(image.read_bytes()).hexdigest() != frame["image_sha256"]:
            raise ValueError("Review image missing, changed or outside the review directory")
        for point in frame["points"]:
            key = (frame["frame_id"], point["point_id"])
            if key in expected:
                raise ValueError("Duplicate point in plan")
            expected[key] = (frame, point)
    seen, grouped = set(), {}
    if not expected:
        raise ValueError("The plan has no eligible review points")
    with csv_path.open(encoding="utf-8-sig", newline="") as stream:
        for row in csv.DictReader(stream):
            key = (row["frame_id"], int(row["point_id"]))
            if key not in expected or key in seen:
                raise ValueError("CSV contains unknown or duplicate points")
            seen.add(key)
            frame, point = expected[key]
            if (row["image"] != frame["image"] or float(row["timestamp_s"]) != frame["timestamp_s"]
                    or int(row["x_px"]) != point["x_px"] or int(row["y_px"]) != point["y_px"]):
                raise ValueError("Point coordinates, time or image differ from the original plan")
            if row["label"] not in CLASSES or row["bottom_confirmed"] not in {"true", "false"}:
                raise ValueError("Label every planned point; use unknown for ambiguity and declare bottom_confirmed true/false")
            metadata = {"reviewer": row["reviewer"], "sampling_unit": row["sampling_unit"],
                        "source": row["source"], "bottom_confirmed": row["bottom_confirmed"] == "true"}
            record = grouped.setdefault(frame["frame_id"], {
                **{k: frame[k] for k in ("frame_id", "timestamp_s", "source_sha256", "image_sha256", "quality_status")},
                **metadata, "annotation_method": "human_point_intercept", "plan_sha256": digest(plan), "points": []})
            if any(record[k] != v for k, v in metadata.items()):
                raise ValueError("Frame review metadata must agree across all its points")
            record["points"].append({k: point[k] for k in ("point_id", "x_px", "y_px")} | {"label": row["label"]})
    if seen != set(expected):
        raise ValueError("CSV must retain every planned point, including unknown labels")
    request = {"method": "benthic_point_cover", "include_simulated": False, "point_frames": list(grouped.values())}
    # Validate the package while retaining simulated labels for an explicit later opt-in.
    assess_images({**request, "include_simulated": True}, {}, [], "package-validation")
    return {"request": request}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review-dir", type=Path, required=True)
    parser.add_argument("--labels", type=Path, required=True, help="Completed review-points.csv")
    parser.add_argument("--output", type=Path, required=True, help="New assessment-envelope JSON")
    args = parser.parse_args(argv)
    try:
        result = package_review(args.review_dir, args.labels)
        with args.output.open("x", encoding="utf-8") as stream:
            json.dump(result, stream, indent=2, allow_nan=False)
            stream.write("\n")
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"image-survey: {error}\n")


if __name__ == "__main__":
    main()
