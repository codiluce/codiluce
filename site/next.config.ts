import path from 'node:path';
import type { NextConfig } from 'next';

// A static site: `next build` writes plain HTML, CSS and JS to `out/`, ready for any static host.
const root = path.resolve(process.cwd());

const config: NextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default config;
