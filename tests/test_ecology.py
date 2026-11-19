import csv
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from manta_ray.ecology.simulation import simulated_tds_value


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is required for video integration tests")
class EcologyTests(unittest.TestCase):
    def test_known_coverage_dark_view_and_zero_coverage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clip = root / "fixture.mkv"
            output = root / "ecology"
            stages = (
                "color=c=0xa07656:s=320x180:r=10:d=1,"
                "drawbox=x=0:y=0:w=80:h=180:c=green:t=fill[a];"
                "color=c=black:s=320x180:r=10:d=1[b];"
                "color=c=0xa07656:s=320x180:r=10:d=1,"
                "drawbox=x=0:y=0:w=80:h=180:c=0x403027:t=fill[c];"
                "[a][b][c]concat=n=3:v=1:a=0"
            )
            subprocess.run([
                "ffmpeg", "-v", "error", "-f", "lavfi", "-i", stages,
                "-c:v", "ffv1", str(clip),
            ], check=True, capture_output=True)
            cli = [
                sys.executable, "-m", "manta_ray.ecology", str(clip),
                "--output", str(output), "--overlay-every", "1", "--tds-ppm", "123",
            ]
            completed = subprocess.run(cli, text=True, capture_output=True, timeout=30)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            with (output / "survey.csv").open(encoding="utf-8", newline="") as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual([row["timestamp_s"] for row in rows], ["0.000000", "1.000000", "2.000000"])
            self.assertEqual([row["status"] for row in rows], ["usable", "too_dark", "usable"])
            self.assertAlmostEqual(float(rows[0]["candidate_green_cover_pct"]), 25, delta=1)
            self.assertEqual(rows[1]["candidate_green_cover_pct"], "")
            self.assertEqual(rows[1]["overlay"], "")
            self.assertEqual(float(rows[2]["candidate_green_cover_pct"]), 0)
            simulated_values = [float(row["simulated_tds_ppm"]) for row in rows]
            self.assertEqual(simulated_values, [simulated_tds_value(index, baseline_ppm=123) for index in range(3)])
            self.assertEqual(len(set(simulated_values)), 3)
            self.assertTrue(all(113 <= value <= 133 for value in simulated_values))
            self.assertTrue(all(row["tds_source"] == "simulated" for row in rows))
            for index in (0, 2):
                self.assertTrue((output / rows[index]["overlay"]).read_bytes().startswith(
                    b"\x89PNG\r\n\x1a\n"
                ))
            repeated = subprocess.run(cli, text=True, capture_output=True, timeout=30)
            self.assertNotEqual(repeated.returncode, 0)
            self.assertIn("Output already exists", repeated.stderr)

    def test_bad_video_does_not_publish_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clip = root / "broken.mp4"
            clip.write_bytes(b"not a video")
            output = root / "ecology"
            result = subprocess.run([
                sys.executable, "-m", "manta_ray.ecology", str(clip),
                "--output", str(output),
            ], text=True, capture_output=True, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("FFmpeg could not decode", result.stderr)
            self.assertFalse(output.exists())
