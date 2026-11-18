# Validation evidence

Reviewed 17 November 2026.

## Reproducible software and stock-media run

Run `python -m manta_ray.verify --media media --output outputs/a-new-run` from the repository environment. The saved verification in `outputs/verification-2026-11-17/` contains the commands, test log, input hashes, source digest, CSV measurements, masks, overlays, and JSON summaries. A separate `artifact-integrity.json` records mask and PNG decoding checks.

All 33 software tests passed in the repository checkout. After integrating native COLMAP logging and provenance, the final suite passed again in 24.469 seconds. The final log is `final-test-output.txt`, with the tested source digest in `final-source.json`. The suites cover seven connectivity tests, two initial ecology tests, six video-and-sensor integration tests, ten metric/provenance/evaluator tests, and eight reconstruction tests.

| Experiment | Result | What the result establishes |
| --- | --- | --- |
| Known 25% green patch, dark view, and zero-green view in one video | 25% candidate cover, missing coverage on the rejected dark view, and 0% on the usable zero-green view | Video decoding, screening, arithmetic, and missing-data distinction |
| Analytical image areas at 0%, 10%, 25%, 50%, and 75%, with and without padding | Exact expected candidate fractions in controlled fixtures | Area-fraction calculation and transparent-padding denominator |
| Half-green image cropped to full, left, and right regions | Approximately 50%, 100%, and 0% | Selected-region denominator through the normal CLI |
| Independently specified masks with equal cover but displaced plant pixels | Cover error 0 percentage points; precision 0.5, recall 0.5, IoU 1/3 | Mask errors remain visible when total-area agreement hides them |
| Brown and blue-tinted plant proxies; green artificial patch | Color ambiguity preserved in explicit regression tests | Known limitations of the color rule |
| Measured, simulated, missing, wrong-site, and incompatible-method TDS cases | Timestamp matching and exclusions passed; unmatched measurements excluded from matched median | Provenance and comparison logic |
| Twelve simultaneous stop commands | Exactly one acceptance | Concurrent idempotence |
| Stop command with real elapsed time | Zero forward speed and arrival at 0 m after four seconds | Demo controller and receiver handoff |
| Seventeen malformed request cases, truncated bodies, and a five-second body timeout | Vehicle remained surveying | Invalid input cannot trigger the demo command |
| Invalid videos, past-end extraction, empty models, stage failures, malformed models, and PLY header failures | Expected failures and retained diagnostic manifests | Failure-path handling |

These fixtures establish software behavior. Real ecological accuracy requires independent annotations and sensor reference measurements.

## Supplied stock clips

Both files were processed without playing the videos or displaying any frames.

| Clip | Original image size | Duration | Ecology views | Extracted reconstruction views |
| --- | --- | --- | --- | --- |
| `14396264_1920_1080_60fps.mp4` | 1920 by 1080 | 9.470 s | 19 | 29 |
| `16770126_2160_3840_60fps.mp4` | 2160 by 3840 | 8.025 s | 17 | 25 |

All 36 masks passed format, dimension, and valid-pixel checks. All eight exported PNG overlays decoded successfully. CSV counts agreed with summaries. Every demo TDS value was labeled simulated and excluded from site-reference comparisons.

The portrait clip had reserved color metadata. Reports preserve the source tags and record the BT.709 fallback. Reconstruction extraction limits image dimensions while preserving aspect ratio to avoid the observed full-resolution encoding failure. Neither clip has ground-truth masks, verified site context, or actual water chemistry.

## Actual COLMAP reconstruction

With user approval, the official portable COLMAP 4.2.1 CPU release was downloaded from [the COLMAP release](https://github.com/colmap/colmap/releases/tag/4.2.1). The 127,731,595-byte archive matched GitHub's published SHA-256 of `c493d88cb4a43f21afba42cb55bf786e5434a0420e73db0ba1454c5d8b3686ae`. Download provenance is retained in `.tools/colmap-source.json`.

Both clips completed actual CPU feature extraction, matching, incremental mapping, model analysis, and PLY export using 3 fps, at most 30 frames, and a maximum image dimension of 1000.

| Clip | Registered views | Sparse points | Observations | Mean track length | Mean reprojection error |
| --- | --- | --- | --- | --- | --- |
| `14396264_1920_1080_60fps.mp4` | 29 / 29 | 14,273 | 128,643 | 9.013032 | 0.498299 px |
| `16770126_2160_3840_60fps.mp4` | 25 / 25 | 8,923 | 81,464 | 9.129665 | 0.356076 px |

Artifacts are saved under `outputs/colmap-validation-817db1d1d7634fefb8ce547443db5347/`, with one directory per clip. Each has `reconstruction.json`, `point-cloud.ply`, sparse binary models, and COLMAP logs. The landscape run also has separately identified cached-stage replay logs.

A second check ran COLMAP's model analyzer on each selected model, checked binary image/point counts, matched source hashes, verified both PLY headers and complete binary payload sizes, and checked every exported coordinate for finiteness. Results are in `independent-checks.json`. No images or point clouds were displayed.

Reproduce a full run using a new output directory:

```powershell
uv run --locked --offline --no-python-downloads python -m manta_ray.reconstruction media/14396264_1920_1080_60fps.mp4 --colmap .tools/colmap/bin/colmap.exe --fps 3 --max-frames 30 --max-size 1000 --output outputs/real-reconstruction-new
```

Registration and reprojection error describe internal reconstruction consistency. Physical scale, accuracy against a geometric reference, and the ecological identity of reconstructed features remain unverified.
## Interpretation and remaining validation

Candidate-green cover remains an image screening measurement. The vegetation-cover fields remain missing until independent reference labels support a vegetation estimate. Image-quality checks cannot establish calibrated turbidity, chlorophyll concentration, or lakebed visibility. The reports retain an insufficient-evidence status for overall lake health.

Physical prototypes, field performance, economics, and environmental effects require additional validation.
