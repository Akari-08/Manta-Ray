"""Auditable Carlson TSI, CCME WQI, and camera/TDS screening calculations."""

import argparse
from collections import Counter, defaultdict
from datetime import datetime
import hashlib
import json
import math
from pathlib import Path
from statistics import mean, median
import sys

from .simulation import simulated_tds_value, simulation_metadata

VERSION = "1.1.0"
NALMS = "https://www.nalms.org/secchidipin/monitoring-methods/trophic-state-equations/"
CCME = "https://ccme.ca/en/res/wqimanualen.pdf"
CONDUCTIVITY = "https://archive.epa.gov/water/archive/web/html/vms59.html"
LAKES = "https://www.epa.gov/national-aquatic-resource-surveys/what-national-lakes-assessment"
TSI_EQUATIONS = {
    "chlorophyll_a": "9.81 * ln(chlorophyll_a_ug_L) + 30.6",
    "total_phosphorus": "14.42 * ln(total_phosphorus_ug_L) + 4.15",
    "secchi_depth": "60 - 14.41 * ln(secchi_depth_m)",
}


def _example_measurement(parameter, value, unit, sample_id="demo-1", day=1):
    return {"parameter": parameter, "value": value, "unit": unit,
            "source": "simulated", "method": "demonstration scenario",
            "sample_id": sample_id, "sampled_at": f"2026-06-{day:02d}"}


def catalog():
    """Describe inputs and provide explicitly simulated, runnable request examples."""
    ccme_measurements = [
        _example_measurement(parameter, value, unit, f"demo-{day}", day)
        for day in (1, 8, 15, 22)
        for parameter, value, unit in (
            ("dissolved_oxygen", 6, "mg/L"), ("total_phosphorus", 0.04, "mg/L"),
            ("total_nitrogen", 0.8, "mg/L"), ("tds", 150, "ppm"))
    ]
    return [
        {"id": "camera_tds", "name": "Camera and TDS screening",
         "scope": "Project screening protocol",
         "description": "Summarize selected image measurements and sourced TDS observations for monitoring or review.",
         "required_inputs": ["Saved survey imagery or TDS observations", "A cited site reference for TDS comparison"],
         "reference_urls": [LAKES, CONDUCTIVITY],
         "example": {"method": "camera_tds", "include_simulated": True,
                     "simulate_tds": {"seed": 42, "baseline_ppm": 150, "variation_ppm": 10}}},
        {"id": "carlson_tsi", "name": "Carlson Trophic State Index",
         "scope": "Algal biomass / trophic state",
         "description": "Calculate separate chlorophyll a, total phosphorus, and Secchi components with chlorophyll prioritized.",
         "required_inputs": ["Positive chlorophyll a or total phosphorus (ug/L), or measured Secchi depth (m)",
                             "Sample identity, time, source, and laboratory or field method"],
         "reference_urls": [NALMS],
         "example": {"method": "carlson_tsi", "include_simulated": True, "site_id": "scenario-site",
                     "measurements": [_example_measurement("chlorophyll_a", 20, "ug/L"),
                                      _example_measurement("total_phosphorus", 48, "ug/L"),
                                      _example_measurement("secchi_depth", 1, "m")]}},
        {"id": "ccme_wqi", "name": "CCME Water Quality Index (2017)",
         "scope": "Water quality relative to chosen objectives",
         "description": "Calculate scope, frequency, and amplitude of objective failures with an auditable sample count.",
         "required_inputs": ["Numeric sampled parameters and cited maximum/minimum objectives in compatible units",
                             "Site and time scope; 2017 recommends 8–20 relevant parameters",
                             "Repeated independent samples; limited datasets are exploratory"],
         "reference_urls": [CCME],
         "example": {"method": "ccme_wqi", "include_simulated": True, "site_id": "scenario-site",
                     "measurements": ccme_measurements,
                     "objectives": [
                         {"parameter": parameter, "value": value, "unit": unit, "direction": direction,
                          "reference": "Illustrative scenario objective; replace with a justified local guideline"}
                         for parameter, value, unit, direction in (
                             ("dissolved_oxygen", 5, "mg/L", "minimum"),
                             ("total_phosphorus", 0.05, "mg/L", "maximum"),
                             ("total_nitrogen", 1, "mg/L", "maximum"),
                             ("tds", 200, "ppm", "maximum"))]}},
    ]


def _number(value, name, minimum=0):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    if not math.isfinite(value) or value < minimum:
        raise ValueError(f"{name} must be finite and at least {minimum}")
    return float(value)


def _row_number(value, name):
    """CSV rows use strings; public measurement requests retain strict numeric types."""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError as error:
            raise ValueError(f"{name} must be numeric") from error
    return _number(value, name)


def _text(value, name):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be nonempty text")
    return value.strip()


def _unit(value):
    text = _text(value, "unit").replace("µ", "u").replace("μ", "u")
    normalized = text.lower().replace(" ", "")
    known = {
        "mg/l": ("concentration", "mg/L", 1),
        "ug/l": ("concentration", "mg/L", 0.001),
        "ng/l": ("concentration", "mg/L", 0.000001),
        "ppm": ("ppm", "ppm", 1),
        "m": ("length", "m", 1), "cm": ("length", "m", 0.01),
    }
    return known.get(normalized, (normalized, text, 1))


def _measurements(request, excluded):
    supplied = request.get("measurements", [])
    if not isinstance(supplied, list):
        raise ValueError("measurements must be a list")
    result = []
    seen = set()
    for index, item in enumerate(supplied):
        if not isinstance(item, dict):
            raise ValueError(f"measurement {index} must be an object")
        record = dict(item)
        for field in ("parameter", "source", "method", "sample_id", "sampled_at"):
            record[field] = _text(item.get(field), f"measurement {index} {field}")
        if record["source"] not in {"measured", "simulated"}:
            raise ValueError(f"measurement {index} source must be measured or simulated")
        try:
            datetime.fromisoformat(record["sampled_at"].replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(f"measurement {index} sampled_at must be an ISO date or timestamp") from error
        identity = (record["parameter"], record["sample_id"])
        if identity in seen:
            raise ValueError("Duplicate parameter/sample_id; provide independent samples once")
        seen.add(identity)
        dimension, unit, factor = _unit(item.get("unit"))
        value = _number(item.get("value"), f"measurement {index} value") * factor
        if not math.isfinite(value):
            raise ValueError(f"measurement {index} unit conversion overflows")
        record.update(value=value, unit=unit, dimension=dimension, index=index)
        if record["source"] == "simulated" and not request["include_simulated"]:
            excluded.append({"index": index, "parameter": record["parameter"], "reason": "simulated_input_excluded"})
        else:
            result.append(record)
    return result


def _origin(measurements):
    origins = {record["source"] for record in measurements}
    return next(iter(origins)) if len(origins) == 1 else "mixed" if origins else "none"


def _tsi_category(value):
    if value < 40:
        return "oligotrophic"
    if value < 50:
        return "mesotrophic"
    if value < 70:
        return "eutrophic"
    return "hypereutrophic"


def _carlson(report, measurements):
    components = []
    used = []
    for parameter in TSI_EQUATIONS:
        eligible = []
        for record in measurements:
            if record["parameter"] != parameter:
                continue
            required_dimension = "length" if parameter == "secchi_depth" else "concentration"
            if record["dimension"] != required_dimension:
                raise ValueError(f"{parameter} requires m/cm or ug/L/mg/L as appropriate")
            if record["value"] == 0:
                report["excluded_inputs"].append({"index": record["index"], "parameter": parameter,
                                                   "reason": "TSI logarithm requires a positive quantified value"})
                continue
            native = record["value"] if parameter == "secchi_depth" else record["value"] * 1000
            if not math.isfinite(native) or native <= 0:
                raise ValueError(f"{parameter} conversion exceeds the supported numeric range")
            score = {"secchi_depth": lambda: 60 - 14.41 * math.log(native),
                     "chlorophyll_a": lambda: 9.81 * math.log(native) + 30.6,
                     "total_phosphorus": lambda: 14.42 * math.log(native) + 4.15}[parameter]()
            eligible.append({"sample_id": record["sample_id"], "sampled_at": record["sampled_at"],
                             "source": record["source"], "method": record["method"],
                             "value": native, "unit": "m" if parameter == "secchi_depth" else "ug/L",
                             "tsi": score})
            used.append(record)
        if eligible:
            score = mean(item["tsi"] for item in eligible)
            component = {"parameter": parameter, "score": score, "count": len(eligible),
                         "category": _tsi_category(score), "samples": eligible,
                         "aggregation": "arithmetic mean of per-sample TSI within this parameter"}
            components.append(component)
            report["steps"].append({"name": f"TSI({parameter})", "equation": TSI_EQUATIONS[parameter],
                                    "inputs": eligible, "result": score})
    for record in measurements:
        if record["parameter"] not in TSI_EQUATIONS:
            report["excluded_inputs"].append({"index": record["index"], "parameter": record["parameter"],
                                               "reason": "parameter is not an input to Carlson TSI"})
    report["components"] = components
    report["limitations"].extend([
        "Carlson TSI describes trophic state. Drinking, swimming, toxin and ecological safety require separate evidence.",
        "Algal biomass relations can be confounded by colored water, non-algal turbidity, and macrophyte-dominated lakes.",
        "The supplied samples define the reporting scope; season, depth and spatial representativeness need field review.",
        "TSI components are prioritized and never averaged with each other. Scores are not clipped to 0–100.",
    ])
    if components:
        primary = components[0]
        report["result"] = {"score": primary["score"], "category": primary["category"],
                            "primary_parameter": primary["parameter"],
                            "label": f"Carlson TSI using {primary['parameter']}",
                            "aggregation": primary["aggregation"]}
        report["status"] = "computed"
    else:
        report["recommendations"].append("Collect a quantified chlorophyll a result, total phosphorus result, or Secchi-disk depth.")
    return used


def _objectives(request):
    supplied = request.get("objectives", [])
    if not isinstance(supplied, list):
        raise ValueError("objectives must be a list")
    result = defaultdict(list)
    expanded = []
    for item in supplied:
        if not isinstance(item, dict):
            raise ValueError("Every objective must be an object")
        if item.get("direction") == "range":
            low = _number(item.get("min_value"), "range minimum")
            high = _number(item.get("max_value"), "range maximum")
            if not 0 < low <= high:
                raise ValueError("A range objective requires 0 < min_value <= max_value")
            expanded.extend([{**item, "direction": "minimum", "value": low},
                             {**item, "direction": "maximum", "value": high}])
        else:
            expanded.append(item)
    for item in expanded:
        if not isinstance(item, dict):
            raise ValueError("Every objective must be an object")
        parameter = _text(item.get("parameter"), "objective parameter")
        direction = item.get("direction")
        if direction not in {"maximum", "minimum"}:
            raise ValueError("Objective direction must be maximum or minimum")
        dimension, unit, factor = _unit(item.get("unit"))
        record = {"parameter": parameter, "direction": direction, "dimension": dimension,
                  "unit": unit, "value": _number(item.get("value"), "objective value") * factor,
                  "reference": _text(item.get("reference"), "objective reference")}
        if not math.isfinite(record["value"]):
            raise ValueError("Objective unit conversion overflows")
        if any(other["direction"] == direction for other in result[parameter]):
            raise ValueError("Duplicate objective direction for one parameter")
        for other in result[parameter]:
            if other["dimension"] != dimension:
                raise ValueError("One parameter's objectives require compatible units")
            lower = record if direction == "minimum" else other
            upper = other if direction == "minimum" else record
            if lower["value"] > upper["value"]:
                raise ValueError("A minimum objective cannot exceed its maximum")
        result[parameter].append(record)
    return dict(result)


def _ccme_category(score):
    for threshold, category in ((95, "excellent"), (80, "good"), (65, "fair"), (45, "marginal")):
        if score >= threshold:
            return category
    return "poor"


def _ccme(report, request, measurements):
    objectives = _objectives(request)
    tests = []
    used = []
    for record in measurements:
        parameter = record["parameter"]
        if parameter not in objectives:
            report["excluded_inputs"].append({"index": record["index"], "parameter": parameter,
                                               "reason": "no objective supplied for parameter"})
            continue
        excursion = 0.0
        for objective in objectives[parameter]:
            if objective["dimension"] != record["dimension"]:
                raise ValueError(f"Measurement and objective units differ for {parameter}")
            value, limit = record["value"], objective["value"]
            if objective["direction"] == "maximum" and value > limit:
                excursion = max(excursion, value / limit - 1 if limit else math.inf)
            if objective["direction"] == "minimum" and value < limit:
                excursion = max(excursion, limit / value - 1 if value else math.inf)
        used.append(record)
        tests.append({"parameter": parameter, "sample_id": record["sample_id"],
                      "sampled_at": record["sampled_at"], "source": record["source"],
                      "value": record["value"], "unit": record["unit"],
                      "failed": excursion > 0, "excursion": excursion if math.isfinite(excursion) else None,
                      "infinite_excursion": not math.isfinite(excursion)})
    report["limitations"].extend([
        "The score is relative to the chosen objectives, parameters, site and period. Objective suitability requires professional review.",
        "2017 guidance recommends 8–20 relevant parameters. The earlier minimum was four parameters sampled four times per year.",
        "Sample identities and times are supplied by the user; the software cannot verify field independence or calibration.",
        "Numeric quantified inputs are required. Censored laboratory results need documented preprocessing before submission.",
    ])
    if not tests:
        report["recommendations"].append("Provide repeated numeric measurements and cited, compatible objectives for each selected parameter.")
        return used
    parameters = {item["parameter"] for item in tests}
    failed_parameters = {item["parameter"] for item in tests if item["failed"]}
    failures = sum(item["failed"] for item in tests)
    f1 = 100 * len(failed_parameters) / len(parameters)
    f2 = 100 * failures / len(tests)
    infinite = any(item["infinite_excursion"] for item in tests)
    nse = math.fsum((item["excursion"] or 0) / len(tests) for item in tests) if not infinite else math.inf
    excursions = nse * len(tests)
    f3 = 100.0 if not math.isfinite(nse) else 100 * (nse / (nse + 1))
    # The manual's rounded divisor can produce a tiny negative at the limiting corner.
    raw_score = 100 - math.hypot(f1, f2, f3) / 1.732
    score = max(0.0, min(100.0, raw_score))
    dates_by_parameter = {parameter: {item["sampled_at"] for item in tests if item["parameter"] == parameter}
                          for parameter in parameters}
    minimum_repeat_count = min(map(len, dates_by_parameter.values()))
    minimum_dataset = len(parameters) >= 4 and minimum_repeat_count >= 4
    preferred_parameter_count = 8 <= len(parameters) <= 20
    exploratory = not minimum_dataset or not preferred_parameter_count
    category = _ccme_category(score)
    report["components"] = [
        {"parameter": "F1_scope", "score": f1, "failed_parameters": len(failed_parameters), "parameters": len(parameters)},
        {"parameter": "F2_frequency", "score": f2, "failed_tests": failures, "tests": len(tests)},
        {"parameter": "F3_amplitude", "score": f3, "nse": nse if math.isfinite(nse) else None,
         "infinite_excursion_limit": not math.isfinite(nse)},
    ]
    report["steps"] = [
        {"name": "Scope", "equation": "F1 = 100 * failed_parameters / parameters", "inputs": [len(failed_parameters), len(parameters)], "result": f1},
        {"name": "Frequency", "equation": "F2 = 100 * failed_tests / tests", "inputs": [failures, len(tests)], "result": f2},
        {"name": "Excursions", "equation": "maximum: value/objective - 1; minimum: objective/value - 1; passing test: 0", "inputs": tests, "result": excursions if math.isfinite(excursions) else "unbounded"},
        {"name": "Amplitude", "equation": "nse = sum(excursions)/tests; F3 = nse/(0.01*nse + 0.01)", "inputs": {"tests": len(tests), "nse": nse if math.isfinite(nse) else "unbounded"}, "result": f3},
        {"name": "Index", "equation": "100 - sqrt(F1**2 + F2**2 + F3**2)/1.732", "inputs": {"F1": f1, "F2": f2, "F3": f3}, "result": score},
    ]
    report["result"] = {"score": score, "category": category,
                        "label": ("Exploratory " if exploratory else "") + "CCME WQI relative to supplied objectives",
                        "exploratory": exploratory, "parameter_count": len(parameters), "test_count": len(tests),
                        "failed_test_count": failures, "failed_parameters": sorted(failed_parameters),
                        "minimum_repeat_count": minimum_repeat_count,
                        "earlier_minimum_4_parameters_4_times_met": minimum_dataset,
                        "preferred_2017_parameter_count_met": preferred_parameter_count,
                        "sample_counts_by_parameter": {parameter: sum(item["parameter"] == parameter for item in tests) for parameter in sorted(parameters)},
                        "objectives": objectives, "tests": tests}
    report["status"] = "computed"
    if exploratory:
        report["recommendations"].append("Expand the relevant parameter set and independent temporal sampling before interpreting this exploratory score as a water-body assessment.")
    if infinite:
        report["limitations"].append("A failed zero denominator uses the mathematical limit of an unbounded excursion, F3 = 100; it remains explicit in the audit.")
    return used


def _distribution(values):
    return {"count": len(values), "minimum": min(values) if values else None,
            "median": median(values) if values else None, "maximum": max(values) if values else None}


def _camera(report, request, summary, rows, measurements):
    imagery = summary.get("imagery", {})
    if not isinstance(imagery, dict):
        raise ValueError("summary.imagery must be an object")
    quality = Counter()
    covers = []
    tds = []
    seen = set()
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError("Each survey row must be an object")
        status = row.get("status", "unknown")
        if not isinstance(status, str):
            raise ValueError("Survey quality status must be text")
        quality[status] += 1
        cover = _row_number(row.get("candidate_green_cover_pct"), "candidate green cover")
        if cover is not None and status == "usable":
            covers.append(cover)
            if covers[-1] > 100:
                raise ValueError("Candidate green cover cannot exceed 100 percent")
        source = row.get("tds_source")
        if source == "simulated" and request.get("simulate_tds") is not None:
            report["excluded_inputs"].append({"row_index": index, "parameter": "tds",
                                               "reason": "superseded by explicit TDS scenario"})
            continue
        value = _row_number(row.get("tds_ppm"), "survey TDS")
        if source not in {"measured", "simulated"} or value is None:
            continue
        timestamp = _row_number(row.get("tds_sample_timestamp_s"), "TDS sample time")
        if timestamp is None:
            timestamp = _row_number(row.get("timestamp_s"), "sample time")
        identity = (source, timestamp)
        if identity in seen:
            continue
        seen.add(identity)
        if source == "simulated" and not request["include_simulated"]:
            report["excluded_inputs"].append({"row_index": index, "parameter": "tds", "reason": "simulated_input_excluded"})
            continue
        tds.append({"value": value, "unit": "ppm", "source": source,
                    "sample_id": str(identity[1]), "sampled_at": None,
                    "method": row.get("tds_method") or "unverified survey-row method",
                    "timestamp_s": identity[1], "provenance": "survey_row"})
    for record in measurements:
        if record["parameter"] != "tds":
            report["excluded_inputs"].append({"index": record["index"], "parameter": record["parameter"],
                                               "reason": "camera/TDS screen uses TDS observations only"})
            continue
        if record["dimension"] not in {"concentration", "ppm"}:
            raise ValueError("TDS screening requires ppm or mg/L/ug/L")
        tds.append({**record, "provenance": "request_measurement"})
    simulation = request.get("simulate_tds")
    if simulation is not None:
        if not request["include_simulated"]:
            raise ValueError("simulate_tds requires include_simulated=true")
        if not isinstance(simulation, dict) or isinstance(simulation.get("seed"), bool) or not isinstance(simulation.get("seed"), int):
            raise ValueError("simulate_tds requires an integer seed")
        baseline = _number(simulation.get("baseline_ppm", 150), "simulation baseline")
        variation = _number(simulation.get("variation_ppm", 10), "simulation variation")
        profile = simulation_metadata(baseline, variation, simulation["seed"])
        for index, row in enumerate(rows or [{"timestamp_s": 0}]):
            timestamp = _row_number(row.get("timestamp_s", index), "sample time")
            if timestamp is None:
                timestamp = float(index)
            value = simulated_tds_value(timestamp, baseline, variation, simulation["seed"])
            tds.append({"value": value, "unit": "ppm", "source": "simulated",
                        "sample_id": f"generated-{index}", "sampled_at": None,
                        "method": profile["name"], "timestamp_s": timestamp,
                        "provenance": "generated_scenario"})
        report["steps"].append({"name": "Simulated TDS", "equation": "max(0, baseline_ppm + variation_ppm * sum(weight * sin(2*pi*t/period + seeded_phase)))",
                                "inputs": profile, "result": "Smooth hypothetical observations evaluated at video timestamps; no field chemistry inferred"})
    distributions = {source: _distribution([item["value"] for item in tds if item["source"] == source])
                     for source in ("measured", "simulated")}
    reference = request.get("tds_reference")
    comparison = {"status": "no_site_reference", "outside_count": None}
    if reference is not None:
        if not isinstance(reference, dict):
            raise ValueError("tds_reference must be an object")
        low = _number(reference.get("min_ppm"), "reference minimum")
        high = _number(reference.get("max_ppm"), "reference maximum")
        if low > high:
            raise ValueError("TDS reference minimum exceeds maximum")
        citation = _text(reference.get("reference"), "TDS reference citation")
        video_source = summary.get("source", {})
        linked_site = request.get("site_id")
        context_verified = bool(linked_site) and (not video_source or
                           (video_source.get("type") == "survey" and video_source.get("site_id") == linked_site))
        if not context_verified and any(item["source"] == "measured" for item in tds):
            comparison = {"status": "site_context_unverified", "outside_count": None,
                          "reference": citation, "min_ppm": low, "max_ppm": high}
        else:
            outside = [item for item in tds if item["value"] < low or item["value"] > high]
            comparison = {"status": "outside_reference" if outside else "within_reference" if tds else "no_observations",
                          "outside_count": len(outside), "reference": citation, "min_ppm": low, "max_ppm": high,
                          "scope": "simulation scenario" if any(item["source"] == "simulated" for item in tds) else "supplied site observations"}
    count = len(rows) if rows else imagery.get("sample_count", 0)
    usable_pct = 100 * quality["usable"] / count if rows else imagery.get("usable_view_pct")
    image_summary = {"sample_count": count, "status_counts": dict(quality) if rows else imagery.get("status_counts", {}),
                     "usable_view_pct": usable_pct, "candidate_green_cover_pct": _distribution(covers),
                     "vegetation_validation": "independent labels required",
                     "aggregation": "selected image views, potentially overlapping"}
    category = "data_gap"
    if covers or tds:
        category = "review" if comparison["status"] == "outside_reference" or any(status != "usable" for status in quality) else "monitor"
    report["result"] = {"score": None, "category": category, "label": "Camera/TDS screening observations",
                        "imagery": image_summary, "tds_ppm": distributions, "tds_reference_comparison": comparison,
                        "lake_health": "insufficient_evidence", "tds_observations": tds}
    report["generated_tds"] = [item for item in tds if item.get("provenance") == "generated_scenario"]
    report["components"] = [{"parameter": "candidate_green_cover_pct", "score": None, **_distribution(covers)},
                            {"parameter": "tds", "score": None, "count": len(tds), "distributions": distributions}]
    report["steps"].extend([
        {"name": "Image summaries", "equation": "candidate green pixels / eligible selected-view pixels * 100", "inputs": {"sample_count": count, "status_counts": dict(quality)}, "result": image_summary},
        {"name": "TDS observations", "equation": "source-separated median and range; no ecological cutoff", "inputs": {"observation_count": len(tds)}, "result": distributions},
        {"name": "Reference screening", "equation": "outside if TDS < supplied minimum or TDS > supplied maximum", "inputs": reference, "result": comparison},
    ])
    report["limitations"].extend([
        "This project screening protocol is not a published water-quality index or a whole-lake health classification.",
        "Candidate green cover requires held-out vegetation reference labels. Image quality cannot supply Secchi depth, NTU or chlorophyll.",
        "TDS expresses dissolved-solids concentration; it cannot identify nutrient species, pathogens, toxins or oxygen availability.",
        "ppm is treated approximately as mg/L for dilute freshwater only. Retain the sensor's native conversion and compensation convention.",
        "Reference-range screening requires site, season, depth and measurement compatibility reviewed by the operator.",
    ])
    report["recommendations"].extend(["Validate candidate cover using independent labeled quadrats.",
                                       "Collect chlorophyll a, total phosphorus, Secchi depth and dissolved oxygen for a broader assessment."])
    if not covers:
        report["missing_inputs"].append("Usable image measurements with an explicitly selected region")
    if not any(item["source"] == "measured" for item in tds):
        report["missing_inputs"].append("Measured TDS with site and calibration context")
    report["missing_inputs"].append("Independent vegetation labels and broader lake-condition measurements")
    if count or tds:
        report["status"] = "computed"
    return tds


def assess(request, summary=None, rows=None):
    """Return a deterministic calculation audit, including missing and excluded evidence."""
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    summary = {} if summary is None else summary
    rows = [] if rows is None else rows
    if not isinstance(summary, dict) or not isinstance(rows, list):
        raise ValueError("summary must be an object and rows must be a list")
    methods = {item["id"]: item for item in catalog()}
    method = request.get("method")
    if method not in methods:
        raise ValueError("Unknown method; choose camera_tds, carlson_tsi or ccme_wqi")
    if "include_simulated" in request and not isinstance(request["include_simulated"], bool):
        raise ValueError("include_simulated must be true or false")
    if request.get("site_id") is not None and not isinstance(request["site_id"], str):
        raise ValueError("site_id must be text")
    canonical = json.dumps({"request": request, "summary": summary, "rows": rows}, sort_keys=True, separators=(",", ":"), allow_nan=False)
    request = {"include_simulated": False, **request}
    entry = methods[method]
    report = {"schema_version": 1, "engine_version": VERSION, "method_id": method, "method_name": entry["name"],
              "status": "insufficient_data", "data_origin": "none", "scenario": False,
              "result": {"score": None, "category": None, "label": "Insufficient eligible measurements"},
              "components": [], "steps": [], "input_summary": {}, "excluded_inputs": [],
              "limitations": [], "recommendations": [], "missing_inputs": [], "assumptions": [],
              "reference_urls": entry["reference_urls"],
              "input_sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest()}
    measurements = _measurements(request, report["excluded_inputs"])
    if request.get("simulate_tds") is not None and method != "camera_tds":
        raise ValueError("simulate_tds is available only for the camera_tds scenario")
    if method == "carlson_tsi":
        used = _carlson(report, measurements)
    elif method == "ccme_wqi":
        used = _ccme(report, request, measurements)
    else:
        used = _camera(report, request, summary, rows, measurements)
    origin = _origin(used)
    if method == "camera_tds" and origin == "none" and report["result"].get("imagery", {}).get("sample_count"):
        origin = "measured"
        report["assumptions"].append("Recorded imagery measures image appearance; source identity and ecological representativeness remain unverified.")
    report["data_origin"] = origin
    report["scenario"] = origin in {"simulated", "mixed"}
    if report["scenario"]:
        report["result"]["label"] = "SIMULATION SCENARIO · " + report["result"]["label"]
        report["limitations"].insert(0, "Simulated inputs are included by explicit request. This result cannot establish the recorded water body's condition.")
    report["input_summary"] = {"site_id": request.get("site_id") or None,
                               "supplied_measurements": len(request.get("measurements", [])),
                               "used_observations": len(used), "excluded_observations": len(report["excluded_inputs"]),
                               "origins": dict(Counter(record["source"] for record in used)),
                               "input_survey_rows": len(rows), "include_simulated": request["include_simulated"],
                               "declared_period": request.get("period"), "declared_context": request.get("context"),
                               "provenance_verification": "User-supplied sample metadata; external verification required"}
    if report["status"] == "insufficient_data" and not report["missing_inputs"]:
        report["missing_inputs"] = entry["required_inputs"]
    report["assumptions"].extend(["Measurement and objective values are nonnegative quantified observations in the stated units.",
                                   "The named site, sampling scope and methods are supplied by the operator.",
                                   "All eligible submitted samples are included; period/context fields annotate the audit and do not filter data."])
    json.dumps(report, allow_nan=False)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", action="store_true")
    parser.add_argument("--input", type=Path, help="JSON envelope; otherwise read stdin")
    parser.add_argument("--output", type=Path, help="New JSON output file; otherwise write stdout")
    args = parser.parse_args(argv)
    try:
        if args.catalog:
            result = catalog()
        else:
            envelope = json.loads(args.input.read_text(encoding="utf-8-sig") if args.input else sys.stdin.read())
            if not isinstance(envelope, dict) or "request" not in envelope:
                raise ValueError("Expected an object containing request, with optional summary and rows")
            result = assess(envelope["request"], envelope.get("summary"), envelope.get("rows"))
        encoded = json.dumps(result, indent=2, allow_nan=False) + "\n"
        if args.output:
            with args.output.open("x", encoding="utf-8") as stream:
                stream.write(encoded)
        else:
            sys.stdout.write(encoded)
    except (OSError, ValueError, TypeError, OverflowError) as error:
        parser.exit(1, f"assessment: {error}\n")


if __name__ == "__main__":
    main()
