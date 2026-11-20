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

The first physical prototype will float across a shallow tank and survey artificial vegetation patches with known coverage. This allows image analysis and propulsion to be evaluated before adding depth control. The sensing baseline is cameras, a TDS probe and an MPU; the vehicle also uses DS3218MG fin servos, an ESP32 and a battery to be selected. Optional sensor proposals are kept separate in the research document. The subsystems can be tested independently.

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

- [documentation.md](documentation.md): presentation-ready explanation of computer vision and ecological analysis.
- [GUIDE.md](GUIDE.md): setup, video processing, assessment inputs, APIs, firmware, and verification commands.
- [research.md](research.md): scientific methods, scholarly and official sources, validation results, and research limitations.

The analysis follows a camera-led ecological survey: reproducible image sampling, an offline random-point annotation tool, reviewed vegetation/substrate cover, reviewed aquatic-life video counts, and source-separated TDS context. Sparse COLMAP reconstruction and local telemetry/control complete the supporting pipeline. Automatic green-pixel screening remains a development baseline; a trained vegetation or animal model still needs independent freshwater validation. The stock clips have unknown ecological condition, and simulated TDS supplies no evidence about their real chemistry. See the [research pipeline](research.md#full-data-pipeline) for acquisition, CV development, validation and ecological interpretation.

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
