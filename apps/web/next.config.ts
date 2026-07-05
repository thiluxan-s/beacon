import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Monorepo: trace from the repo root so @beacon/shared (raw TS) is included in
  // the standalone bundle. apps/web is two levels below the root.
  outputFileTracingRoot: path.join(__dirname, '../../'),
  // @beacon/shared exports raw TypeScript source (no build step). Instruct
  // Next.js to compile it through its own pipeline so imports resolve at render.
  transpilePackages: ['@beacon/shared'],
  // Server Function invocations are logged with their arguments in dev by default,
  // which echoes integration credentials (Vercel token, GitHub PAT) passed to the
  // attach actions into the terminal. Disable it so secrets never hit the dev log.
  logging: { serverFunctions: false },
};

export default nextConfig;
