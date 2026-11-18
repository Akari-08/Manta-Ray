# Survey software guide

Run commands from the repository root with the existing uv environment. FFmpeg and FFprobe are required for video processing. Full reconstruction also requires an installed COLMAP executable.

## Research and evidence

The [scientific method](scientific-method.md) explains the indicators, sources, sampling design, and validation limits.

## Analyze survey imagery

```powershell
uv run --locked --offline --no-python-downloads python -m manta_ray.ecology media/14396264_1920_1080_60fps.mp4 --video-source stock --interval 0.5 --simulated-tds-ppm 150 --output outputs/survey-01
```

Each run produces `survey.csv`, `summary.json`, `report.md`, sampled PNG overlays, and PGM prediction masks. Input SHA-256, video metadata, FFmpeg version, exact parameters, and runtime are recorded. Each output directory must be new.

The detector reports `candidate_green_cover_pct`, the green-pixel fraction of the selected image region. The `vegetation_cover_pct` field remains blank because independent vegetation labels are unavailable. The summary reports the median and range across usable sampled views. Adjacent frames can observe the same patch, so this aggregation describes the views rather than lakewide area.

Image-quality measurements include median luma, P90-P10 contrast, dark and clipped pixel percentages, and mean adjacent-pixel gradient. The configurable brightness and contrast gates flag `too_dark` or `low_contrast` samples. Passing these gates means only that those two checks passed. It does not establish visible lakebed, suitable focus, or ecological accuracy. Masks are exported for all sampled views so failure cases can also be evaluated.

Set `--roi x,y,width,height` using normalized coordinates to select a rectangular region. For example, `--roi 0.1,0.2,0.8,0.6` selects an inner region. Add `--confirm-bottom-roi` only after an operator confirms that region shows the bottom. The report records that declaration. Transparent letterbox padding is excluded from the denominator. With no ROI, the analysis uses the full view and leaves bottom confirmation false.

Use `--start`, `--duration`, `--interval`, and `--max-samples` to control processing. Timestamps use the original clip timeline on a regular resampled grid. They represent sampled video times and can differ from sensor timestamps. Repeated areas remain correlated. Thresholds are available through `--help`.

The supplied portrait video contains reserved color tags. The processor records a BT.709 fallback for those tags so FFmpeg can decode and scale it. This assumption is retained in the report and needs verification before using camera color quantitatively.

## TDS observations

TDS is absent by default. `--simulated-tds-ppm` adds an explicitly labeled constant for a demonstration. The older `--tds-ppm` option is an alias. Simulated readings are excluded from reference comparisons.

Use `--tds-csv` to supply time-aligned observations. The header is:

```csv
timestamp_s,tds_ppm,source,site_id,calibration_id,method,temperature_c
```

Each source must be `measured` or `simulated`. Timestamps are nonnegative unique seconds relative to the original clip. TDS values must be finite and nonnegative. Temperature may be blank. Calibration and method may be blank, in which case reference comparisons remain unavailable. Use ppm in the sensor's original convention. It approximates mg/L for dilute freshwater.

For measured observations, supply `--site-id` matching every measured row. The nearest sample within `--tds-tolerance` seconds is joined to each view, with its original timestamp and signed offset retained. The default tolerance is 0.5 seconds. Unmatched views remain missing. The input-dataset summary includes all supplied observations. A separate matched median counts each matched measured timestamp once.

A user-supplied reference JSON can be passed with `--tds-reference`:

```json
{
  "site_id": "your-site-id",
  "min_ppm": 100,
  "max_ppm": 200,
  "method": "your-documented-temperature-compensated-method",
  "reference": "identify the actual source of the site range",
  "context": "record the season, depth, calibration, units and intended comparison"
}
```

The numbers above demonstrate the format. Select a reference from appropriate site observations or an applicable monitoring program. The software checks site and method compatibility. A measured reading with supplied calibration metadata and `--video-source survey` can be flagged inside or outside the supplied range. Calibration accuracy and context compatibility still require review. A stock clip's site remains unverified. A departure is a screening observation requiring investigation. The software reports overall lake condition as `insufficient_evidence`.

## Evaluate vegetation labels

Create independent plant masks for reference frames, using identical crop, scale, and padding. Binary P5 PGM masks use 255 for plant, 0 for background, and 128 for excluded or ambiguous areas. The prediction masks use the same convention. A prediction cannot exclude a pixel labeled by the reference.

Create an annotation CSV with paths relative to that CSV:

```csv
clip_id,split,prediction,reference,label_source
session-A,test,../outputs/survey-01/masks/frame_000000.pgm,labels/frame_000000.pgm,annotator-and-date
```

```powershell
uv run --locked --offline --no-python-downloads python -m manta_ray.ecology.validate annotations/labels.csv --output outputs/label-evaluation.json
```

The evaluator reports coverage MAE and bias in percentage points, per-frame precision/recall/IoU, pooled confusion counts, and reference/prediction hashes. Undefined denominators produce JSON null. It rejects declared clip IDs shared between train and test splits, duplicate predictions, and a prediction reused as its own reference. The dataset author must group related scenes and record independent labels correctly.

Report image rejection rate alongside accuracy and include rejected samples in the evaluation design. Synthetic geometry tests establish arithmetic and expose known color ambiguities. Real held-out vegetation accuracy remains unmeasured until independent annotations exist.

## Lakebed reconstruction

```powershell
uv run --locked --offline --no-python-downloads python -m manta_ray.reconstruction media/14396264_1920_1080_60fps.mp4 --extract-only --output outputs/reconstruction-01
```

Extraction records source metadata, color fallbacks, unique grayscale frames, contrast, clipping, and edge-strength proxies without displaying frames. Images retain aspect ratio and use a maximum dimension of 1600 by default. Use `--max-size`, `--start`, `--duration`, `--fps`, and `--max-frames` as needed. These proxies cannot establish sufficient overlap or camera translation.

Remove `--extract-only` to run an installed COLMAP. The approved portable release is available through `--colmap .tools/colmap/bin/colmap.exe`. It is kept outside Git alongside its download source and archive checksum. Use `--colmap` for other executable locations. The pipeline performs feature extraction, sequential matching, sparse mapping, and PLY export. It reports detected keypoints, verified image pairs, registered-frame fraction, point count, and model-analyzer statistics. Per-stage COLMAP logs are retained. A later reconstruction failure retains extracted frames and a failure manifest. Failed extraction publishes no run directory.

The sparse cloud has arbitrary scale until a known reference establishes scale. Actual registration and geometric accuracy need verification. Real COLMAP runs on both supplied clips are documented in the [validation evidence](validation-report.md). Internal registration and reprojection measurements require geometric reference checks before interpreting physical accuracy.

## Stop and surface

```powershell
uv run --locked --offline --no-python-downloads python -m manta_ray.connectivity
```

In a second terminal:

```powershell
$receiver = 'http://127.0.0.1:8765'
Invoke-RestMethod "$receiver/status"
Invoke-RestMethod "$receiver/commands" -Method Post -ContentType 'application/json' -Body '{"command":"STOP_AND_SURFACE"}'
Invoke-RestMethod "$receiver/status"
```

The local receiver returns HTTP 202 on first acceptance and HTTP 200 on retries. Its demo vehicle starts at 2 m depth and surfaces at 0.5 m/s. Status records `command_received`, `forward_motion_stopped`, and `surface_reached`. Poll after four seconds to observe arrival. To connect the mission simulator, implement `VehicleController` from `manta_ray.connectivity.receiver` and pass it to `create_server`.

## Reproduce verification

```powershell
uv run --locked --offline --no-python-downloads python -m unittest discover -s tests -v
uv run --locked --offline --no-python-downloads python -m manta_ray.verify --media media --output outputs/verification-01
```

The verification runner saves test output, a source-code digest, per-clip input hashes, ecology reports, reconstruction preprocessing reports, workflow commands, and `results.json`. It processes supported files in the media folder without playing them or displaying frames. It injects 150 ppm simulated TDS for the stock-media demonstration. Choose a new output path when rerunning.

The media files have unknown ecological labels. Record their original URLs, licenses, and author credits when distributing the footage or presenting results.
