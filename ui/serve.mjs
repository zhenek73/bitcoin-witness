/**
 * Serves the browser stand on http://127.0.0.1:8088
 *
 * It has to be served over http:// rather than opened as a file:// path: the
 * page calls the Creditcoin devnet's JSON-RPC, and a file:// origin gets
 * rejected. Over plain http on localhost the devnet panel works.
 *
 * Usage:  node serve.mjs        (Ctrl+C to stop)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8088);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  const rel = normalize(path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  if (rel.startsWith('..')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, {
      'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Bitcoin Witness stand: http://127.0.0.1:${PORT}`);
  console.log('Ctrl+C to stop.');
});
