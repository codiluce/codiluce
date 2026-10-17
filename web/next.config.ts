import path from 'node:path';
import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

// Production builds are a static export served by `codiluce serve` on the
// same origin as the read-only API. The dev server proxies /api to it instead.
const api = process.env.CODILUCE_API ?? 'http://127.0.0.1:4300';
const root = path.resolve(process.cwd(), process.cwd().endsWith(`${path.sep}web`) ? '..' : '.');

export default function config(phase: string): NextConfig {
  const shared: NextConfig = { reactStrictMode: true, turbopack: { root }, outputFileTracingRoot: root, poweredByHeader: false, devIndicators: false };
  // The documented dev URL is 127.0.0.1, which Next treats as another origin for its dev resources (otherwise the page stays blank).
  // Uncompressed, so event streams (live agent activity) pass the proxy as they come instead of waiting in a gzip buffer.
  if (phase === PHASE_DEVELOPMENT_SERVER) return { ...shared, compress: false, allowedDevOrigins: ['127.0.0.1'], rewrites: async () => [{ source: '/api/:path*', destination: `${api}/api/:path*` }] };
  return { ...shared, output: 'export', images: { unoptimized: true } };
}
