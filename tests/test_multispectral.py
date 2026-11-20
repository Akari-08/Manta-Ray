"""Numerical, quality-control and real image-decoder tests for spectral capture ingestion."""

from copy import deepcopy
import csv
import hashlib
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

from manta_ray.ecology.assessment import assess, catalog
from manta_ray.ecology.multispectral import (METHOD, _pgm, assess_multispectral,
                                            example_request, export, load_request)


def measured():
    request = example_request()
    request["include_simulated"] = False
    request["multispectral"]["source"] = "measured"
    return request


def write_pgm(path, width, height, values, maximum=65535):
    payload = bytes(values) if maximum <= 255 else struct.pack(">" + "H" * len(values), *values)
    path.write_bytes(f"P5\n# known numerical fixture\n{width} {height}\n{maximum}\n".encode() + payload)


class MultispectralTests(unittest.TestCase):
    def test_known_equation_and_glint_exclusion(self):
        report = assess(measured())
        self.assertEqual(report["status"], "computed")
        self.assertEqual(report["data_origin"], "measured")
        self.assertFalse(report["scenario"])
        statistics = report["result"]["ndci"]
        self.assertAlmostEqual(statistics["mean"], (0.2 + 0 - 1 / 3) / 3)
        self.assertEqual(statistics["median"], 0)
        self.assertAlmostEqual(statistics["min"], -1 / 3)
        self.assertAlmostEqual(statistics["max"], 0.2)
        self.assertAlmostEqual(statistics["p10"], -4 / 15)
        self.assertEqual(report["result"]["pixel_quality"]["valid_pixels"], 3)
        self.assertEqual(report["result"]["pixel_quality"]["exclusion_reasons"], {"glint": 1})
        for key in ("score", "category", "chlorophyll_a_ug_l"):
            self.assertIsNone(report["result"][key])
        self.assertEqual(report["result"]["toxin_status"], "not_measured")
        self.assertEqual(report["result"]["overall_ecological_health"], "not_determined")

    def test_scale_invariance_and_explicit_index_map(self):
        first = measured()
        first["include_index_map"] = True
        second = deepcopy(first)
        second["multispectral"]["radiometry"] = "remote_sensing_reflectance_sr-1"
        for band in second["multispectral"]["bands"].values():
            band["values"] = [value / 3.141592653589793 for value in band["values"]]
        a, b = assess(first), assess(second)
        self.assertAlmostEqual(a["result"]["ndci"]["mean"], b["result"]["ndci"]["mean"])
        self.assertIsNone(a["index_map"]["values"][2])
        self.assertNotIn("index_map", assess(measured()))

    def test_unusable_numeric_pixels_remain_missing_not_zero(self):
        request = measured()
        capture = request["multispectral"]
        capture["width"], capture["height"] = 5, 1
        capture["quality_mask"]["values"] = [0] * 5
        capture["bands"]["red"]["values"] = [None, -0.1, 2, 0, 0.02]
        capture["bands"]["red_edge"]["values"] = [0.1, 0.1, 0.2, 0, 0.03]
        report = assess(request)
        self.assertAlmostEqual(report["result"]["ndci"]["mean"], 0.2)
        quality = report["result"]["pixel_quality"]
        self.assertEqual(quality["valid_pixels"], 1)
        self.assertEqual(quality["excluded_pixels"], 4)
        self.assertEqual(quality["exclusion_reasons"], {
            "missing_reflectance": 1, "reflectance_out_of_range": 2, "near_zero_denominator": 1})

    def test_combined_mask_bits_and_all_masked_capture(self):
        request = measured()
        request["multispectral"]["quality_mask"]["values"] = [1 | 2, 4, 8 | 16, 32 | 64]
        report = assess(request)
        self.assertEqual(report["status"], "insufficient_data")
        self.assertIsNone(report["result"]["ndci"])
        quality = report["result"]["pixel_quality"]
        self.assertEqual(quality["excluded_pixels"], 4)
        self.assertEqual(sum(quality["exclusion_reasons"].values()), 7)

    def test_camera_specific_low_signal_threshold_does_not_invent_a_universal_cutoff(self):
        request = measured()
        request["multispectral"]["bands"]["red"]["values"][0] = 0.000001
        request["multispectral"]["bands"]["red_edge"]["values"][0] = 0.000009
        without = assess(request)
        self.assertTrue(any("signal-to-noise" in item for item in without["limitations"]))
        request["multispectral"]["signal_quality"] = {"minimum_band_sum": 0.001, "reference": "Synthetic noise-floor test"}
        report = assess(request)
        self.assertEqual(report["result"]["pixel_quality"]["exclusion_reasons"]["below_minimum_signal"], 1)
        self.assertEqual(report["result"]["pixel_quality"]["valid_pixels"], 2)
        del request["multispectral"]["calibration"]["surface_reflection_correction"]
        self.assertEqual(assess(request)["status"], "calibration_required")

    def test_synthetic_input_requires_explicit_opt_in(self):
        request = example_request()
        del request["include_simulated"]
        report = assess(request)
        self.assertEqual(report["data_origin"], "none")
        self.assertIsNone(report["result"]["ndci"])
        self.assertEqual(report["excluded_inputs"][0]["reason"], "simulated_input_excluded")
        report = assess(example_request())
        self.assertTrue(report["scenario"])
        self.assertIn("SIMULATION", report["result"]["label"])

    def test_scientific_eligibility_gates(self):
        cases = [
            (("geometry",), "submerged", "unsupported_acquisition_geometry"),
            (("radiometry",), "raw_dn", "calibration_required"),
            (("calibration",), {}, "calibration_required"),
            (("registration", "verified"), False, "registration_required"),
            (("quality_mask", "reviewed"), False, "quality_control_required"),
            (("bands", "red_edge", "center_nm"), 840, "unsupported_band_configuration"),
            (("bands", "red", "fwhm_nm"), 100, "unsupported_band_configuration"),
        ]
        for keys, value, status in cases:
            with self.subTest(keys=keys):
                request = measured()
                target = request["multispectral"]
                for key in keys[:-1]:
                    target = target[key]
                target[keys[-1]] = value
                report = assess(request)
                self.assertEqual(report["status"], status)
                self.assertIsNone(report["result"]["ndci"])
                self.assertIsNone(report["result"]["score"])

    def test_band_variants_are_flagged_not_given_published_concentrations(self):
        request = measured()
        request["multispectral"]["bands"]["red_edge"]["center_nm"] = 717
        report = assess(request)
        self.assertEqual(report["status"], "computed")
        self.assertTrue(any("adapted index" in item for item in report["limitations"]))
        self.assertIsNone(report["result"]["chlorophyll_a_ug_l"])

    def test_invalid_shapes_values_metadata_and_mask_fail_explicitly(self):
        changes = [
            ("width", True), ("height", 0), ("source", "unknown"),
            ("captured_at", "2026-01-01"),
        ]
        for key, value in changes:
            with self.subTest(key=key):
                request = measured()
                request["multispectral"][key] = value
                with self.assertRaises(ValueError):
                    assess(request)
        for value in ([], [0, 0], [True, 0, 0, 0], [128, 0, 0, 0]):
            request = measured()
            request["multispectral"]["quality_mask"]["values"] = value
            with self.assertRaises(ValueError):
                assess(request)
        for value in (float("nan"), float("inf"), True, "0.02"):
            request = measured()
            request["multispectral"]["bands"]["red"]["values"][0] = value
            with self.assertRaises(ValueError):
                assess(request)
        request = measured()
        request["site_id"] = "different-site"
        with self.assertRaises(ValueError):
            assess(request)

    def test_operator_threshold_is_auditable_and_never_a_health_classification(self):
        request = measured()
        request["screening_rule"] = {"ndci_threshold": 0.1, "reference": "Explicit synthetic screening scenario"}
        report = assess(request)
        rule = report["result"]["operator_screening_rule"]
        self.assertEqual(rule["exceeding_pixels"], 1)
        self.assertAlmostEqual(rule["exceeding_sample_fraction_pct"], 100 / 3)
        self.assertIsNone(report["result"]["category"])
        self.assertEqual(report["result"]["bloom_status"], "not_confirmed")

    def test_input_fingerprints_reproduce_and_change_with_calibration(self):
        request = measured()
        first = assess(request)
        self.assertEqual(first, assess(deepcopy(request)))
        request["multispectral"]["calibration"]["id"] = "second-calibration"
        self.assertNotEqual(first["input_sha256"], assess(request)["input_sha256"])
        self.assertIn(METHOD, {item["id"] for item in catalog()})
        self.assertEqual(assess({"method": METHOD})["status"], "awaiting_spectral_inputs")


class MultispectralFileTests(unittest.TestCase):
    def capture_files(self, directory):
        request = measured()
        capture = request["multispectral"]
        for name, values in (("red", [200, 300, 200, 400]), ("red_edge", [300, 300, 800, 200])):
            write_pgm(directory / (name + ".pgm"), 2, 2, values)
            band = capture["bands"][name]
            del band["values"]
            band.update(path=name + ".pgm", scale=0.0001, offset=0)
        write_pgm(directory / "quality.pgm", 2, 2, [0, 0, 2, 0], 255)
        del capture["quality_mask"]["values"]
        capture["quality_mask"]["path"] = "quality.pgm"
        manifest = directory / "capture.json"
        manifest.write_text(json.dumps(request), encoding="utf-8")
        return manifest, request

    def test_real_16bit_pgm_ingestion_export_and_cli(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest, _ = self.capture_files(root)
            request = load_request(manifest)
            for actual, expected in zip(request["multispectral"]["bands"]["red"]["values"], [0.02, 0.03, 0.02, 0.04]):
                self.assertAlmostEqual(actual, expected)
            self.assertEqual(request["multispectral"]["bands"]["red"]["source_file"]["sha256"],
                             hashlib.sha256((root / "red.pgm").read_bytes()).hexdigest())
            completed = subprocess.run([sys.executable, "-m", "manta_ray.ecology.multispectral",
                                        "--input", str(manifest), "--output", str(root / "result")],
                                       capture_output=True, text=True, timeout=30)
            self.assertEqual(completed.returncode, 0, completed.stderr)
            self.assertEqual(json.loads(completed.stdout)["status"], "computed")
            bundle = root / "result"
            report = json.loads((bundle / "report.json").read_text())
            imported = json.loads((bundle / "assessment-request.json").read_text())
            self.assertEqual(assess(imported)["result"], report["result"])
            with (bundle / "ndci.csv").open(newline="") as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual(len(rows), 4)
            self.assertEqual(rows[2]["ndci"], "")
            self.assertTrue((bundle / "ndci.pgm").is_file())
            self.assertEqual(_pgm(bundle / "valid-mask.pgm")[2].tolist(), [255, 255, 0, 255])
            with self.assertRaises(ValueError):
                export(imported, bundle)

    def test_regular_grid_preserves_registration_and_records_sampling(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest, _ = self.capture_files(root)
            request = load_request(manifest, max_side=1)
            capture = request["multispectral"]
            self.assertEqual((capture["width"], capture["height"]), (1, 1))
            self.assertEqual(capture["bands"]["red"]["values"], [0.04])
            self.assertEqual(capture["bands"]["red_edge"]["values"], [0.02])
            self.assertEqual(capture["sampling"]["original_width"], 2)
            self.assertAlmostEqual(assess(request)["result"]["ndci"]["mean"], -1 / 3)

    def test_no_rgb_or_unregistered_dimensions_or_escape_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest, request = self.capture_files(root)
            for path in ("../outside.pgm", str(root / "red.pgm"), "red.jpg"):
                changed = deepcopy(request)
                changed["multispectral"]["bands"]["red"]["path"] = path
                manifest.write_text(json.dumps(changed))
                with self.assertRaises((ValueError, FileNotFoundError)):
                    load_request(manifest)
            manifest.write_text(json.dumps(request))
            write_pgm(root / "quality.pgm", 1, 1, [0], 255)
            with self.assertRaisesRegex(ValueError, "identical registered dimensions"):
                load_request(manifest)

    def test_native_pgm_keeps_first_whitespace_valued_pixel_and_endianness(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for maximum, values in ((255, [10, 13, 32, 35]), (65535, [10, 256, 4096, 65535])):
                path = root / "native.pgm"
                write_pgm(path, 2, 2, values, maximum)
                self.assertEqual(_pgm(path)[2].tolist(), values)

    def test_default_sampled_file_request_fits_dashboard_import_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest, request = self.capture_files(root)
            request["multispectral"].pop("width")
            request["multispectral"].pop("height")
            for name, value in (("red", 301), ("red_edge", 803)):
                write_pgm(root / (name + ".pgm"), 256, 256, [value] * (256 * 256))
            write_pgm(root / "quality.pgm", 256, 256, [0] * (256 * 256), 255)
            manifest.write_text(json.dumps(request))
            imported = load_request(manifest)
            self.assertEqual(imported["multispectral"]["width"], 64)
            self.assertEqual(imported["multispectral"]["height"], 64)
            report = export(imported, root / "result")
            self.assertEqual(report["result"]["pixel_quality"]["valid_pixels"], 4096)
            self.assertLess((root / "result" / "assessment-request.json").stat().st_size, 256 * 1024)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "Existing FFmpeg required")
    def test_real_16bit_tiff_decoder_preserves_native_band_samples(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest, request = self.capture_files(root)
            for name in ("red", "red_edge"):
                subprocess.run(["ffmpeg", "-v", "error", "-i", str(root / (name + ".pgm")),
                                "-frames:v", "1", "-pix_fmt", "gray16le", str(root / (name + ".tif"))],
                               capture_output=True, check=True, timeout=30)
                request["multispectral"]["bands"][name]["path"] = name + ".tif"
            manifest.write_text(json.dumps(request))
            decoded = load_request(manifest)
            for actual, expected in zip(decoded["multispectral"]["bands"]["red"]["values"], [0.02, 0.03, 0.02, 0.04]):
                self.assertAlmostEqual(actual, expected)
            self.assertAlmostEqual(assess(decoded)["result"]["ndci"]["mean"], -2 / 45)


if __name__ == "__main__":
    unittest.main()
