# Manta Ray

**Work in progress**

Manta Ray is a robotic aquatic survey vehicle designed to photograph underwater vegetation and estimate the percentage of the bottom covered by plants. Two flexible flapping fins provide propulsion, while a downward-facing camera records the survey. The central design question is whether the vehicle can move efficiently while capturing clear, measurable images.

Vegetation mapping and water quality monitoring are the environmental objectives. Multispectral imaging and research into removing excess nutrients to limit algal growth are planned capabilities.

## Project design

| Subsystem | Goal |
| --- | --- |
| Hull and drivetrain | Waterproof camera enclosure, synchronized fin drives, buoyancy control, forward movement, steering, ascent and descent. |
| Autonomy | Run offline survey missions, follow a lawnmower coverage route, log observations, and respond to stop-and-surface commands. |
| Survey analysis | Measure vegetation cover, retain water quality observations, and reconstruct surveyed features with COLMAP. |
| Dashboard | Provide mission controls, vehicle status, recorded observations, selectable ecological assessment methods, and reconstruction viewing. |

The first physical prototype will float across a shallow tank and survey artificial vegetation patches with known coverage. This allows image analysis and propulsion to be evaluated before adding depth control. The preliminary hardware includes DS3218MG fin servos, an ESP32/camera, temperature and TDS sensors, and a battery to be selected. The subsystems can be tested independently.

Validation will cover movement and steering, image clarity during fin motion, sensor readings against references, sound measurements in air and water, and comparison of estimated plant cover with independently measured cover.

## Run locally

Requires installed Python 3.11+, uv, and Node.js 22+. FFmpeg/FFprobe are needed for video analysis; COLMAP is needed for reconstruction. The commands below use existing local tools and dependencies.

```powershell
# From the repository root
uv sync --locked --offline --no-python-downloads
cd web_dashboard
npm.cmd run demo
```

Open [the dashboard](http://127.0.0.1:3000). The launcher starts the local backend, device simulator, test-card camera, and Python surfacing simulation. It creates local credentials if needed and supplies demo authorization automatically. Choose **Enable controls** before commanding simulated motion. Fresh-checkout dependency setup is in the guide.

## Documentation

- [GUIDE.md](GUIDE.md): setup, video processing, assessment inputs, APIs, firmware, and verification commands.
- [research.md](research.md): scientific methods, scholarly and official sources, validation results, and research limitations.

The implementation currently supports recorded-video green-cover screening, traceable TDS observations and simulated profiles, Carlson TSI and CCME WQI calculations from supplied measurements, sparse COLMAP reconstruction, and local telemetry/control integration. Candidate green cover is calculated from video pixels; its accuracy as vegetation cover still needs independent validation. The stock clips have unknown ecological condition, so their imagery and simulated chemistry cannot establish actual lake health.

## Repository layout

```text
manta_ray/       Python ecology, reconstruction, connectivity and verification
web_dashboard/  Local Node backend, browser dashboard and device simulator
firmware/       ESP32-WROVER firmware and hardware configuration examples
tests/          Python tests; dashboard tests live beside the Node modules
docs/           Machine-readable telemetry example
media/          Local source recordings (ignored)
data/input/     Additional local inputs (ignored)
outputs/        Generated reports, masks, models and logs (ignored)
```

Next milestones are independent vegetation labels, calibrated sensor integration, a representative field sampling plan, offline route following, and tank validation of the vehicle. Multispectral retrieval and nutrient removal require separate research and experimental validation.
