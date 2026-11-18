const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');

const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

function createServer() {
  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = Object.hasOwn(files, pathname) ? files[pathname] : null;

    if (request.method !== 'GET' || !file) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }

    try {
      const content = await readFile(path.join(__dirname, file[0]));
      response.writeHead(200, { 'Content-Type': file[1], 'X-Content-Type-Options': 'nosniff' });
      response.end(content);
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Unable to load dashboard');
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, '127.0.0.1', () => {
    console.log(`Manta Ray dashboard: http://localhost:${port}`);
  });
}

module.exports = { createServer };
