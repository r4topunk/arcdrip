// Minimal static file server for the Next export (out/): /path/ serves /path/index.html, and an optional basePath
// prefix mimics GitHub Pages (/sharedarc/...). Used by e2e-anvil.mjs; not a production server.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

/** Serves `root` on 127.0.0.1 (a free port unless given). Resolves to { server, url }. */
export function serveStatic(root, { port = 0, basePath = '' } = {}) {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (basePath) {
      if (!p.startsWith(basePath)) {
        res.writeHead(404);
        res.end('outside basePath');
        return;
      }
      p = p.slice(basePath.length) || '/';
    }
    let file = path.join(root, path.normalize(p));
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file) && existsSync(`${file}.html`)) file = `${file}.html`;
    if (!existsSync(file)) {
      res.writeHead(404, { 'content-type': TYPES['.html'] });
      createReadStream(path.join(root, '404.html')).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`,
      });
    });
  });
}
