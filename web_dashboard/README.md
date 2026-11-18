# Manta Ray dashboard

A standalone Node.js dashboard prototype. Node.js 18 or newer is required; there are no packages to install.

```sh
cd web_dashboard
npm start
```

Open <http://localhost:3000>. Set `PORT` to use another port. The server only listens on the local machine.

- Load a local video file for playback in your browser. The file is not uploaded.
- Drag a panel by its header to reorder it, or use the arrow buttons (including on touch devices). The order is saved in browser storage when available.
- Ecological readings, the terminal, and the configuration board are interface placeholders. No sensor data is displayed and no commands are sent or executed.

Run the server checks with `npm test`.
