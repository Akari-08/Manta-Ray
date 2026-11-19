# Manta Ray live dashboard

Local Node.js 22+ telemetry/command backend and buildless browser dashboard. Uses one
WebSocket dependency, `ws`, pinned by `package-lock.json`. No cloud service is required.

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
