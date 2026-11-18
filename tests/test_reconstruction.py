import json
import io
from pathlib import Path
import shutil
import sqlite3
import struct
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

from manta_ray.reconstruction import __main__ as reconstruction


class ReconstructionTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is required for video extraction")
    def test_extraction_uses_real_frames_in_requested_interval(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clip = root / "survey % clip.mp4"
            output = root / "selected views % clip"
            subprocess.run(
                [
                    shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "testsrc2=duration=3:size=160x120:rate=12",
                    "-an", "-c:v", "mpeg4", str(clip),
                ],
                check=True,
            )
            code = reconstruction.main(
                [str(clip), "--output", str(output), "--start", "1", "--duration", "1",
                 "--fps", "3", "--extract-only"]
            )
            self.assertEqual(code, 0)
            report = json.loads((output / "reconstruction.json").read_text(encoding="utf-8"))
            self.assertEqual(report["extracted_frames"], 3)
            self.assertEqual(report["status"], "frames_extracted")
            self.assertEqual(report["video"]["width"], 160)
            self.assertEqual(report["frame_quality"]["unique_grayscale_frames"], 3)
            self.assertEqual(len(report["source_sha256"]), 64)
            self.assertGreater(report["frame_quality"]["frames"][0]["gradient_rms_8bit"], 0)
            frames = list((output / "frames").glob("*.jpg"))
            self.assertEqual(len({frame.read_bytes() for frame in frames}), 3)
            self.assertFalse((output / "point-cloud.ply").exists())

    def test_pipeline_exports_model_with_most_registered_views(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            stages = []
            database = output / "database.db"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE keypoints (image_id INTEGER, rows INTEGER)")
                connection.execute("INSERT INTO keypoints VALUES (1, 42)")
                connection.execute("CREATE TABLE two_view_geometries (rows INTEGER)")
                connection.execute("INSERT INTO two_view_geometries VALUES (20)")
            connection.close()

            def run_colmap(_, arguments, work_dir):
                stage = arguments[0]
                if arguments[1:] == ["-h"]:
                    return {
                        "feature_extractor": "--FeatureExtraction.use_gpu",
                        "sequential_matcher": "--SiftMatching.use_gpu",
                    }[stage]
                stages.append(stage)
                if stage == "mapper":
                    for index, images, points in [(0, 3, 1), (1, 2, 10)]:
                        model = work_dir / "sparse" / str(index)
                        model.mkdir()
                        for name, count in [
                            ("cameras.bin", 1), ("images.bin", images), ("points3D.bin", points)
                        ]:
                            (model / name).write_bytes(struct.pack("<Q", count))
                elif stage == "model_converter":
                    self.assertEqual(arguments[2], "sparse/0")
                    (work_dir / "point-cloud.ply").write_bytes(
                        b"ply\nformat ascii 1.0\nelement vertex 1\n"
                        b"property float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n"
                    )
                elif stage == "feature_extractor":
                    self.assertEqual(arguments[-2:], ["--FeatureExtraction.use_gpu", "0"])
                elif stage == "sequential_matcher":
                    self.assertEqual(arguments[-2:], ["--SiftMatching.use_gpu", "0"])
                elif stage == "model_analyzer":
                    return "Observations: 42\nMean track length: 3.5\nMean reprojection error: 0.25px"
                return ""

            with patch.object(reconstruction, "run_tool", side_effect=run_colmap):
                report = reconstruction.reconstruct(Path("colmap"), output, 5)
            self.assertEqual(stages, [
                "feature_extractor", "sequential_matcher", "mapper", "model_analyzer", "model_converter"
            ])
            self.assertEqual(report["registered_frames"], 3)
            self.assertEqual(report["points"], 1)
            self.assertEqual(report["point_cloud"], "point-cloud.ply")
            self.assertEqual(report["features"]["keypoints_total"], 42)
            self.assertEqual(report["features"]["verified_image_pairs"], 1)
            self.assertEqual(report["registered_frame_fraction"], 0.6)
            self.assertEqual(report["model_analysis"]["mean_reprojection_error_pixels"], 0.25)
            self.assertEqual(report["model_analysis"]["observations"], 42)
            self.assertEqual(report["model_analysis"]["mean_track_length"], 3.5)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg tools required")
    def test_invalid_video_and_past_end_seek_leave_no_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            invalid = root / "broken.mp4"
            invalid.write_bytes(b"invalid")
            output = root / "invalid-output"
            with redirect_stderr(io.StringIO()):
                self.assertEqual(reconstruction.main([
                    str(invalid), "--output", str(output), "--extract-only"
                ]), 1)
            self.assertFalse(output.exists())
            clip = root / "short.mp4"
            subprocess.run([
                shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=black:size=160x120:duration=1",
                "-c:v", "mpeg4", str(clip),
            ], check=True)
            with redirect_stderr(io.StringIO()):
                self.assertEqual(reconstruction.main([
                    str(clip), "--output", str(output), "--start", "99", "--extract-only"
                ]), 1)
            self.assertFalse(output.exists())

    def test_failed_colmap_stage_and_empty_model_raise(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with patch.object(reconstruction, "cpu_option", return_value=[]), patch.object(
                reconstruction, "run_tool", side_effect=reconstruction.ReconstructionError("feature extraction failed")
            ):
                with self.assertRaisesRegex(reconstruction.ReconstructionError, "feature extraction failed"):
                    reconstruction.reconstruct(Path("colmap"), output, 5)
            with patch.object(reconstruction, "cpu_option", return_value=[]), patch.object(
                reconstruction, "run_tool", return_value=""
            ), patch.object(reconstruction, "feature_quality", return_value={}):
                with self.assertRaisesRegex(reconstruction.ReconstructionError, "no usable sparse model"):
                    reconstruction.reconstruct(Path("colmap"), output, 5)

    def test_truncated_model_file_and_missing_feature_database_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            truncated = output / "images.bin"
            truncated.write_bytes(b"short")
            with self.assertRaisesRegex(reconstruction.ReconstructionError, "incomplete model"):
                reconstruction.read_model_count(truncated)
            with self.assertRaises(sqlite3.Error):
                reconstruction.feature_quality(output / "absent.db")
            self.assertFalse((output / "absent.db").exists())

    def test_empty_features_report_zero_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "database.db"
            with sqlite3.connect(database) as connection:
                connection.execute("CREATE TABLE keypoints (image_id INTEGER, rows INTEGER)")
                connection.execute("CREATE TABLE two_view_geometries (rows INTEGER)")
            connection.close()
            report = reconstruction.feature_quality(database)
            self.assertEqual(report["keypoints_total"], 0)
            self.assertEqual(report["verified_image_pairs"], 0)
            self.assertEqual(report["keypoints_mean_per_image"], 0)

    def test_rejects_malformed_or_truncated_ply(self):
        for content in (
            b"invalid", b"ply\nelement vertex 1\n",
            b"ply\nelement vertex 1\nend_header\n",
            b"ply\nelement vertex 20\nend_header\n0 0 0\n",
        ):
            with self.subTest(content=content), tempfile.TemporaryDirectory() as directory:
                output = Path(directory)

                def fake_colmap(_, arguments, work_dir):
                    if arguments[0] == "mapper":
                        model = work_dir / "sparse" / "0"
                        model.mkdir()
                        for name, count in (("cameras.bin", 1), ("images.bin", 3), ("points3D.bin", 1)):
                            (model / name).write_bytes(struct.pack("<Q", count))
                    elif arguments[0] == "model_converter":
                        (work_dir / "point-cloud.ply").write_bytes(content)
                    return ""

                with patch.object(reconstruction, "cpu_option", return_value=[]), patch.object(
                    reconstruction, "run_tool", side_effect=fake_colmap
                ), patch.object(reconstruction, "feature_quality", return_value={}):
                    with self.assertRaises(reconstruction.ReconstructionError):
                        reconstruction.reconstruct(Path("colmap"), output, 4)

    def test_later_reconstruction_failure_preserves_frames_and_failure_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.mp4"
            source.write_bytes(b"mocked input")
            output = root / "result"

            def extract(_, __, ___, staged, ____):
                (staged / "frames").mkdir()
                (staged / "frames" / "frame-000001.jpg").write_bytes(b"mocked frame")
                return 2

            with patch.object(reconstruction, "find_tool", return_value=Path("mocked")), patch.object(
                reconstruction, "inspect_video", return_value={"reserved_color_metadata_fallback": {}}
            ), patch.object(reconstruction, "extract_frames", side_effect=extract), patch.object(
                reconstruction, "frame_quality", return_value={}
            ), patch.object(
                reconstruction, "reconstruct", side_effect=reconstruction.ReconstructionError("no overlap")
            ), patch.object(
                reconstruction, "run_tool", return_value="COLMAP 4.2.1"
            ), redirect_stderr(io.StringIO()):
                self.assertEqual(reconstruction.main([str(source), "--output", str(output)]), 1)
            metadata = json.loads((output / "reconstruction.json").read_text(encoding="utf-8"))
            self.assertEqual(metadata["status"], "reconstruction_failed")
            self.assertEqual(metadata["error"], "no overlap")
            self.assertEqual(metadata["colmap_version"], "4.2.1")
            self.assertTrue((output / "frames" / "frame-000001.jpg").is_file())


if __name__ == "__main__":
    unittest.main()
