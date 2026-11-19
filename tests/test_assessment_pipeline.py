"""Verify the selected scientific calculation through the video CLI entry point."""

import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required")
class AssessmentPipelineTests(unittest.TestCase):
    def test_pipeline_exports_selected_method_and_simulation_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clip = root / "reference-fixture.mkv"
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                "testsrc2=duration=1:size=128x96:rate=2", "-c:v", "ffv1", str(clip)
            ], capture_output=True, check=True)
            specification = root / "assessment-input.json"
            specification.write_text(json.dumps({
                "method": "carlson_tsi", "include_simulated": True,
                "site_id": "synthetic-fixture",
                "measurements": [{"parameter": "secchi_depth", "value": 1, "unit": "m",
                                  "source": "simulated", "method": "known mathematical fixture",
                                  "sample_id": "fixture-1", "sampled_at": "2026-06-01"}]
            }))
            output = root / "survey"
            completed = subprocess.run([
                sys.executable, "-m", "manta_ray.ecology", str(clip),
                "--output", str(output), "--video-source", "synthetic",
                "--assessment-input", str(specification), "--simulated-tds-ppm", "150",
            ], text=True, capture_output=True, timeout=30)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            report = json.loads((output / "assessment.json").read_text())
            summary = json.loads((output / "summary.json").read_text())
            self.assertEqual(report["method_id"], "carlson_tsi")
            self.assertAlmostEqual(report["result"]["score"], 60)
            self.assertEqual(report["result"]["category"], "eutrophic")
            self.assertTrue(report["scenario"])
            self.assertEqual(summary["ecological_assessment"], report)
            self.assertEqual(summary["assessment"]["lake_health"], "insufficient_evidence")
            self.assertIn("Selected assessment", (output / "report.md").read_text())
            self.assertTrue(math.isfinite(report["result"]["score"]))
