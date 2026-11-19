# Manta Ray live dashboard

Local Node.js 22+ telemetry/command backend and buildless browser dashboard. Dependencies
are pinned by `package-lock.json`. An internet connection is optional except for map tiles.

See [complete local setup and hardware instructions](../docs/live-connection.md),
[telemetry/command protocol](../docs/telemetry-protocol.md), and
[what was actually verified](../docs/live-validation.md).

```powershell
npm.cmd ci
Copy-Item .env.example .env
# Generate two different random tokens and edit .env before starting.
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm.cmd start
```

For software-only testing set `ALLOW_SIMULATOR=1`, then run `npm.cmd run simulate`
in a second terminal. Both processes read `.env`. Open `http://127.0.0.1:3000` with
the default loopback configuration. Hardware requires binding the computer's specific
Wi-Fi IPv4 and setting that address in the ESP32 configuration; see the guide.

Run focused tests with `npm.cmd test`. Stop a manually running simulator first so
its camera ports 8080/8081 are free for the integration fixture. Tests use isolated
ephemeral backend ports, test-only bearer tokens and a labelled JPEG fixture; no
physical device is commanded. `npm.cmd run sample-camera` saves one current JPEG
and image metadata for a computer-side CV worker, without inventing CV results.

## Command log CLI

In **Vehicle interface → Command log**, type a command and press Enter:

```text
setfin amplitude 20    # degrees, 0..45
setfin cr 0.5          # cycle rate, Hz, 0.1..2
setfin center 135      # degrees, 90..180 (centre also works)
setsyringe 90          # target degrees, 0..180; requires configured actuator
startflap
stopflap
```

The comments are explanations, not part of the commands. A fin command preserves
the other two settings from fresh robot telemetry; it waits for telemetry to reflect
the previous applied fin change before accepting another partial fin update. Commands,
errors and acknowledgements appear in the same log. Controls still require the token,
fresh telemetry and a control heartbeat (stop does not require an active heartbeat).
Software stop does not cut power. No commands are automatically retried.

`commands.mjs` exposes `parseCommandLine` and `buildCommand(name, params, state)` as
pure functions for future adapters such as an MCP server. An adapter must obtain fresh
state and use the authenticated control heartbeat and `/api/commands` protocol; the
module does not send commands, authorize access or implement an MCP server. Because
`set_fin` replaces all three settings, adapters must avoid racing other controllers
and confirm telemetry after applied updates before issuing another partial change.

## Motion and dashboard location

The fish is an illustrative 3D model, not a measured vehicle pose. Roll and pitch use
the firmware's gravity-derived estimates and assume the sensor axes align with the fish.
Relative Z gyro rotation is integrated only within a fresh session and can drift; it is
not a compass heading. The blue arrow shows sensor acceleration including gravity, not
velocity. Fins animate from the reported flap state, amplitude and rate with an estimated
phase; stopped fins hold their last commanded angles when available. Neither is measured
servo feedback. Stale or disconnected data freezes the model.

The map uses **the browser device's location**, not the robot's GPS. The browser asks for
location permission automatically. Geolocation needs a secure context such as
`http://localhost:3000`; ordinary private-LAN HTTP addresses generally do not qualify.
The label-free map uses OpenStreetMap data served by OpenFreeMap. Once location is granted,
tile requests expose the approximate map area and client IP to OpenFreeMap; no map
requests occur before permission. The map needs internet and WebGL. Browser location may
be imprecise or unavailable.

Xbox controllers can be read through the browser's Gamepad API, but the current robot
protocol controls only shared fin settings, start/stop and a disabled syringe. It has no
steering, reverse, separate fin drive or camera/look control. Two-stick driving requires
defined hardware/firmware capabilities, calibrated mappings and tested fail-safes first.
