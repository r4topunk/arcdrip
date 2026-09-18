import path from 'node:path';
import type { NextConfig } from 'next';

const repoRoot = path.join(import.meta.dirname, '../..');

// GitHub Pages serves the export under /arcdrip (the Pages workflow sets NEXT_PUBLIC_BASE_PATH); local builds use "".
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');

const nextConfig: NextConfig = {
  // Fully static: no server, no backend. `pnpm build` writes ./out.
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  basePath,
  reactStrictMode: true,
  poweredByHeader: false,
  // Keep next dev from writing AGENTS.md/CLAUDE.md here; the repo-level AGENTS.md is the source of truth.
  agentRules: false,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
