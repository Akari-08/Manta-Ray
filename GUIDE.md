# Setup and operation

[Project overview](README.md) · [Scientific methods and evidence](research.md)

Use this guide for [setup](#local-setup), [recorded surveys](#recorded-surveys), [assessment inputs](#assessment-inputs), [APIs](#backend-interfaces), [hardware](#esp32-hardware), and [verification](#verification). Commands use PowerShell from the repository root unless stated otherwise.

## Local setup

Python 3.11+ has no third-party package dependencies. Use installed tools:

```powershell
uv sync --locked --offline --no-python-downloads
uv run --locked --offline --no-python-downloads python -c "import manta_ray.ecology, manta_ray.reconstruction, manta_ray.connectivity"
```

Without uv, create `.venv` with `python -m venv .venv` and replace the `uv run ... python` prefix below with `.\.venv\Scripts\python.exe`.

The dashboard requires Node.js 22+. If its locked packages are already installed:

```powershell
cd web_dashboard
npm.cmd run demo
```

On a fresh checkout, `npm.cmd ci` installs the versions in `package-lock.json`. It can download packages. For a Windows certificate-chain error, use `$env:NODE_OPTIONS='--use-system-ca'` in that terminal; retain certificate verification. Video processing requires FFmpeg/FFprobe on PATH. Full reconstruction requires an installed COLMAP; the local portable executable is `.tools/colmap/bin/colmap.exe`.

The demo opens at [127.0.0.1:3000](http://127.0.0.1:3000) and needs ports 3000, 8765, 8080 and 8081. `PORT` and `SITL_PORT` can override the first two. Ctrl+C stops the launcher's owned services. It creates an ignored `.env` only if absent, preserving existing credentials. Demo authorization is held in browser memory and restricted to the local simulator; hardware is rejected in this mode. **Enable controls** starts a heartbeat, not motion.

For a manually managed server, copy `web_dashboard/.env.example` to `.env` only if absent. Generate two different secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, assign them to `DEVICE_TOKEN` and `CONTROL_TOKEN`, keep `HOST=127.0.0.1`, and set `ALLOW_SIMULATOR=1`. Run `npm.cmd start` and `npm.cmd run simulate` in separate dashboard terminals. This mode requires entering the control token. Never commit `.env` or firmware secrets.

## Recorded surveys

Place clips in `media/` or `data/input/`. In **Recorded surveys**, select a saved run or submit a registered clip for image analysis, reconstruction, or both. One processing job runs at a time. Run labels include interval, region, sample count and ID: different runs of the same clip can have different medians. The reconstruction list hides extraction-only records when a matching completed model exists.

Reports, CSVs, masks and PLY files are downloadable. Source videos and overlays do not load automatically. The displayed simulated-TDS scenario has its own CSV; original saved CSVs remain available and can contain older constant demo values. Aquatic-life measurements currently show **not assessed** because detection, tracking and species identification are unimplemented.

### Analyze a video

```powershell
uv run --locked --offline --no-python-downloads python -m manta_ray.ecology media/14396264_1920_1080_60fps.mp4 --video-source stock --interval 0.5 --simulated-tds-ppm 150 --output outputs/survey-01
```

Use a new output directory for each run. Outputs are `survey.csv`, `summary.json`, `report.md`, `assessment.json`, PNG overlays and PGM masks. Reports retain source SHA-256, video metadata, parameters and processing provenance. The processor samples frames numerically; no playback is required.

`candidate_green_cover_pct` is a green-pixel fraction, not validated plant cover. `vegetation_cover_pct` remains missing. Brightness/contrast gates distinguish rejected images from usable zero-green views. Passing these gates does not establish visible bottom or ecological accuracy. See the [research definitions](research.md#supported-observations).

Use `--start`, `--duration`, `--interval`, `--max-samples` and `--overlay-every` to control processing. `--roi 0.1,0.2,0.8,0.6` selects a normalized x/y/width/height rectangle. Use `--confirm-bottom-roi` only after an operator checks the region; it records a declaration. Letterbox padding is excluded. All timestamps refer to the original clip. The supplied portrait clip uses a recorded BT.709 fallback for reserved color tags; this does not calibrate color.

### Supply TDS

TDS is absent unless supplied. `--simulated-tds-ppm 150` sets a profile baseline, with default variation 10 ppm and seed 42. Change these with `--simulated-tds-variation` and `--simulated-tds-seed`; `--tds-ppm` is a baseline alias. The smooth, repeatable series is hypothetical and excluded from measured-site comparisons.

Alternatively, `--tds-csv observations.csv` accepts:

```csv
timestamp_s,tds_ppm,source,site_id,calibration_id,method,temperature_c
```

Use finite nonnegative TDS and unique nonnegative clip-relative timestamps. `source` is `measured` or `simulated`; temperature may be blank. Measured rows must match `--site-id`. The nearest reading within `--tds-tolerance` (default 0.5 seconds) is joined with its original timestamp and signed offset. Missing matches stay missing; repeated joins count once in the matched measured median.

For a site comparison, `--tds-reference reference.json` takes the following shape. These numbers are placeholders, not lake-health limits:

```json
{
  "site_id": "your-site",
  "min_ppm": 100,
  "max_ppm": 200,
  "method": "your-documented-method",
  "reference": "citation for the actual site baseline",
  "context": "season, depth, calibration, units and purpose"
}
```

Comparisons require compatible site/method, measured values with calibration metadata, and `--video-source survey`. Metadata is not independently verified. Stock location and simulated readings cannot establish a site comparison.

### Reconstruct a patch

```powershell
uv run --locked --offline --no-python-downloads python -m manta_ray.reconstruction media/14396264_1920_1080_60fps.mp4 --colmap .tools/colmap/bin/colmap.exe --fps 3 --max-frames 30 --max-size 1000 --output outputs/model-01
```

`--extract-only` skips COLMAP. Extraction supports `--start`, `--duration`, `--fps`, `--max-frames` and `--max-size`; images retain aspect ratio. Full runs perform feature extraction, sequential matching, sparse mapping, model analysis and PLY export. Per-stage logs and provenance are retained. Later reconstruction failures retain frames and a failure manifest. Extraction failures publish no run directory. Internal reprojection error does not establish physical accuracy; scale needs a known reference.

## Assessment inputs

The dashboard method selector explains each method, required inputs and limitations. The [research document](research.md#assessment-methods) defines the equations and interpretation. The standalone engine accepts an envelope with `request`, optional saved `summary`, and optional CSV-style `rows`:

```powershell
uv run --locked --offline --no-python-downloads python -m manta_ray.ecology.assessment --catalog
uv run --locked --offline --no-python-downloads python -m manta_ray.ecology.assessment --input request.json --output assessment.json
```

`--catalog` provides runnable simulated examples. Output files must be new. A minimal scenario envelope is:

```json
{
  "request": {
    "method": "carlson_tsi",
    "site_id": "example-site",
    "include_simulated": true,
    "measurements": [{
      "parameter": "chlorophyll_a", "value": 20, "unit": "ug/L",
      "source": "simulated", "method": "demonstration scenario",
      "sample_id": "demo-1", "sampled_at": "2026-06-01"
    }]
  }
}
```

Methods are `camera_tds`, `carlson_tsi` and `ccme_wqi`. Measurements require all fields shown above; sources are `measured` or `simulated`. Values must be finite and nonnegative; Carlson values must be positive. Duplicate parameter/sample identities are rejected. Concentration conversion supports mg/L, ug/L and ng/L; Secchi depth supports m/cm. CCME keeps ppm and mg/L distinct, and other units must match exactly. Nitrate-ion and nitrate-as-nitrogen measurements need distinct parameter identities.

CCME `objectives` require `parameter`, `unit`, `reference`, and `direction: "maximum"` or `"minimum"` with `value`. A `"range"` takes positive ordered `min_value`/`max_value`. Censored results such as `<0.05` need documented preprocessing; they are not exact numeric observations. `period` and `context` annotate the audit and do not filter samples.

Simulated inputs are excluded by default. Opting in labels results **SIMULATION SCENARIO**, including mixed inputs. Camera/TDS scenarios accept `simulate_tds: {"seed":42,"baseline_ppm":150,"variation_ppm":10}`. Generation supersedes earlier simulated survey rows with an audit exclusion and preserves measured observations. The graph, table and scenario CSV use the same generated series.

For assessment during video processing, add `--assessment-method`, `--assessment-input` and optionally `--include-simulated-assessment`. **That input file contains only the request object**, unlike the standalone engine's envelope.

Audits retain equations, intermediate results, missing/excluded evidence, method/engine version, references, source labels and a canonical input SHA-256. User-supplied provenance and objectives require professional review.

## Backend interfaces

| Route | Purpose |
| --- | --- |
| `GET /api/surveys` | Registered clips and saved image/reconstruction runs |
| `GET /api/surveys/ecology/:id` | Summary, rows and artifact links |
| `GET /api/surveys/reconstruction/:id` | Reconstruction report and PLY |
| `POST /api/surveys/analyze` | Submit `{clip_id, mode, simulated_tds_ppm?}`; mode is `ecology`, `reconstruction` or `both` |
| `GET /api/surveys/jobs/:id` | Stage, status, partial output or error |
| `GET /api/ecology/methods` | Method catalog and examples |
| `GET/POST /api/surveys/ecology/:id/assessment` | Calculate a selected method; POST persists the request/report |
| `GET /api/ecology/assessments/:id` | Persisted report; append `/request` or `/audit` for inputs/integrity |
| `GET /api/sitl/status` | Separate simulated depth, speed and events |
| `POST /api/sitl/stop-and-surface` | Fresh-simulator-only surfacing handoff |
| `GET /api/state`, `/api/history`, `/api/cv`, `/api/camera/frame` | Live state, bounded history, worker results and JPEG |
| `POST/DELETE /api/control/heartbeat` | Acquire/renew or release operator control |
| `POST /api/commands`, `GET /api/commands/:id` | Send a command and retrieve its acknowledgement |
| `POST /api/cv/result` | Submit a worker result tied to a recent issued frame |

Mutation routes and command status require the control bearer token. Read-only assessment queries use `method=...`; simulation requires explicit opt-in (`include_simulated=1`, optionally `simulate_tds=1`). Registered IDs prevent arbitrary file/shell access. Processing jobs save under `outputs/dashboard-surveys/`; assessment audits under `outputs/ecological-assessments/`. The persisted wrapper hash and engine's canonical-envelope hash use different serialization schemes and are checked separately.

### Telemetry and commands

[`web_dashboard/protocol.js`](web_dashboard/protocol.js) is the strict schema contract; [`docs/telemetry-example.json`](docs/telemetry-example.json) shows a complete labeled example. Device publishing uses `/ws/device`, browser updates `/ws/live`. Protocol changes require coordinated firmware/backend/client updates.

A device authenticates within three seconds with `{"schema_version":1,"type":"hello","robot_id":"manta-01","source":"hardware","token":"DEVICE_TOKEN"}`. The welcome supplies a new `session_id`. Only one device may publish; sequence increases and uptime never decreases within a session. Readings carry `value`, exact `unit` and `reason`; unavailable readings are null with a reason. Schema, identity, IMU, water, control, camera and fault fields are validated. TDS estimates require a calibration ID. Commanded angles are not servo feedback; device uptime and backend UTC receipt time are distinct.

Telemetry is intended at 10 Hz; messages are limited to 16 KiB and 40/second. State becomes stale after two seconds; five seconds without valid telemetry terminates the device session. History is memory-only, bounded to 600 samples and reset per session. A browser socket connection alone does not mean the robot is live.

Control uses distinct device/control secrets of at least 24 characters. Renew the two-second operator lease every 500 ms. The device accepts movement only with a matching-session active heartbeat. Commands have a unique ID, schema version, action, arguments and TTL of 200–2000 ms. Example:

```json
{"schema_version":1,"id":"unique-command-uuid","action":"set_fin","args":{"amplitude_deg":20,"cycle_hz":0.5,"centre_deg":135},"ttl_ms":1500}
```

Actions are `set_fin`, `set_syringe`, `start` and `stop`. Only one command may be pending. HTTP 202 means sent, not applied. Device outcomes are `applied`, `rejected` or `expired`; disconnect/timeout leaves physical outcome unknown. No automatic motion retries or reconnect replay occur. Applied means controller acceptance, not measured motion. Stop needs authentication, fresh telemetry and valid expiry, but no active operator lease.

The dashboard command log supports `setfin amplitude 20`, `setfin cr 0.5`, `setfin center 135`, `setsyringe 90`, `startflap` and `stopflap`. Partial fin updates preserve other fresh settings and wait for reflected telemetry before the next change. `commands.mjs` exposes a parser/builder for adapters, not an MCP server or authorization layer.

### Camera, position and surfacing

`npm.cmd run sample-camera` saves a current JPEG and provenance to `outputs/live-camera/`. The camera API bounds captures to 256 KiB, two concurrent fetches, fixed authenticated-peer URLs and no redirects. `X-Frame-Metadata` includes frame/session ID, source, capture uptime, receipt time and calibration ID. A live CV worker must submit frame ID, method, calibration ID, confidence 0–1 and cover 0–100 within five seconds. This interface does not implement or validate a biological model.

The map shows **browser location**, not robot GPS. Online OpenFreeMap tiles load only after location permission; internet and WebGL are required. Browser geolocation generally requires localhost or HTTPS. The 3D vehicle illustrates sensor estimates: acceleration includes gravity, roll/pitch assume sensor alignment, relative yaw drifts, and fin phase is estimated. GPS, hardware depth, battery voltage, compass heading and measured servo feedback are unavailable. The current protocol does not implement two-stick steering or reverse.

The demo's stop-and-surface first obtains a fin-stop acknowledgement, then commands the separate Python depth model. To run that model alone:

```powershell
uv run --locked --offline --no-python-downloads python -m manta_ray.connectivity
# In another terminal:
Invoke-RestMethod http://127.0.0.1:8765/commands -Method Post -ContentType 'application/json' -Body '{"command":"STOP_AND_SURFACE"}'
Invoke-RestMethod http://127.0.0.1:8765/status
```

It starts at 2 m and surfaces at 0.5 m/s, emitting command received, motion stopped and surface reached. First acceptance is 202; retries are 200. Integrate a mission simulator through `VehicleController` and `create_server` in `manta_ray/connectivity/receiver.py`.

## ESP32 hardware

Target: Freenove **ESP32-WROVER**, classic dual-core ESP32 with PSRAM. Verified build target: Arduino-ESP32 3.3.3, ArduinoJson 7.3.2 and Links2004 WebSockets 2.7.2. No ESP32Servo library is used. Installation commands below download dependencies if absent:

```powershell
arduino-cli core install esp32:esp32@3.3.3 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli lib install ArduinoJson@7.3.2 WebSockets@2.7.2
arduino-cli compile --fqbn esp32:esp32:esp32wrover firmware/manta_ray
```

Copy `secrets.example.h` and `local_config.example.h` to their ignored local equivalents in `firmware/manta_ray/`. Inspect wiring, calibration and actual serial port before uploading. In Arduino IDE select ESP32 Wrover Module, PSRAM enabled and default 4 MB partitions.

For hardware, stop simulation, set `ALLOW_SIMULATOR=0`, bind `HOST` to the computer's specific private Wi-Fi IPv4, and use that address as firmware `BACKEND_HOST`. Match port, robot ID and device token; connect both devices to the same 2.4 GHz network. If needed, restrict the Windows firewall allowance to the Private profile/local subnet. This HTTP/WS protocol is for a trusted isolated LAN, not Internet exposure; it has bearer authentication but no transport encryption. No firewall rules are created automatically.

### Pins and calibration

[`config.h`](firmware/manta_ray/config.h) is the source for pins, limits, trims and timing. Check the board revision and [hardware references](research.md#engineering-references) before wiring.

| Peripheral | Assignment / constraint |
| --- | --- |
| Camera D0–D7 | GPIO 4, 5, 18, 19, 36, 39, 34, 35 |
| Camera timing / SCCB | XCLK 21, PCLK 22, VSYNC 25, HREF 23, SDA 26, SCL 27; PWDN/reset -1 |
| Fin drives | GPIO13/14; MCPWM group 0, 1 MHz timer, 20,000 ticks, 50 Hz |
| MPU6050 | SDA32/SCL33, address 0x68; I2C controller opposite camera SCCB (controller 0 with verified core) |
| Syringe | Disabled (-1); GPIO15 is only a candidate after actuator/boot-pin audit |
| Water sensors | No TDS ADC assigned; camera/MPU occupy exposed ADC1 inputs, ADC2 conflicts with Wi-Fi |

Camera XCLK uses LEDC timer 0/channel 0 at 20 MHz; preserve the independent MCPWM allocation. GPIO6–11 are flash-reserved, 16/17 PSRAM-reserved, 34–39 input-only, 1/3 UART, and 0/2/5/12/15 boot strapping pins. Adding SD/JTAG or an external ADC requires a new pin/interface audit. Use a load-sized separate servo supply and common ground; the ESP32 rail/USB regulator is not a servo supply.

Fin outputs default disabled and emit no startup pulses. Provisional DS3218 270° endpoints (500–2500 µs) must be verified unloaded for center, direction, trims and safe travel before enabling. PWM starts only on explicit start. Limits are amplitude 0–45°, cycle 0.1–2 Hz, center 90–180°, with a nominal 45–225° envelope including firmware checks. Syringe commands need model-specific calibrated limits within 0–180°; no target means no syringe PWM.

MPU readings use ±2 g (16384 counts/g), ±250°/s (131 counts/°/s), 100 Hz sampling and a 10 ms I2C timeout. Acceleration includes gravity in sensor axes. Roll/pitch are gravity estimates, not a navigation filter; chip temperature is not water temperature. Implement `water_adapter.h` only after confirming sensor model, voltage, ADC, calibration and temperature compensation. Missing/faulted readings return NAN with a reason; calibration IDs record provenance rather than guaranteed accuracy.

### Disconnect behavior

Fin control runs separately at 100 Hz on core 1; networking/camera use core 0. Bounded queues discard stale data; reconnect never replays motion. The default firmware stops the phase oscillator after three seconds without active heartbeat. Combined with the backend's two-second lease, browser loss stops flapping within roughly five seconds plus scheduling jitter. Fins hold their last commanded positions; **software stop does not cut electrical power**.

Syringe disconnect behavior holds the last target and does not automatically extend/retract. Verify that policy mechanically. `MANTA_STOP_ON_TIMEOUT=0` explicitly opts into continued local flapping; it does not implement route-following autonomy. Hardware power isolation, loaded timing, brownouts, wet operation and underwater Wi-Fi remain unvalidated.

Camera uses QVGA JPEG, two PSRAM buffers and latest-frame capture. Hardware snapshot/stream URLs are `http://ESP32_IP/capture` and `http://ESP32_IP:81/stream`; simulator ports are 8080/8081. Failed initialization retries every five seconds; FPS measures served frames. Slow camera requests do not execute in the fin task.

## Verification

```powershell
uv run --locked --offline --no-python-downloads python -m unittest discover -s tests -v
uv run --locked --offline --no-python-downloads python -m manta_ray.verify --media media --output outputs/verification-new
cd web_dashboard
npm.cmd test
```

Stop the demo/manual simulator before Node tests so camera fixture ports 8080/8081 are free. Tests use isolated backend ports and test credentials; no physical device is commanded. The media verification runner saves commands, test logs, source digest, input hashes and numerical processing outputs without playing clips. Generated outputs must use new paths and remain ignored by Git.

To evaluate independently annotated plant masks, create a manifest:

```csv
clip_id,split,prediction,reference,label_source
session-A,test,../outputs/survey-01/masks/frame_000000.pgm,labels/frame_000000.pgm,annotator-and-date
```

```powershell
uv run --locked --offline --no-python-downloads python -m manta_ray.ecology.validate annotations/labels.csv --output outputs/label-evaluation.json
```

Paths are relative to the manifest. P5 PGM masks use 255 for plants, 0 for background and 128 for excluded pixels; crop/scale must match. Predictions cannot exclude reference-labeled pixels. The evaluator rejects declared train/test clip overlap, duplicate predictions and self-reference. [Research validation](research.md#validation-and-research-readiness) explains the metrics, evidence and remaining field work. Keep original media URLs, licenses and author credits when sharing footage.
