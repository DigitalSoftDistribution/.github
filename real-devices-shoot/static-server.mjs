// A tiny static file server for the real-devices-shoot workflow: serves one folder on 127.0.0.1 so BrowserStack Local
// can reach it. Usage: node static-server.mjs <dir> <port-file>   (port 0 = any free port, written to <port-file>).
// GET/HEAD only; paths cannot leave <dir>.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.webmanifest': 'application/manifest+json' };

export function createServer(root) {
  const base = fs.realpathSync(root);
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    let file = path.join(base, rel);
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      const real = fs.realpathSync(file);
      if (real !== base && !real.startsWith(`${base}${path.sep}`)) throw new Error('outside');
      const body = fs.readFileSync(real);
      res.writeHead(200, { 'content-type': TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404).end(); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [dir, portFile] = process.argv.slice(2);
  if (!dir || !portFile) { console.error('usage: static-server.mjs <dir> <port-file>'); process.exit(2); }
  const server = createServer(dir);
  server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(server.address().port)));
}
