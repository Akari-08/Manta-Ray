"""Research-observation contracts, including ambiguity and real export/review handoff."""

import copy
import csv
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

from manta_ray.ecology.assessment import assess, catalog
from manta_ray.ecology.image_survey import CLASSES, export_frame, finish_export, package_review
from manta_ray.ecology.metrics import WIDTH


def point_frame(labels=("macrophyte", "rock", "unknown"), frame_id="A", timestamp=0, unit="transect-A", source="measured"):
    return {"frame_id": frame_id, "timestamp_s": timestamp, "sampling_unit": unit,
            "source": source, "source_sha256": "a" * 64, "image_sha256": "b" * 64,
            "reviewer": "independent reviewer", "annotation_method": "human_point_intercept",
            "bottom_confirmed": True, "quality_status": "usable",
            "points": [{"point_id": i + 1, "x_px": i, "y_px": 10, "label": label} for i, label in enumerate(labels)]}


class ImageObservationTests(unittest.TestCase):
    def test_catalog_uses_camera_methods_and_archives_sensor_indices(self):
        self.assertEqual({item["id"] for item in catalog()}, {"benthic_point_cover", "video_maxn", "multispectral_ndci", "camera_tds"})
        self.assertTrue(all(item["legacy"] for item in catalog(include_legacy=True) if item["id"] in {"ccme_wqi", "carlson_tsi"}))

    def test_point_denominator_unknown_bounds_and_no_health_score(self):
        report = assess({"method": "benthic_point_cover", "point_frames": [point_frame()]})
        self.assertEqual(report["status"], "computed")
        result = report["result"]
        self.assertEqual(result["macrophyte_cover_pct_classified"], 50)
        self.assertAlmostEqual(result["unknown_bounds_pct"][0], 100 / 3)
        self.assertAlmostEqual(result["unknown_bounds_pct"][1], 200 / 3)
        self.assertIsNone(result["score"])
        self.assertEqual(result["lake_health"], "not_classified")
        self.assertIsNone(result["confidence_interval"])

    def test_all_unknown_is_missing_cover_and_not_zero(self):
        result = assess({"method": "benthic_point_cover", "point_frames": [point_frame(("unknown", "unknown"))]})["result"]
        self.assertIsNone(result["macrophyte_cover_pct_classified"])
        self.assertEqual(result["unknown_bounds_pct"], [0, 100])
        zero = assess({"method": "benthic_point_cover", "point_frames": [point_frame(("rock",))]})
        self.assertEqual(zero["result"]["macrophyte_cover_pct_classified"], 0)

    def test_units_are_equal_weighted_and_frames_are_not_independent_replicates(self):
        frames = [point_frame(("macrophyte",), "A", 0, "unit-1"),
                  point_frame(("rock",), "B", 1, "unit-1"),
                  point_frame(("macrophyte",), "C", 2, "unit-2")]
        result = assess({"method": "benthic_point_cover", "point_frames": frames})["result"]
        self.assertEqual(result["sampling_unit_count"], 2)
        self.assertEqual(result["macrophyte_cover_pct_classified"], 75)
        self.assertEqual(result["frame_count"], 3)

    def test_source_mismatch_rejected_and_exclusions_remain_audited(self):
        request = {"method": "benthic_point_cover", "point_frames": [point_frame()]}
        with self.assertRaisesRegex(ValueError, "different source"):
            assess(request, {"source": {"sha256": "c" * 64}})
        for field, value in (("bottom_confirmed", False), ("quality_status", "too_dark"), ("source", "simulated")):
            changed = copy.deepcopy(request)
            changed["point_frames"][0][field] = value
            report = assess(changed)
            self.assertEqual(report["status"], "awaiting_annotations")
            self.assertEqual(len(report["excluded_inputs"]), 1)
            self.assertIsNone(report["result"]["macrophyte_cover_pct_classified"])

    def test_duplicate_unlabeled_and_nonfinite_points_are_rejected(self):
        for edit in (lambda frame: frame["points"].append(frame["points"][0]),
                     lambda frame: frame["points"][0].update(label=""),
                     lambda frame: frame["points"][0].update(x_px=True),
                     lambda frame: frame.update(timestamp_s=float("nan")),
                     lambda frame: frame.update(bottom_confirmed="true")):
            frame = point_frame()
            edit(frame)
            with self.assertRaises(ValueError):
                assess({"method": "benthic_point_cover", "point_frames": [frame]})

    def test_review_times_must_fit_the_verified_source_duration(self):
        frame = point_frame(timestamp=2)
        with self.assertRaisesRegex(ValueError, "duration"):
            assess({"method": "benthic_point_cover", "point_frames": [frame]},
                   {"source": {"sha256": "a" * 64, "metadata": {"format": {"duration": "1"}}}})

    def test_simulated_tds_cannot_change_biological_observations(self):
        request = {"method": "benthic_point_cover", "point_frames": [point_frame()]}
        measured = assess(request)
        simulated = assess({**request, "include_simulated": True, "simulate_tds": {"seed": 42, "baseline_ppm": 900, "variation_ppm": 100}})
        self.assertEqual(measured["result"], simulated["result"])
        self.assertFalse(simulated["scenario"])
        self.assertTrue(simulated["supporting_observations"]["scenario"])
        self.assertFalse(simulated["supporting_observations"]["chemistry_affects_biological_metrics"])
        self.assertTrue(simulated["generated_tds"])
        self.assertEqual(assess(request), measured)

    def test_maxn_uses_simultaneous_counts_not_sum_and_preserves_zero(self):
        request = next(item["example"] for item in catalog() if item["id"] == "video_maxn")
        request = copy.deepcopy(request)
        review = request["video_review"]
        review["taxa"].append("unidentified_invertebrate")
        for frame in review["frames"]:
            frame["counts"]["unidentified_invertebrate"] = 0
        review["frames"].append({"timestamp_s": 40, "counts": {"fish_unidentified": 2, "unidentified_invertebrate": 0}})
        report = assess(request)
        self.assertEqual(report["result"]["maxn_by_taxon"], {"fish_unidentified": 3, "unidentified_invertebrate": 0})
        self.assertIsNone(report["result"]["unique_individuals"])
        self.assertIsNone(report["result"]["density_per_m2"])
        for field, value in (("camera_mode", "moving"), ("review_complete", False)):
            changed = copy.deepcopy(request)
            changed["video_review"][field] = value
            result = assess(changed)["result"]
            self.assertIsNone(result["maxn_by_taxon"])
            self.assertEqual(result["maximum_visible_count_by_taxon"]["fish_unidentified"], 3)

    def test_video_review_rejects_implicit_zeros_and_invalid_effort(self):
        request = next(item["example"] for item in catalog() if item["id"] == "video_maxn")
        for edit in (lambda review: review["frames"][0].update(counts={}),
                     lambda review: review["frames"][0]["counts"].update(fish_unidentified=True),
                     lambda review: review.update(end_s=0),
                     lambda review: review["frames"].append(review["frames"][0])):
            changed = copy.deepcopy(request)
            edit(changed["video_review"])
            with self.assertRaises(ValueError):
                assess(changed)


class PointReviewWorkflowTests(unittest.TestCase):
    def test_export_package_enforces_plan_identity_complete_review_and_raw_image(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            frame = bytes((30, 100, 20, 255)) * (WIDTH * WIDTH)
            mask = bytearray([128]) * (WIDTH * WIDTH)
            for y in range(80, 240):
                for x in range(WIDTH):
                    mask[y * WIDTH + x] = 255
            exported = export_frame(root, frame, mask, 0, 0, "a" * 64, "usable", 50, 42)
            repeat = export_frame(root, frame, mask, 0, 1, "a" * 64, "usable", 50, 42)
            self.assertEqual(exported["points"], repeat["points"])
            self.assertTrue(all(80 <= point["y_px"] < 240 for point in exported["points"]))
            workflow = finish_export(root, [exported], 42)
            self.assertEqual(workflow["point_count"], 50)
            with zipfile.ZipFile(root / "review-bundle.zip") as archive:
                self.assertEqual(set(archive.namelist()), {"point-plan.json", "review-points.csv", "review.html", "point_review.js", exported["image"]})
            labels = root / "review-points.csv"
            with labels.open(newline="", encoding="utf-8") as stream:
                rows = list(csv.DictReader(stream))
            self.assertTrue(all(not row["label"] for row in rows))
            with self.assertRaises(ValueError):
                package_review(root, labels)
            for i, row in enumerate(rows):
                row.update(label="macrophyte" if i < 10 else "rock", reviewer="human reviewer",
                           sampling_unit="tank-quadrat-1", bottom_confirmed="true", source="measured")
            def save(items):
                with labels.open("w", encoding="utf-8", newline="") as stream:
                    writer = csv.DictWriter(stream, fieldnames=rows[0])
                    writer.writeheader()
                    writer.writerows(items)
            save(rows)
            envelope = package_review(root, labels)
            result = assess(envelope["request"])
            self.assertEqual(result["result"]["macrophyte_cover_pct_classified"], 20)
            save(rows[:-1])
            with self.assertRaisesRegex(ValueError, "retain every"):
                package_review(root, labels)
            rows[0]["x_px"] = str((int(rows[0]["x_px"]) + 1) % WIDTH)
            save(rows)
            with self.assertRaisesRegex(ValueError, "coordinates"):
                package_review(root, labels)
            (root / exported["image"]).write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "image missing, changed"):
                package_review(root, labels)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required")
    def test_actual_video_cli_exports_review_bundle_and_defaults_to_camera_method(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clip = root / "fixture.mkv"
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                            "testsrc2=duration=1:size=128x96:rate=2", "-c:v", "ffv1", str(clip)], check=True, capture_output=True)
            output = root / "survey"
            result = subprocess.run([sys.executable, "-m", "manta_ray.ecology", str(clip), "--output", str(output),
                                     "--video-source", "synthetic", "--interval", "0.5", "--export-review", "--max-samples", "2"],
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            summary = json.loads((output / "summary.json").read_text())
            self.assertEqual(summary["ecological_assessment"]["method_id"], "benthic_point_cover")
            self.assertEqual(summary["ecological_assessment"]["status"], "awaiting_annotations")
            self.assertEqual(summary["review_workflow"]["point_count"], 100)
            self.assertTrue((output / "review-bundle.zip").is_file())
            self.assertIsNone(summary["imagery"]["vegetation_cover_pct"])


if __name__ == "__main__":
    unittest.main()
