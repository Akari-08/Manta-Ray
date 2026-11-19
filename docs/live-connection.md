# Local ESP32 telemetry and camera setup

The existing Node dashboard server now owns live robot state, recent history and command delivery. The robot opens one authenticated WebSocket to it. Browsers subscribe to that server. JPEG/MJPEG runs on separate ESP32 HTTP listeners, so video never enters the telemetry WebSocket. The dashboard samples timestamped JPEGs at up to 2 fps; the device also exposes a direct MJPEG stream at roughly 6 fps. No cloud service is used, including for fonts.

The older Python `manta_ray.connectivity` depth/surfacing SITL example remains separate. Its simulated depth is **not** a hardware sensor and is never shown in the live dashboard. There is no live position map, GPS, depth, battery voltage, compass heading or measured servo feedback in this integration.

## Run without hardware

Requires Node.js 22 or newer. From PowerShell at the repository root:

```powershell
cd web_dashboard
npm.cmd ci
Copy-Item .env.example .env
# Run twice; copy each generated value into its own token entry in .env.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Edit `.env`: replace both example tokens with different random values, leave `HOST=127.0.0.1`, and set `ALLOW_SIMULATOR=1`. Example tokens are deliberately rejected. Start the backend:

```powershell
npm.cmd start
```

In a second terminal in `web_dashboard`:

```powershell
npm.cmd run simulate
```

Open `http://127.0.0.1:3000`. A prominent **SIMULATION** banner, synthetic IMU readings and a test-card camera identify this mode. Temperature, TDS and syringe stay unavailable because their hardware is unconfirmed. The simulator has no connection to a physical robot.

Paste your `CONTROL_TOKEN` into the dashboard and choose **Enable controls**. This starts a control heartbeat, but does not start motion. Apply fin settings, start flapping, and stop to exercise acknowledgements. Applied means the controller accepted the command; it is not measured physical motion. Tokens remain in browser memory, are not saved to local storage, and are never put into URLs. Keep the tab visible; hiding it releases the heartbeat. After a disconnect or stale-data event, explicitly enable controls again. The last 20 command results remain visible in the Command log tab.

Recording playback is labelled **RECORDING / NOT LIVE**. Use **LIVE CAMERA** to return to the current feed. Panel dragging, keyboard reorder buttons and saved panel order remain available.

## Connect the physical ESP32

1. Stop the simulator. Set `ALLOW_SIMULATOR=0` in `.env` and restart the backend.
2. On the computer run `ipconfig`; find the Wi-Fi adapter's private IPv4, for example `192.168.1.40`. Set `HOST` to that address. The backend binds that specific interface; it rejects wildcard/public addresses. Browse `http://192.168.1.40:3000` after restarting. A DHCP reservation helps keep it stable.
3. Connect the ESP32 to the same **2.4 GHz** Wi-Fi network. `localhost` on the ESP32 means the ESP32, not the computer. Guest networks/client isolation may prevent access. In `firmware/manta_ray/secrets.h`, set `BACKEND_HOST` to the computer's address, `BACKEND_PORT=3000`, matching `ROBOT_ID` and `DEVICE_TOKEN`, plus Wi-Fi credentials. Copy `secrets.example.h` first; `secrets.h` is ignored by Git.
4. On a trusted private Windows network, allow the Node process or TCP 3000 inbound **only on the Private profile and local subnet**, if prompted/needed. No router port forwarding, public tunnels, public IP binding, UPnP or cloud relay is needed. This change does not create firewall rules automatically. Do not expose ports 3000, 80 or 81 to the Internet.
5. Build/upload the firmware using the instructions below. Visit `/api/state` to inspect availability/fault reasons. The ESP32 publishes approximately 10 messages/second. The dashboard should switch to **HARDWARE** when real firmware is connected.

This is a trusted-LAN development protocol: device publishing and movement use separate bearer secrets, over local HTTP/WS. It does not provide encryption, certificate-based device identity or protection against a hostile peer on that Wi-Fi. Read-only telemetry and camera endpoints are available to the local subnet. Use an isolated trusted robot network, unique secrets and the restricted interface/firewall; do not publish this service.

## Build firmware

Target: **Freenove ESP32-WROVER, classic dual-core ESP32 with PSRAM**, not AI Thinker ESP32-CAM, ESP32-S3 or C3. Arduino-ESP32 **3.3.3** is the installed verification target. Dependencies are **ArduinoJson 7.3.2** and **WebSockets by Markus Sattler / Links2004 2.7.2**. Camera, HTTP server, MCPWM, FreeRTOS, Wi-Fi and Wire are supplied by the core. No ESP32Servo library is used.

With Arduino CLI on PATH:

```powershell
arduino-cli core install esp32:esp32@3.3.3 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli lib install ArduinoJson@7.3.2 WebSockets@2.7.2
arduino-cli compile --fqbn esp32:esp32:esp32wrover firmware/manta_ray
# Only after inspecting wiring/configuration, select the actual USB serial port:
arduino-cli upload --fqbn esp32:esp32:esp32wrover --port COM_REPLACE firmware/manta_ray
```

In Arduino IDE, open `firmware/manta_ray/manta_ray.ino`, select **ESP32 Wrover Module**, install those library/core versions and select the actual serial port. Use the default 4 MB partition configuration and PSRAM enabled. The sketch can compile with `secrets.example.h`; it will not connect until real local credentials are supplied. Do not commit credentials.

Outputs default to disabled even when connected. Copy `local_config.example.h` to `local_config.h` and configure confirmed pulse calibration before enabling. The firmware emits no servo pulses at startup, and fin PWM begins only after an explicit start command. Setting fin parameters while stopped changes configuration; it does not reposition fins until a start. The syringe emits no PWM until an explicit valid syringe target. Upload/reset alone must never be treated as a motion command.

## Pin and peripheral audit

The mapping follows [Freenove's WROVER camera example](https://github.com/Freenove/Freenove_ESP32_WROVER_Board/blob/main/C/Sketches/Sketch_06.1_CameraWebServer/camera_pins.h). Check the actual board revision and wiring before powering actuators.

- Camera D0..D7: **4, 5, 18, 19, 36, 39, 34, 35**. XCLK **21**, PCLK **22**, VSYNC **25**, HREF **23**, SCCB SDA **26**, SCL **27**. PWDN/reset are `-1`.
- Left fin **GPIO13**, right fin **GPIO14**. Both use MCPWM group 0, a shared 1 MHz timer with a 20,000-tick period (50 Hz), separate operators/comparators. The optional syringe uses a third operator. Camera XCLK owns LEDC timer 0/channel 0 at 20 MHz. These are independent peripherals; do not add a servo library that reassigns camera LEDC resources. See [MCPWM](https://docs.espressif.com/projects/esp-idf/en/v5.3/esp32/api-reference/peripherals/mcpwm.html).
- MPU6050 SDA **GPIO32**, SCL **GPIO33**, address **0x68** (change the single configuration if AD0 selects 0x69). Use 3.3 V bus pull-ups and common ground. The sketch chooses the I2C controller opposite the core's `CONFIG_SCCB_HARDWARE_I2C_PORT1` setting. In the verified 3.3.3 core camera SCCB uses controller 1, so MPU uses controller 0. Pin numbers alone do not prevent an I2C-controller conflict; see the [camera SCCB driver](https://github.com/espressif/esp32-camera/blob/master/driver/sccb-ng.c).
- GPIO6..11 are flash-reserved; GPIO16/17 are PSRAM-reserved on WROVER. GPIO34..39 are input-only and used by this camera where exposed. GPIO1/3 are USB/UART. GPIO0/2/5/12/15 are strapping pins; GPIO2 also drives the board LED on common Freenove revisions. Do not attach arbitrary servo loads/pull-ups to boot pins. See [Espressif GPIO restrictions](https://docs.espressif.com/projects/esp-idf/en/v4.4.2/esp32/api-reference/peripherals/gpio.html).
- Syringe pin is **disabled (`-1`)**. GPIO15 is an explicitly optional candidate only after the small servo model, pulse range, safe travel and boot-strap loading are verified. Other assignments require a new pin audit. No SD/JTAG peripheral is enabled; adding one can conflict with fin/syringe pins.
- No TDS ADC pin is assigned. Camera plus MPU occupy the usable exposed ADC1 inputs in this configuration; ADC2 conflicts with Wi-Fi. An external ADC has **not** been assumed or implemented. Confirm voltage range and interface, then provide a verified external ADC adapter on the MPU bus or redesign/re-audit the pins. See [Espressif ADC guidance](https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32/schematic-checklist.html#adc).

Use a suitable separate servo power supply sized for the actual load and startup/stall current, with common signal ground. The ESP32 3.3 V rail/USB regulator is not a servo supply. Physical power isolation is separate from software stop. Power-up twitch, electrical noise, brownouts, wet enclosure operation and pulse timing under load require hardware tests.

## Calibration and missing adapters

`config.h` is the documented source for pins, limits, trims, directions, timing and calibration. `local_config.h` contains ignored local overrides. The two DS3218 270° fin mappings use provisional 500–2500 µs endpoints and remain disabled until deliberately confirmed; the numeric commanded angles are an actuator model, not position feedback. Start with unloaded horns, a clear bench and a physical power disconnect. Verify endpoints, centre, mirror direction, mounting trim and permitted travel before enabling.

Server limits are amplitude **0–45°**, rate **0.1–2 Hz**, centre **90–180°**, and nominal fin envelope **45–225°**. Firmware enforces the envelope including trims. Syringe commands are bounded to **0–180°** at the server and must also satisfy the configured model-specific firmware limits. Confirmed small-servo pulse endpoints/travel are required; there is no default actuator calibration.

MPU6050 uses ±2 g (16384 counts/g), ±250°/s (131 counts/(°/s)), a 100 Hz sample configuration and a 10 ms I2C timeout. Acceleration is reported in m/s² including gravity, gyro in degrees/second, in **sensor axes**. Configure measured biases and mounting orientation as needed. Roll/pitch are accelerometer/gravity estimates; fin acceleration corrupts them. They are not accurate navigation attitude or heading. No heading is produced. The MPU's internal chip temperature is deliberately not substituted for the unknown water-temperature probe.

`water_adapter.h` is called at 1 Hz. Confirm the temperature sensor model and bus, TDS board output voltage/range, ADC hardware/reference/resolution and calibration standards before implementing it. Return NAN plus a reason for missing/faulted values. Return actual ADC counts (0..65535) only after verifying the interface, and supply a calibration ID for any ppm estimate. Do not use a generic ppm formula or assume temperature compensation. Adapters must be bounded/nonblocking; stale readings become null. Calibration IDs record provenance; they are not a claim of accuracy.

## Runtime and disconnect behavior

Fin control owns MCPWM in a 100 Hz, higher-priority core-1 task; hardware produces the 50 Hz pulses. Sensors run separately. Networking and camera servicing run on core 0. A slow socket, I2C timeout, camera request or camera reinitialization does not execute in the fin-control task. Commands/ACKs have fixed eight-entry queues, sensor data is a single overwritten latest slot, and unsent telemetry is dropped. Wi-Fi and WS reconnect with bounded exponential backoff and jitter. There is no disconnected telemetry backlog or movement replay.

Default bench policy stops the phase oscillator after **3 seconds without an active control heartbeat**, holding the last commanded fin positions. The backend's browser lease expires after **2 seconds**, so losing only the dashboard stops flapping in approximately **5 seconds or less plus scheduling jitter**. Losing backend/device connectivity stops within the firmware timeout. Reconnect does not restart flapping. A stopped but energized servo can still exert force. **Software stop is not a physical emergency power cutoff.**

Syringe behavior is deliberate: **hold the last commanded target on disconnect; do not automatically extend/retract**. If no target has ever been commanded, its PWM stays off. Whether holding is mechanically appropriate must be verified with the actual actuator and syringe. Configuring `MANTA_STOP_ON_TIMEOUT=0` opts into autonomous continued local flapping, reports `mode=autonomous` and `disconnect_policy=continue`, and is not the default. New remote movement commands still require a current heartbeat and valid expiry. No route-following autonomy is implemented here.

Camera uses QVGA 320×240 JPEG, two PSRAM frame buffers and `CAMERA_GRAB_LATEST`. Slow readers have bounded socket timeouts; no frame archive accumulates. Failed camera initialization is retried every five seconds, and repeated capture failures trigger reinitialization under a mutex. Telemetry/fin tasks continue. Hardware MJPEG: `http://ESP32_IP:81/stream`; snapshots: `http://ESP32_IP/capture`. Simulator equivalents use ports 8081 and 8080 and always show a labelled test card. FPS counts successfully served frames, not an assumed camera rate. Wi-Fi underwater performance and simultaneous camera/servo stability remain physical constraints to measure.

## Computer vision integration

Run `npm.cmd run sample-camera` while the service/device are connected. It overwrites one bounded `outputs/live-camera/latest.jpg` plus `latest.json`, retaining source, robot/session ID, frame ID, image-capture uptime, backend image receive time and camera calibration ID. Missing calibration, confidence and vegetation coverage remain null.

`GET /api/camera/frame` provides the same JPEG and `X-Frame-Metadata` JSON header to a computer-side worker. The service accepts only URLs at the publishing peer's expected camera ports/paths, never redirects, limits frames to 256 KiB, allows at most two captures in flight, and times out requests. It retains at most 32 frame references.

A real calibrated worker can submit `POST /api/cv/result` with the control bearer token, a recent issued frame ID, method, calibration ID, confidence in [0,1] and vegetation coverage in [0,100]. Frame references expire after five seconds or a session change. Results preserve whether the frame came from hardware or a simulator; stale results are labelled. This is an integration interface, **not an implemented vegetation model**. Existing offline `manta_ray.ecology` computes candidate green cover and intentionally leaves validated vegetation cover unavailable. Its output is not relabelled as measured live vegetation.

See [the versioned protocol](telemetry-protocol.md) and [validation record](live-validation.md).
