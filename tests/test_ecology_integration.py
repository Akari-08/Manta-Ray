"""Exercise the ecology CLI through actual FFmpeg encoding and decoding."""

import csv
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "requires installed FFmpeg")
class EcologyIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory(prefix="manta-ecology-regression-")
        cls.addClassCleanup(cls.workspace.cleanup)
        cls.root = Path(cls.workspace.name)
        cls.clip = cls.root / "synthetic.mkv"
        subprocess.run([
            shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "lavfi", "-i",
            "color=c=gray:s=160x120:r=4:d=4,drawbox=x=0:y=0:w=80:h=120:color=green:t=fill",
            "-c:v", "ffv1", str(cls.clip),
        ], check=True, capture_output=True)

    def setUp(self):
        self.local = Path(tempfile.mkdtemp(dir=self.root))
        self.sensor = self.local / "tds.csv"
        self.sensor.write_text(
            "timestamp_s,tds_ppm,source,site_id,calibration_id,method,temperature_c\n"
            "0.1,100,measured,lake-a,cal-1,conductivity,18\n"
            "1,999,simulated,lake-a,,constant_demo,\n"
            "2,300,measured,lake-a,cal-2,gravimetric,19\n"
            "100,450,measured,lake-a,cal-3,conductivity,20\n",
            encoding="utf-8",
        )
        self.reference = self.local / "reference.json"
        self.reference.write_text(json.dumps({
            "site_id": "lake-a", "reference": "test fixture reference",
            "context": "synthetic regression fixture", "method": "conductivity",
            "min_ppm": 50, "max_ppm": 150,
        }), encoding="utf-8")

    def run_cli(self, output_name, *options, success=True):
        output = self.local / output_name
        process = subprocess.run([
            sys.executable, "-m", "manta_ray.ecology", str(self.clip),
            "--output", str(output), "--max-samples", "4",
            "--min-contrast", "0", *options,
        ], cwd=Path(__file__).resolve().parents[1], text=True, capture_output=True, timeout=30)
        if success:
            self.assertEqual(process.returncode, 0, process.stderr)
            with (output / "survey.csv").open(newline="", encoding="utf-8") as stream:
                rows = list(csv.DictReader(stream))
            summary = json.loads((output / "summary.json").read_text(encoding="utf-8"))
            return output, rows, summary
        self.assertNotEqual(process.returncode, 0)
        return process

    def water_options(self):
        return ("--tds-csv", str(self.sensor), "--tds-reference", str(self.reference),
                "--site-id", "lake-a", "--tds-tolerance", "0.15")

    def test_sensor_alignment_provenance_reference_and_report(self):
        output, rows, summary = self.run_cli(
            "aligned", "--video-source", "survey", *self.water_options()
        )
        self.assertEqual([float(row["timestamp_s"]) for row in rows], [0, 1, 2, 3])
        self.assertEqual([row["tds_source"] for row in rows],
                         ["measured", "simulated", "measured", "missing"])
        self.assertEqual([row["tds_comparison"] for row in rows], [
            "within_reference_range", "simulated_excluded", "incompatible_reference_method", "missing"
        ])
        self.assertAlmostEqual(float(rows[0]["tds_time_offset_s"]), 0.1)
        self.assertEqual(rows[1]["simulated_tds_ppm"], "999.0")
        self.assertEqual(rows[3]["tds_ppm"], "")
        self.assertTrue(all(row["vegetation_cover_pct"] == "" for row in rows))
        self.assertEqual(summary["water"]["unique_matched_measured_samples"], 2)
        self.assertEqual(summary["water"]["matched_measured_median_ppm"], 200)
        self.assertEqual(summary["water"]["input_dataset_summary"]["measured"]["count"], 3)
        self.assertEqual(summary["assessment"]["lake_health"], "insufficient_evidence")
        self.assertIsNone(summary["imagery"]["vegetation_cover_pct"])
        self.assertIn("insufficient evidence", (output / "report.md").read_text(encoding="utf-8"))
        self.assertEqual(len(summary["source"]["tds_csv"]["sha256"]), 64)
        for row in rows:
            self.assertTrue((output / row["mask"]).is_file())
            if row["overlay"]:
                self.assertTrue((output / row["overlay"]).is_file())

    def test_missing_tds_is_default_and_existing_output_is_preserved(self):
        output, rows, summary = self.run_cli("default", "--video-source", "synthetic")
        self.assertTrue(all(row["tds_source"] == "missing" for row in rows))
        self.assertTrue(all(row["tds_ppm"] == "" for row in rows))
        self.assertEqual(summary["source"]["type"], "synthetic")
        before = {path.relative_to(output): path.read_bytes()
                  for path in output.rglob("*") if path.is_file()}
        failure = self.run_cli("default", success=False)
        self.assertIn("Output already exists", failure.stderr)
        after = {path.relative_to(output): path.read_bytes()
                 for path in output.rglob("*") if path.is_file()}
        self.assertEqual(before, after)
        self.assertFalse(list(self.local.glob(".ecology-*")))

    def test_sample_window_uses_original_timeline_and_stock_is_unverified(self):
        _, rows, summary = self.run_cli(
            "window", "--video-source", "stock", "--start", "1", "--duration", "2",
            *self.water_options(),
        )
        self.assertEqual([float(row["timestamp_s"]) for row in rows], [1, 2])
        self.assertEqual(rows[0]["tds_comparison"], "simulated_excluded")
        self.assertEqual(rows[1]["tds_comparison"], "unverified_video_site")
        self.assertEqual(summary["water"]["unique_matched_measured_samples"], 1)
        self.assertEqual(summary["water"]["matched_measured_median_ppm"], 300)

    def test_roi_changes_denominator_and_retains_confirmation(self):
        _, full, _ = self.run_cli("full", "--max-samples", "1")
        _, left, summary = self.run_cli(
            "left", "--max-samples", "1", "--roi", "0,0,0.5,1", "--confirm-bottom-roi"
        )
        _, right, _ = self.run_cli(
            "right", "--max-samples", "1", "--roi", "0.5,0,0.5,1"
        )
        self.assertAlmostEqual(float(full[0]["candidate_green_cover_pct"]), 50, delta=1)
        self.assertAlmostEqual(float(left[0]["candidate_green_cover_pct"]), 100, delta=1)
        self.assertAlmostEqual(float(right[0]["candidate_green_cover_pct"]), 0, delta=1)
        self.assertEqual(summary["method"]["roi_normalized"], [0, 0, 0.5, 1])
        self.assertTrue(summary["method"]["roi_confirmed_bottom"])
        self.assertEqual(left[0]["vegetation_cover_pct"], "")

    def test_invalid_roi_or_missing_sensor_site_creates_no_output(self):
        for name, options in (
            ("outside", ("--roi", "0.9,0,0.5,1")),
            ("nan", ("--roi", "nan,0,1,1")),
            ("no-roi", ("--confirm-bottom-roi",)),
            ("no-site", ("--tds-csv", str(self.sensor))),
        ):
            with self.subTest(name=name):
                self.run_cli(name, *options, success=False)
                self.assertFalse((self.local / name).exists())

    def test_portrait_padding_is_excluded_from_candidate_denominator(self):
        self.clip = self.local / "portrait.mkv"
        subprocess.run([
            shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-nostdin",
            "-f", "lavfi", "-i",
            "color=c=gray:s=120x160:r=2:d=1,drawbox=x=0:y=0:w=60:h=160:color=green:t=fill",
            "-c:v", "ffv1", str(self.clip),
        ], check=True, capture_output=True)
        _, rows, summary = self.run_cli("portrait", "--max-samples", "1")
        self.assertEqual(len(rows), 1)
        self.assertAlmostEqual(float(rows[0]["candidate_green_cover_pct"]), 50, delta=1)
        width = summary["method"]["analysis_size"][0]
        self.assertLess(int(rows[0]["valid_pixels"]), width * width)
