import { z } from 'zod';

const ClientEnvSchema = z.object({
  // NEXT_PUBLIC_* must be referenced by literal name so Next.js can inline them
  // at build time. Do not destructure from process.env dynamically.
  NEXT_PUBLIC_API_URL: z.string().url(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_WS_URL: z.string().url(),
});

export const clientEnv = ClientEnvSchema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
});
