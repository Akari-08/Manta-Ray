# Telemetry and command protocol v1

`web_dashboard/protocol.js` is the executable validation contract. JSON numbers must
be finite, sequences/uptimes integers, units exact, and unknown telemetry/command/ACK
fields are rejected. Unsupported versions close the device session. A version change
requires coordinated firmware/backend/client updates.

## Device WebSocket

Connect to `ws://COMPUTER_LAN_IP:3000/ws/device`. Max payload 16 KiB, max 40 messages
per second, no compression. The intended rate is 10 telemetry messages per second.
At most one authenticated device with the configured robot ID can publish; an existing
session is never silently taken over. Authentication must complete within three seconds:

```json
{"schema_version":1,"type":"hello","robot_id":"manta-01","source":"hardware","token":"DEVICE_TOKEN"}
```

`source` is `hardware` or `simulator`; simulation requires the backend's explicit
`ALLOW_SIMULATOR=1`. The server replies:

```json
{"schema_version":1,"type":"welcome","session_id":"a-new-uuid-for-each-connection"}
```

Sequence numbers must strictly increase within a session, and uptime must not decrease.
New sessions reset these checks and clear history/frame references. Last-known telemetry
remains visible as stale while disconnected. On a new welcome it becomes unavailable
until a fresh packet arrives. Identity/source cannot change within a session.

## Telemetry

All of these fields are required:

- `schema_version: 1`, `type: "telemetry"`, `robot_id` (1–48 alphanumeric/underscore/hyphen),
  `firmware_version` (1–48 chars), `seq` (nonnegative safe integer), `uptime_ms`
  (nonnegative safe integer), `source` (`hardware`/`simulator`), `mode` (`bench`/`autonomous`).
- `device_time`: reading in `unix_ms`. Null unless the device clock is actually synchronized.
  Stock firmware deliberately reports null; all timestamps are not interchangeable.
- `wifi`: `rssi` reading in `dBm`, `reconnects` nonnegative integer (transport reconnect attempts).
  Freshness/connection health is authoritative in the backend envelope below.
- `imu`: `acceleration` reading with `[x,y,z]` in `m/s^2`, `angular_velocity` reading with
  `[x,y,z]` in `deg/s`, `roll_estimate` in `deg`, `pitch_estimate` in `deg`,
  `calibration_state` (`uncalibrated`, `configured`, `unavailable`, `simulated`).
  Raw axes are sensor axes; gravity is included. Roll/pitch use accelerometer gravity
  geometry, not a validated navigation filter. There is no yaw/heading.
- `water`: `temperature` (`degC`), `tds_raw` (`ADC_count`, 0..65535), `tds_estimate`
  (`ppm`, 0..100000), and `calibration_id` (string or null). A finite TDS estimate requires
  a calibration ID. Raw counts alone do not imply concentration or environmental quality.
- `control`: `flapping` boolean, `outputs_enabled` boolean, `amplitude_deg`, `cycle_hz`,
  `centre_deg`, `left_command`, `right_command`, `syringe_command` (readings in `deg`),
  `actuator_state` (`disabled`, `holding`, `commanded`), `disconnect_policy` (`stop`/`continue`),
  `heartbeat_timeout_ms` (500..10000). Fin readings are commanded model angles 0..270;
  syringe model angles are 0..180. They are **not measured servo positions**. No pulse
  issued since startup means null, not a fictitious centre angle.
- `camera`: `available` boolean, `reason` null if available or nonempty text if not,
  `stream_url`, `snapshot_url` (both null if unavailable), `fps` reading in `fps`,
  `calibration_id` string or null. FPS is measured served frames per elapsed time.
  URL hosts must equal the authenticated device's peer IP, with fixed paths/ports:
  hardware `http://IP:81/stream`, `http://IP/capture`; simulator `http://IP:8081/stream`,
  `http://IP:8080/capture`. No query strings, credentials, fragments or redirects.
- `faults`: array of at most 16 text descriptions, each at most 160 characters.

A scalar/vector reading has exactly `value`, `unit`, `reason`. Valid values have
`reason: null`. Unavailable values have `value: null` and a nonempty reason:

```json
{"value":null,"unit":"degC","reason":"Temperature sensor model unconfirmed"}
```

```json
{"value":[0.03,-0.02,9.81],"unit":"m/s^2","reason":null}
```

See [the complete simulator message example](telemetry-example.json); every synthetic
value in that file is explicitly identified as simulated.

## REST and live state

`GET /api/state` and `ws://HOST:3000/ws/live` expose the same state envelope:

- `schema_version: 1`, `type: "state"`, `robot_id`, `backend_time` (UTC ISO 8601),
  `received_at` (UTC ISO 8601 of most recent valid telemetry, or null), `age_ms` (or null).
- `connection`: `live`, `stale`, `disconnected`. `stale` boolean is true until fresh valid
  telemetry arrives, after 2 seconds without telemetry, or on disconnect. Missing packets
  do not reset freshness; invalid/out-of-order packets close the publishing session.
- `control_active`: whether an authenticated operator heartbeat lease is current.
- `telemetry`: latest validated message or null; `limits`: backend command ranges;
  `cv`: availability/reason/result plus a stale indicator.

The server stamps receipt time, never trusts a supplied backend timestamp, and sends
freshness updates every 500 ms even when telemetry stops. After 5 seconds without valid
telemetry the device connection is terminated. Clients also detect missing backend
messages after 2 seconds; they must not interpret a connected browser socket as a live robot.

`GET /api/history` returns `{schema_version:1,samples:[{received_at,telemetry},...]}`,
bounded to 600 samples (approximately 60 seconds). It is memory-only, reset per device
session/restart. Slow subscriber sockets exceeding 64 KiB queued output are disconnected.
There are at most 16 WebSocket connections. History, logs and CV are not durable storage.

Read-only state/history/CV/camera require access to the private network. No CORS is
enabled. Browser WS/REST origins must match the backend Host. Only static allowlisted
assets are served; source/config/credentials are not downloadable as static files.

## Control heartbeat and commands

Control REST requests require `Authorization: Bearer CONTROL_TOKEN`. Device and control
tokens must differ, contain at least 24 characters, and replace the example placeholders.
Generate random secrets as described in the setup guide. Requests are bounded to 8 KiB
and must use `Content-Type: application/json` when carrying a body.

`POST /api/control/heartbeat` acquires/renews a two-second lease, only with fresh telemetry.
Renew every 500 ms while deliberately controlling the robot. `DELETE` on that endpoint
releases it. Neither endpoint commands motion. The backend sends this application heartbeat
every 500 ms (and immediately on lease renewal):

```json
{"schema_version":1,"type":"heartbeat","session_id":"current-session","control_active":true}
```

The device refreshes its movement watchdog **only** for a matching session with
`control_active: true`. Merely being connected to the backend cannot keep bench motion
running forever when the dashboard disappears. WebSocket ping/pong is additional
transport health, not movement authorization.

`POST /api/commands` accepts exactly:

```json
{"schema_version":1,"id":"unique-command-uuid","action":"set_fin","args":{"amplitude_deg":20,"cycle_hz":0.5,"centre_deg":135},"ttl_ms":1500}
```

- `id`: 8–64 alphanumeric/underscore/hyphen characters; use a random UUID/128-bit ID.
- `ttl_ms`: integer 200..2000. UI uses 1500 ms. Backend does not extend it on retries.
- `start`/`stop`: empty `args: {}`. Start requires enabled/calibrated outputs and an active
  control heartbeat. Stop is a software oscillator stop; it holds positions and never
  cuts electrical power. Stop still requires authentication, fresh telemetry and expiry.
- `set_fin`: all three parameters are required together: amplitude 0..45°, cycle
  0.1..2 Hz, centre 90..180°. Firmware validates the resulting envelope including trims.
  Applying these while stopped configures the next start without attaching fin outputs.
- `set_syringe`: `args: {"target_deg":90}`, range 0..180° and the narrower firmware-calibrated
  envelope. Rejected while the unknown actuator is disabled.

Only one command is pending at a time. A second is rejected with a clear message until
acknowledgement/deadline. Movement is never queued for a disconnected/stale device. Backend
`202` means **sent/pending**, not applied. `400` means schema error, `401` authentication
error, `409` a duplicate/busy/disconnected/disabled/unarmed condition. Do not blindly retry
an uncertain movement request, even with a new ID; first inspect telemetry and operator intent.

The forwarded WS command adds `type: "command"`, current `session_id`, and
`expires_uptime_ms = latest_device_uptime_ms + ttl_ms`. Using the last observed uptime is
conservative: transit age reduces the remaining validity. No NTP synchronization is required.
Firmware rejects expired/far-future deadlines, wrong sessions, duplicated IDs, invalid limits,
stale heartbeats and full command queues. It validates again in the control task before
applying the command. Disconnect clears command/ACK queues and changes the generation.

Device ACK, emitted only after control-task application/rejection:

```json
{"schema_version":1,"type":"ack","session_id":"current-session","id":"unique-command-uuid","status":"applied","reason":null}
```

Device statuses are `applied`, `rejected`, `expired`. Rejection/expiry requires a reason.
Applied is controller acceptance, **not** physical position or movement confirmation.
The backend also ends pending commands with `expired` on missing/late ACK or `disconnected`
on connection loss, explicitly reporting the physical outcome as unknown. Late, duplicate
or foreign-session ACKs cannot turn a timed-out command into success. The device's 64-ID
ring and the backend's 256-record log are bounded; there is no replay after reconnect.

`GET /api/commands/ID` (control token required) retrieves status, reason, arguments,
session, send/finish times and device expiry. `/ws/live` emits
`{type:"command_result",command:{...}}` on completion. The browser also polls the authenticated
status endpoint to recover a missed subscription event; it never resends the command.

## Camera and CV

ESP32 `/capture` returns JPEG plus `X-Capture-Uptime-Ms` from the framebuffer capture
timestamp (boot-relative, not UTC). MJPEG parts carry that header as well. The backend's
`GET /api/camera/frame` bounds/validates the upstream fetch and returns JPEG plus
`X-Frame-Metadata` JSON:

```json
{"frame_id":"uuid","robot_id":"manta-01","source":"hardware","captured_uptime_ms":12345,"received_at":"2026-11-18T18:00:00.000Z","calibration_id":null,"session_id":"current-session"}
```

Image time and telemetry receive time are distinct. Calibration null means unavailable,
not a calibrated lens. `GET /api/cv` starts with `available:false`, an explanation and
`result:null`. A worker uses `POST /api/cv/result` with the control bearer token and exactly:

```json
{"frame_id":"recent-issued-frame-uuid","method":"your-validated-method-version","calibration_id":"your-calibration-record","confidence":0.8,"vegetation_cover_pct":23.5}
```

This is a **shape example, not a measured result**. The service requires a recent issued
frame from this session, a nonempty method and calibration ID, finite confidence 0..1,
and coverage 0..100. It attaches the original frame metadata/source and result receive
time; consumed frame IDs cannot be reused. The service cannot verify a worker's scientific
calibration. Results become stale after five seconds or disconnection. No default worker
or simulator fabricates coverage. `cv-sample.js` only saves the current image/provenance.
