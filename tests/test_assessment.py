import copy
import json
import math
from pathlib import Path
import subprocess
import sys
import unittest

from manta_ray.ecology.assessment import assess, catalog, _tsi_category
from manta_ray.ecology.simulation import simulated_tds_value


def measurement(parameter, value, unit, sample="sample-1", day=1, source="measured"):
    return {"parameter": parameter, "value": value, "unit": unit, "source": source,
            "method": "independent reference test", "sample_id": sample,
            "sampled_at": f"2026-06-{day:02d}"}


class AssessmentTests(unittest.TestCase):
    def test_catalog_examples_are_runnable_explicit_scenarios(self):
        for method in catalog():
            report = assess(method["example"])
            self.assertEqual(report["method_id"], method["id"])
            self.assertEqual(report["status"], "computed")
            self.assertTrue(report["scenario"])
            self.assertIn("SIMULATION", report["result"]["label"])
            json.dumps(report, allow_nan=False)

    def test_nalms_carlson_reference_values_and_priority(self):
        report = assess({"method": "carlson_tsi", "measurements": [
            measurement("secchi_depth", 1, "m"),
            measurement("total_phosphorus", 1, "ug/L"),
            measurement("chlorophyll_a", 1, "ug/L"),
        ]})
        scores = {item["parameter"]: item["score"] for item in report["components"]}
        self.assertEqual(scores["secchi_depth"], 60)
        self.assertAlmostEqual(scores["total_phosphorus"], 4.15)
        self.assertAlmostEqual(scores["chlorophyll_a"], 30.6)
        self.assertEqual(report["result"]["primary_parameter"], "chlorophyll_a")
        self.assertEqual(report["result"]["score"], 30.6)
        self.assertEqual(report["data_origin"], "measured")

    def test_carlson_converts_units_and_retains_unbounded_scale(self):
        meters = assess({"method": "carlson_tsi", "measurements": [measurement("secchi_depth", 2, "m")]})
        centimeters = assess({"method": "carlson_tsi", "measurements": [measurement("secchi_depth", 200, "cm")]})
        self.assertAlmostEqual(meters["result"]["score"], 50, delta=0.02)
        self.assertEqual(meters["result"]["score"], centimeters["result"]["score"])
        for value, unit in ((20, "ug/L"), (0.02, "mg/L"), (20, "µg/L")):
            report = assess({"method": "carlson_tsi", "measurements": [measurement("chlorophyll_a", value, unit)]})
            self.assertAlmostEqual(report["result"]["score"], 60, delta=0.03)
        report = assess({"method": "carlson_tsi", "measurements": [measurement("chlorophyll_a", 1e-10, "ug/L")]})
        self.assertLess(report["result"]["score"], 0)
        self.assertEqual([_tsi_category(value) for value in (39.999, 40, 50, 70)],
                         ["oligotrophic", "mesotrophic", "eutrophic", "hypereutrophic"])

    def test_tds_and_rgb_never_substitute_for_carlson(self):
        report = assess({"method": "carlson_tsi", "measurements": [measurement("tds", 150, "ppm")]},
                        {"imagery": {"candidate_cover_median_pct": 95}}, [])
        self.assertEqual(report["status"], "insufficient_data")
        self.assertIsNone(report["result"]["score"])
        self.assertTrue(report["missing_inputs"])
        self.assertEqual(len(report["excluded_inputs"]), 1)

    def test_simulated_inputs_require_opt_in_and_mixed_is_scenario(self):
        request = {"method": "carlson_tsi", "measurements": [measurement("chlorophyll_a", 20, "ug/L", source="simulated")]}
        self.assertEqual(assess(request)["status"], "insufficient_data")
        request["include_simulated"] = True
        self.assertEqual(assess(request)["data_origin"], "simulated")
        request["measurements"].append(measurement("total_phosphorus", 48, "ug/L"))
        report = assess(request)
        self.assertEqual(report["data_origin"], "mixed")
        self.assertTrue(report["scenario"])

    def test_ccme_official_devon_1997_worked_example(self):
        # CCME 2017 manual table 1, printed pages 6–7. Censored values are entered
        # at the detection limits as the manual specifies. No missing tests added.
        columns = {
            "dissolved_oxygen": ([11.4, 11, 11.5, 12.5, 10.4, 8.9, 8.5, 7.5, 9.2, 11, 12.1, 13.3], "mg/L", "minimum", 5),
            "ph": ([8, 7.9, 7.9, 7.9, 8.1, 8.2, 8.3, 8.2, 8.2, 8.1, 8, 8], "pH", "range", (6.5, 9)),
            "total_phosphorus": ([0.006, 0.005, 0.006, 0.058, 0.042, 0.108, 0.017, 0.008, 0.006, 0.008, 0.006, 0.004], "mg/L", "maximum", 0.05),
            "total_nitrogen": ([0.160, 0.170, 0.132, 0.428, 0.250, 0.707, 0.153, 0.153, 0.130, 0.093, 0.296, 0.054], "mg/L", "maximum", 1),
            "fecal_coliform": ([4, 4, 4, 4, 4, 26, 9, 8, 12, 12, 8, 4], "count/dL", "maximum", 400),
            "arsenic": ([0.0002, 0.0002, 0.0002, 0.0002, 0.0002, 0.0006, 0.0002, 0.0002, 0.0003, 0.0002, 0.0002, 0.0002], "mg/L", "maximum", 0.05),
            "lead": ([0.0004, 0.0094, 0.0003, 0.0008, 0.0008, 0.0013, 0.0004, 0.0003, 0.0018, 0.0011, 0.0051, 0.0003], "mg/L", "maximum", 0.004),
            "mercury": ([0.05, 0.05, 0.05, 0.05, 0.05, 0.05, None, 0.05, 0.05, 0.05, 0.05, 0.05], "ug/L", "maximum", 0.1),
            "2_4_d": ([0.005, None, None, 0.004, None, None, None, 0.005, None, 0.005, None, None], "ug/L", "maximum", 4),
            "lindane": ([0.005, None, None, 0.005, None, None, None, 0.005, None, 0.005, None, None], "ug/L", "maximum", 0.01),
        }
        measurements = []
        objectives = []
        for parameter, (values, unit, direction, limit) in columns.items():
            for month, value in enumerate(values, 1):
                if value is not None:
                    record = measurement(parameter, value, unit, f"month-{month}")
                    record["sampled_at"] = f"1997-{month:02d}-01"
                    measurements.append(record)
            objective = {"parameter": parameter, "unit": unit, "direction": direction, "reference": "CCME 2017 table 1"}
            objective.update({"min_value": limit[0], "max_value": limit[1]} if direction == "range" else {"value": limit})
            objectives.append(objective)
        report = assess({"method": "ccme_wqi", "site_id": "Devon", "measurements": measurements, "objectives": objectives})
        self.assertEqual(report["result"]["test_count"], 103)
        self.assertEqual(report["result"]["parameter_count"], 10)
        self.assertEqual(report["result"]["failed_test_count"], 4)
        self.assertEqual(report["result"]["failed_parameters"], ["lead", "total_phosphorus"])
        self.assertAlmostEqual(report["components"][0]["score"], 20)
        self.assertAlmostEqual(report["components"][1]["score"], 3.9, delta=0.03)
        self.assertAlmostEqual(report["components"][2]["score"], 2.8, delta=0.03)
        self.assertAlmostEqual(report["result"]["score"], 88, delta=0.15)
        self.assertEqual(report["result"]["category"], "good")
        self.assertFalse(report["result"]["exploratory"])

    def test_ccme_range_counts_each_measurement_once(self):
        report = assess({"method": "ccme_wqi", "measurements": [
            measurement("ph", value, "pH", f"sample-{index}", index)
            for index, value in enumerate((5, 7, 10), 1)],
            "objectives": [{"parameter": "ph", "unit": "pH", "direction": "range", "min_value": 6.5,
                            "max_value": 9, "reference": "test reference"}]})
        self.assertEqual(report["result"]["test_count"], 3)
        self.assertEqual(report["result"]["failed_test_count"], 2)
        self.assertEqual(report["result"]["parameter_count"], 1)
        self.assertTrue(report["result"]["exploratory"])
        self.assertAlmostEqual(report["result"]["tests"][0]["excursion"], 0.3)

    def test_ccme_passing_and_zero_denominator_limit(self):
        base = {"method": "ccme_wqi", "measurements": [measurement("oxygen", 5, "mg/L")],
                "objectives": [{"parameter": "oxygen", "unit": "mg/L", "direction": "minimum", "value": 5, "reference": "test reference"}]}
        self.assertEqual(assess(base)["result"]["score"], 100)
        base["measurements"][0]["value"] = 0
        report = assess(base)
        self.assertEqual(report["result"]["score"], 0)
        self.assertEqual(report["components"][2]["score"], 100)
        self.assertTrue(report["result"]["tests"][0]["infinite_excursion"])
        json.dumps(report, allow_nan=False)

    def test_ccme_units_and_temporal_repetition(self):
        request = next(item["example"] for item in catalog(include_legacy=True) if item["id"] == "ccme_wqi")
        report = assess(request)
        self.assertTrue(report["result"]["earlier_minimum_4_parameters_4_times_met"])
        self.assertFalse(report["result"]["preferred_2017_parameter_count_met"])
        for item in request["measurements"]:
            item["sampled_at"] = "2026-06-01"
        report = assess(request)
        self.assertFalse(report["result"]["earlier_minimum_4_parameters_4_times_met"])
        request["objectives"][0]["unit"] = "m"
        with self.assertRaisesRegex(ValueError, "units differ"):
            assess(request)

    def test_camera_csv_rows_missing_values_and_real_zero_cover(self):
        rows = [{"timestamp_s": "0", "status": "usable", "candidate_green_cover_pct": "0", "tds_source": "missing", "tds_ppm": ""},
                {"timestamp_s": "1", "status": "too_dark", "candidate_green_cover_pct": "", "tds_source": "simulated", "tds_ppm": "150", "tds_sample_timestamp_s": "1"}]
        report = assess({"method": "camera_tds"}, {"source": {"type": "stock"}}, rows)
        self.assertEqual(report["result"]["imagery"]["candidate_green_cover_pct"]["median"], 0)
        self.assertEqual(report["result"]["tds_ppm"]["simulated"]["count"], 0)
        self.assertEqual(report["result"]["category"], "review")
        self.assertIsNone(report["result"]["score"])
        self.assertEqual(report["result"]["lake_health"], "insufficient_evidence")

    def test_seeded_camera_scenario_is_reproducible_and_retains_measured(self):
        request = {"method": "camera_tds", "include_simulated": True,
                   "measurements": [measurement("tds", 100, "ppm")],
                   "simulate_tds": {"seed": 42, "baseline_ppm": 150, "variation_ppm": 10}}
        rows = [{"timestamp_s": str(index), "status": "usable", "candidate_green_cover_pct": "10"} for index in range(3)]
        before = copy.deepcopy(request)
        first = assess(request, {}, rows)
        second = assess(request, {}, rows)
        self.assertEqual(first, second)
        self.assertEqual(request, before)
        self.assertEqual(first["data_origin"], "mixed")
        self.assertEqual(len(first["generated_tds"]), 3)
        self.assertEqual(first["result"]["tds_ppm"]["measured"]["median"], 100)
        self.assertTrue(all(140 <= item["value"] <= 160 for item in first["generated_tds"]))
        self.assertEqual([item["value"] for item in first["generated_tds"]],
                         [simulated_tds_value(index) for index in range(3)])
        self.assertEqual(first["engine_version"], "2.1.0")
        reversed_report = assess(before, {}, list(reversed(rows)))
        self.assertEqual({item["timestamp_s"]: item["value"] for item in first["generated_tds"]},
                         {item["timestamp_s"]: item["value"] for item in reversed_report["generated_tds"]})
        request["simulate_tds"]["seed"] = 43
        self.assertNotEqual(first["input_sha256"], assess(request, {}, rows)["input_sha256"])
        self.assertNotEqual(first["generated_tds"], assess(request, {}, rows)["generated_tds"])

    def test_camera_site_reference_and_deduplicated_tds(self):
        request = {"method": "camera_tds", "site_id": "tank", "tds_reference": {"min_ppm": 100, "max_ppm": 200, "reference": "local reference"}}
        rows = [{"timestamp_s": index, "status": "usable", "candidate_green_cover_pct": 25,
                 "tds_ppm": 210, "tds_source": "measured", "tds_sample_timestamp_s": 0} for index in range(2)]
        report = assess(request, {"source": {"type": "survey", "site_id": "tank"}}, rows)
        self.assertEqual(report["result"]["tds_ppm"]["measured"]["count"], 1)
        self.assertEqual(report["result"]["category"], "review")
        report = assess(request, {"source": {"type": "stock"}}, rows)
        self.assertEqual(report["result"]["tds_reference_comparison"]["status"], "site_context_unverified")

    def test_generated_scenario_supersedes_only_prior_simulated_rows(self):
        request = {"method": "camera_tds", "include_simulated": True,
                   "simulate_tds": {"seed": 42, "baseline_ppm": 150, "variation_ppm": 10}}
        rows = [{"timestamp_s": 0, "status": "usable", "candidate_green_cover_pct": 10,
                 "tds_ppm": 999, "tds_source": "simulated", "tds_sample_timestamp_s": 0},
                {"timestamp_s": 1, "status": "usable", "candidate_green_cover_pct": 10,
                 "tds_ppm": 100, "tds_source": "measured", "tds_sample_timestamp_s": 1}]
        report = assess(request, {}, rows)
        self.assertEqual(len(report["generated_tds"]), 2)
        self.assertEqual(report["result"]["tds_ppm"]["simulated"]["count"], 2)
        self.assertEqual(report["result"]["tds_ppm"]["measured"]["count"], 1)
        self.assertEqual(report["result"]["tds_ppm"]["measured"]["median"], 100)
        self.assertEqual(report["excluded_inputs"][0]["reason"], "superseded by explicit TDS scenario")

    def test_rejects_invalid_units_provenance_and_values(self):
        base = {"method": "carlson_tsi", "measurements": [measurement("chlorophyll_a", 20, "ug/L")]}
        for field, value in (("value", True), ("value", float("nan")), ("value", -1),
                             ("value", "20"), ("sampled_at", "yesterday"), ("method", ""),
                             ("source", "guessed"), ("unit", "ppm")):
            request = copy.deepcopy(base)
            request["measurements"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                assess(request)
        base["measurements"].append(base["measurements"][0].copy())
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            assess(base)
        with self.assertRaises(ValueError):
            assess({"method": "camera_tds", "simulate_tds": {"seed": 42}})

    def test_cli_stdin_and_catalog_emit_strict_json(self):
        result = subprocess.run([sys.executable, "-m", "manta_ray.ecology.assessment", "--catalog"], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual({entry["id"] for entry in json.loads(result.stdout)}, {"benthic_point_cover", "video_maxn", "multispectral_ndci", "camera_tds"})
        result = subprocess.run([sys.executable, "-m", "manta_ray.ecology.assessment"],
                                input=json.dumps({"request": {"method": "carlson_tsi"}}), capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "insufficient_data")
        invalid = subprocess.run([sys.executable, "-m", "manta_ray.ecology.assessment"], input='{"request":{"method":"unknown"}}', capture_output=True, text=True, timeout=20)
        self.assertEqual(invalid.returncode, 1)
        self.assertIn("Unknown method", invalid.stderr)


if __name__ == "__main__":
    unittest.main()
