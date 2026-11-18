"""Evaluate predicted masks against independently annotated reference masks."""

import argparse
import csv
import hashlib
import json
from pathlib import Path
from statistics import mean


def read_pgm(path):
    data = path.read_bytes()
    offset = 0

    def token():
        nonlocal offset
        while offset < len(data):
            if data[offset:offset + 1] == b"#":
                end = data.find(b"\n", offset)
                if end < 0:
                    raise ValueError(f"Incomplete PGM comment: {path}")
                offset = end + 1
            elif data[offset:offset + 1].isspace():
                offset += 1
            else:
                break
        start = offset
        while offset < len(data) and not data[offset:offset + 1].isspace():
            offset += 1
        return data[start:offset]

    if token() != b"P5":
        raise ValueError(f"Expected a binary P5 PGM: {path}")
    width, height, maximum = int(token()), int(token()), int(token())
    if maximum != 255 or min(width, height) < 1:
        raise ValueError(f"Expected positive PGM dimensions and maximum 255: {path}")
    if offset >= len(data) or not data[offset:offset + 1].isspace():
        raise ValueError(f"Missing PGM header separator: {path}")
    offset += 2 if data[offset:offset + 2] == b"\r\n" else 1
    pixels = data[offset:]
    if len(pixels) != width * height or not set(pixels) <= {0, 128, 255}:
        raise ValueError(f"PGM must contain exactly width*height pixels in {{0,128,255}}: {path}")
    return width, height, pixels


def compare_masks(prediction, reference):
    if prediction[:2] != reference[:2]:
        raise ValueError("Prediction and reference mask dimensions must match")
    tp = fp = fn = tn = 0
    for predicted, actual in zip(prediction[2], reference[2]):
        if actual == 128:
            continue
        if predicted == 128:
            raise ValueError("Prediction excludes a labeled reference pixel")
        tp += predicted == 255 and actual == 255
        fp += predicted == 255 and actual == 0
        fn += predicted == 0 and actual == 255
        tn += predicted == 0 and actual == 0
    valid = tp + fp + fn + tn
    if not valid:
        raise ValueError("Reference mask has no labeled pixels")
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn, "labeled_pixels": valid,
        "precision": tp / (tp + fp) if tp + fp else None,
        "recall": tp / (tp + fn) if tp + fn else None,
        "iou": tp / (tp + fp + fn) if tp + fp + fn else None,
        "predicted_cover_pct": 100 * (tp + fp) / valid,
        "reference_cover_pct": 100 * (tp + fn) / valid,
        "signed_cover_error_pp": 100 * (fp - fn) / valid,
        "absolute_cover_error_pp": 100 * abs(fp - fn) / valid,
    }


def evaluate(manifest):
    with manifest.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        required = {"clip_id", "split", "prediction", "reference", "label_source"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError(f"Annotation CSV requires columns {sorted(required)}")
        entries = list(reader)
    clips = {}
    seen = set()
    rows = []
    for entry in entries:
        if any(entry.get(field) is None or not entry[field].strip() for field in required):
            raise ValueError("Annotation rows require every field to be populated")
        split = entry["split"]
        if split not in {"train", "test"}:
            raise ValueError("Split must be train or test")
        clip = entry["clip_id"]
        if clip in clips and clips[clip] != split:
            raise ValueError("The same clip cannot occur in both train and test splits")
        clips[clip] = split
        if split != "test":
            continue
        prediction_path = (manifest.parent / entry["prediction"]).resolve()
        reference_path = (manifest.parent / entry["reference"]).resolve()
        if prediction_path in seen or prediction_path == reference_path:
            raise ValueError("Duplicate prediction or prediction reused as its own reference")
        seen.add(prediction_path)
        result = compare_masks(read_pgm(prediction_path), read_pgm(reference_path))
        rows.append({**entry, **result,
                     "prediction_sha256": hashlib.sha256(prediction_path.read_bytes()).hexdigest(),
                     "reference_sha256": hashlib.sha256(reference_path.read_bytes()).hexdigest()})
    if not rows:
        raise ValueError("At least one held-out test example is required")
    total = {key: sum(row[key] for row in rows) for key in ("tp", "fp", "fn", "tn")}
    tp, fp, fn = total["tp"], total["fp"], total["fn"]
    return {
        "schema_version": 1, "test_frames": len(rows),
        "test_clips": len({row["clip_id"] for row in rows}),
        "cover_mae_pp": mean(row["absolute_cover_error_pp"] for row in rows),
        "cover_bias_pp": mean(row["signed_cover_error_pp"] for row in rows),
        "pooled_precision": tp / (tp + fp) if tp + fp else None,
        "pooled_recall": tp / (tp + fn) if tp + fn else None,
        "pooled_iou": tp / (tp + fp + fn) if tp + fp + fn else None,
        "confusion": total, "frames": rows,
        "limitations": ["Reference accuracy depends on annotation quality.",
                        "Frames within a clip can be correlated.",
                        "Coverage agreement alone cannot establish mask accuracy."],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("annotations", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        report = evaluate(args.annotations)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2, allow_nan=False)
            stream.write("\n")
        print(args.output)
    except (OSError, ValueError) as error:
        parser.exit(1, f"validate: {error}\n")


if __name__ == "__main__":
    main()
