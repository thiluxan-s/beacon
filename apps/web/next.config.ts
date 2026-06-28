import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @beacon/shared exports raw TypeScript source (no build step). Instruct
  // Next.js to compile it through its own Babel/SWC pipeline so that
  // import { HealthResponseSchema } from '@beacon/shared' resolves at render.
  transpilePackages: ['@beacon/shared'],
};

export default nextConfig;
