"""Independent geometry oracles and provenance regressions for survey indicators."""

import csv
import json
from pathlib import Path
import tempfile
import unittest

from manta_ray.ecology.metrics import WIDTH, analyze
from manta_ray.ecology.validate import compare_masks, evaluate, read_pgm
from manta_ray.ecology.water import WaterData
from manta_ray.ecology.__main__ import parse_roi


def rgba_patch(coverage, color=(20, 130, 30), landscape=False):
    """Construct a scene with a known column-area fraction, independently of the classifier."""
    pixels = bytearray()
    for y in range(WIDTH):
        for x in range(WIDTH):
            if landscape and not 70 <= y < 250:
                pixels.extend((0, 0, 0, 0))
            elif x < round(WIDTH * coverage):
                pixels.extend((*color, 255))
            else:
                value = 60 if (x // 16 + y // 16) % 2 else 150
                pixels.extend((value, int(value * 0.7), int(value * 0.5), 255))
    return pixels


def pgm(path, pixels):
    path.write_bytes(b"P5\n# independently specified labels\n2 2\n255\n" + bytes(pixels))


class MetricTests(unittest.TestCase):
    def test_analytical_cover_with_landscape_padding(self):
        for coverage in (0, 0.10, 0.25, 0.5, 0.75):
            for landscape in (False, True):
                with self.subTest(coverage=coverage, landscape=landscape):
                    metric, _ = analyze(rgba_patch(coverage, landscape=landscape))
                    self.assertEqual(metric.status, "usable")
                    self.assertAlmostEqual(metric.candidate_green_cover_pct, coverage * 100, places=6)
                    self.assertEqual(metric.valid_pixels, WIDTH * (180 if landscape else WIDTH))

    def test_invalid_size_and_unusable_views(self):
        with self.assertRaises(ValueError):
            analyze(b"")
        for color, expected in (((0, 0, 0, 255), "too_dark"), ((80, 80, 80, 255), "low_contrast")):
            metric, _ = analyze(bytes(color) * WIDTH * WIDTH)
            self.assertEqual(metric.status, expected)
            self.assertIsNone(metric.candidate_green_cover_pct)

    def test_known_color_ambiguity_remains_visible(self):
        # A green plastic patch matches the color rule, a brown plant does not.
        # This regression prevents claiming universal vegetation recognition.
        plastic, _ = analyze(rgba_patch(0.25))
        brown_plant, _ = analyze(rgba_patch(0.25, (95, 65, 30)))
        blue_tinted_plant, _ = analyze(rgba_patch(0.25, (20, 90, 115)))
        self.assertAlmostEqual(plastic.candidate_green_cover_pct, 25)
        self.assertEqual(brown_plant.candidate_green_cover_pct, 0)
        self.assertEqual(blue_tinted_plant.candidate_green_cover_pct, 0)

    def test_roi_rejects_out_of_bounds_and_nonfinite(self):
        self.assertEqual(parse_roi("0.1,0.2,0.5,0.5"), (0.1, 0.2, 0.5, 0.5))
        for value in ("nan,0,1,1", "0,0,0,1", "0.5,0,1,1", "0,0,1"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                # argparse's ArgumentTypeError does not subclass ValueError
                try:
                    parse_roi(value)
                except Exception as error:
                    raise ValueError(str(error)) from error


class WaterTests(unittest.TestCase):
    def make_csv(self, path, rows):
        with path.open("w", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream)
            writer.writerow(("timestamp_s", "tds_ppm", "source", "site_id",
                             "calibration_id", "method", "temperature_c"))
            writer.writerows(rows)

    def test_matched_calibrated_readings_and_simulation_exclusion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sensors = root / "tds.csv"
            self.make_csv(sensors, [
                (0, 100, "measured", "tank", "cal-1", "probe_compensated_25C", 20),
                (1, 999, "simulated", "tank", "", "demo", ""),
                (2, 200, "measured", "tank", "cal-1", "probe_compensated_25C", 20),
            ])
            reference = root / "reference.json"
            reference.write_text(json.dumps({
                "site_id": "tank", "min_ppm": 90, "max_ppm": 110,
                "reference": "controlled test", "context": "tank calibration test only",
                "method": "probe_compensated_25C",
            }))
            water = WaterData(sensors, site_id="tank", baseline_path=reference)
            self.assertEqual(water.summary()["measured"]["median_ppm"], 150)
            self.assertEqual(water.summary()["simulated"]["median_ppm"], 999)
            self.assertIsNone(water.match(3, 0.5))
            self.assertEqual(water.comparison(water.match(0.5, 0.5), "survey"), "within_reference_range")
            self.assertEqual(water.comparison(water.match(2, 0), "survey"), "outside_reference_range")
            self.assertEqual(water.comparison(water.match(1, 0), "survey"), "simulated_excluded")
            self.assertEqual(water.comparison(water.match(0, 0), "stock"), "unverified_video_site")

    def test_uncalibrated_and_wrong_site_never_compare(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tds.csv"
            self.make_csv(path, [(0, 100, "measured", "A", "", "", "")])
            with self.assertRaisesRegex(ValueError, "matching"):
                WaterData(path, site_id="B")
            water = WaterData(path, site_id="A")
            self.assertEqual(water.comparison(water.match(0, 0), "survey"), "calibration_unverified")

    def test_invalid_tds_rows_are_rejected(self):
        for value in ("nan", "inf", "-1", "text"):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "tds.csv"
                self.make_csv(path, [(0, value, "simulated", "", "", "", "")])
                with self.assertRaises(ValueError):
                    WaterData(path)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "tds.csv"
            self.make_csv(path, [(0, 10, "simulated", "", "", "", ""), (0, 20, "simulated", "", "", "", "")])
            with self.assertRaisesRegex(ValueError, "unique"):
                WaterData(path)


class ValidationTests(unittest.TestCase):
    def test_confusion_and_cover_error_independent(self):
        # Same cover can hide a spatial mismatch. All four confusion counts = 1.
        score = compare_masks((2, 2, bytes((255, 255, 0, 0))), (2, 2, bytes((255, 0, 255, 0))))
        self.assertEqual(score["absolute_cover_error_pp"], 0)
        self.assertEqual(score["precision"], 0.5)
        self.assertEqual(score["recall"], 0.5)
        self.assertAlmostEqual(score["iou"], 1 / 3)
        empty = compare_masks((2, 2, bytes(4)), (2, 2, bytes(4)))
        self.assertIsNone(empty["iou"])

    def test_exclusions_cannot_hide_prediction_errors(self):
        with self.assertRaisesRegex(ValueError, "excludes"):
            compare_masks((1, 1, b"\x80"), (1, 1, b"\xff"))
        with self.assertRaisesRegex(ValueError, "no labeled"):
            compare_masks((1, 1, b"\x80"), (1, 1, b"\x80"))

    def test_reference_manifest_and_leakage_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pgm(root / "prediction.pgm", (255, 255, 0, 0))
            pgm(root / "reference.pgm", (255, 0, 255, 0))
            self.assertEqual(read_pgm(root / "reference.pgm")[:2], (2, 2))
            manifest = root / "labels.csv"
            content = ("clip_id,split,prediction,reference,label_source\n"
                       "clip-A,test,prediction.pgm,reference.pgm,independent_geometry\n")
            manifest.write_text(content)
            report = evaluate(manifest)
            self.assertEqual(report["cover_mae_pp"], 0)
            self.assertAlmostEqual(report["pooled_iou"], 1 / 3)
            manifest.write_text(content + "clip-A,train,prediction.pgm,reference.pgm,geometry\n")
            with self.assertRaisesRegex(ValueError, "both train and test"):
                evaluate(manifest)
