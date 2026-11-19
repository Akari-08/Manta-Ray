"""A smooth, bounded hypothetical TDS profile for reproducible demonstrations."""

import math
import random

PROFILE_NAME = "smooth_harmonic_tds_v1"
PERIODS_SECONDS = (48.0, 19.0, 7.0)
WEIGHTS = (0.55, 0.30, 0.15)


def _nonnegative(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite nonnegative number")
    if not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be a finite nonnegative number")
    return float(value)


def simulation_metadata(baseline_ppm=150, variation_ppm=10, seed=42):
    """Return the complete profile parameters independently of sample order."""
    baseline = _nonnegative(baseline_ppm, "simulated TDS baseline")
    variation = _nonnegative(variation_ppm, "simulated TDS variation")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("simulated TDS seed must be an integer")
    if not math.isfinite(baseline + variation):
        raise ValueError("simulated TDS upper bound exceeds the supported numeric range")
    return {"name": PROFILE_NAME, "baseline_ppm": baseline, "variation_ppm": variation,
            "seed": seed, "periods_seconds": list(PERIODS_SECONDS), "weights": list(WEIGHTS),
            "bounds_ppm": [max(0.0, baseline - variation), baseline + variation],
            "source": "simulated", "interpretation": "Hypothetical demonstration profile; no field chemistry inferred"}


def simulated_tds_value(timestamp_s, baseline_ppm=150, variation_ppm=10, seed=42):
    """Evaluate a seed-fixed profile at elapsed video time, without mutable RNG state.

    Weighted sinusoids model gradual hypothetical drift and smaller variations.
    Their weights sum to one, guaranteeing the configured concentration bounds.
    The function is a demonstration signal, with no claimed hydrological fit.
    """
    timestamp = _nonnegative(timestamp_s, "simulated TDS timestamp")
    profile = simulation_metadata(baseline_ppm, variation_ppm, seed)
    phases = random.Random(seed)
    variation = math.fsum(
        weight * math.sin(math.tau * (timestamp % period) / period + math.tau * phases.random())
        for period, weight in zip(PERIODS_SECONDS, WEIGHTS)
    )
    concentration = profile["baseline_ppm"] + profile["variation_ppm"] * variation
    low, high = profile["bounds_ppm"]
    return max(low, min(high, concentration))
