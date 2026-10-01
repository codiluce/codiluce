// Serves the statically exported visualizer UI. Paths are resolved strictly
// inside the UI build directory; anything else is a 404.
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json; charset=utf-8',
};
export async function serveStatic(directory: string, pathname: string, response: ServerResponse): Promise<void> {
  let decoded: string;
  try { decoded = decodeURIComponent(pathname); } catch { response.writeHead(400).end('Bad request'); return; }
  if (decoded.includes('\0')) { response.writeHead(400).end('Bad request'); return; }
  const base = await realpath(directory);
  const relative = decoded.replace(/^\/+/, '') || 'index.html';
  const candidates = [relative, ...(path.extname(relative) ? [] : [`${relative.replace(/\/$/, '')}.html`, `${relative.replace(/\/$/, '')}/index.html`])];
  for (const candidate of candidates) {
    const absolute = path.resolve(base, candidate);
    if (absolute !== base && !absolute.startsWith(`${base}${path.sep}`)) break;
    try {
      const resolved = await realpath(absolute);
      if (!resolved.startsWith(`${base}${path.sep}`) || !(await stat(resolved)).isFile()) continue;
      const body = await readFile(resolved);
      response.writeHead(200, { 'Content-Type': TYPES[path.extname(resolved)] ?? 'application/octet-stream', 'Cache-Control': candidate.startsWith('_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      response.end(body);
      return;
    } catch { /* try next candidate */ }
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
}
