# Manta Ray

**Work in progress**

Manta Ray is a robotic aquatic survey vehicle designed to photograph underwater vegetation and estimate the percentage of the lakebed covered by plants. The design uses two flexible flapping fins for propulsion and a downward-facing camera for imaging. The project asks whether flapping fins can propel the vehicle efficiently while keeping survey images clear enough to measure plant cover.

Vegetation mapping and water quality measurements are the near-term environmental objectives. The project also includes a chemistry research track on removing excess nutrients to limit algal growth in lakes. Multispectral imaging is a planned capability for vegetation surveys.

## System design

| Subsystem | Design goal |
| --- | --- |
| Hull and drivetrain | Waterproof enclosure with a clear camera window, paired fin drives, and a buoyancy design suited to the vehicle. The full vehicle targets forward motion, left and right turns, ascent, and descent. |
| Autonomy | Execute survey missions offline, follow a lawnmower coverage route, log survey data, and respond to a stop-and-surface command. |
| Dashboard | Provide a command center for mission planning and commands, live position and vehicle status when connected, and review of vegetation analysis and COLMAP reconstructions. |

Each subsystem can be tested independently. The preliminary hardware list includes DS3218MG servos, an ESP32 and camera assembly (15 g), a temperature sensor (8 g), a total dissolved solids (TDS) sensor (50 g), and a battery to be selected. The drivetrain design will evaluate fin geometry, synchronized motion, buoyancy, and steering.

## Prototype and validation

The first physical prototype will float at the surface and use its fins to cross a shallow tank while its camera looks underwater. The tank demo will survey artificial vegetation patches and compare the estimated percentage of plant cover with known coverage. The surface-floating design defers depth control to a later prototype.

- Test fin propulsion and steering in the tank, then test ascent and descent on a depth-capable prototype.
- Check camera image clarity during fin motion and validate the recording-to-analysis pipeline off the vehicle using saved footage.
- Measure operating sound levels in decibels in air and underwater, documenting the measurement setup for each medium.
- Test the water quality sensors against reference readings.
- Exercise autonomous route following, position reporting, and the dashboard's stop-and-surface command in software-in-the-loop (SITL).

## Roadmap

- Research the environmental problem, define survey objectives and water quality measurements, and identify a field specialist to consult.
- Compare fin drive mechanisms and plan the hull, drivetrain, buoyancy, camera, and sensor integration.
- Define the full system architecture and the interfaces between firmware, autonomy, survey analysis, and the dashboard.
- Validate the software in SITL, then build and test the surface-floating tank prototype.

## Local setup (PowerShell)

From the repository root, use an installed Python 3.11 or newer with uv:

```powershell
uv sync --locked --offline --no-python-downloads
uv run --locked --offline --no-python-downloads python -c "import manta_ray.ecology, manta_ray.reconstruction, manta_ray.connectivity"
```

Without uv, use the installed Python directly:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -c "import manta_ray.ecology, manta_ray.reconstruction, manta_ray.connectivity"
```

See the [survey software guide](docs/software.md) for video analysis, reconstruction, and command testing.

The [live ESP32 connection guide](docs/live-connection.md) covers the local Node backend,
dashboard, labelled ESP32 simulator, camera/CV interface and Freenove WROVER firmware.
Start there for hardware telemetry and fin controls; the older Python depth/surfacing demo
is a separate simulation. See the [wire protocol](docs/telemetry-protocol.md) and
[actual integration validation](docs/live-validation.md) for scope and test evidence.

The [scientific method](docs/scientific-method.md) defines the camera and TDS indicators and their validation.

See the [validation evidence](docs/validation-report.md) for software tests, stock-media processing, and real COLMAP reconstruction results.
