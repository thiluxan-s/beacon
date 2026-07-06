import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WEB_ORIGIN: z.string().url(),
  // min(32): matches the `openssl rand -base64 32` guidance in .env.example.
  INTERNAL_API_SECRET: z.string().min(32),
  CLERK_SECRET_KEY: z.string().min(1),
  // base64-encoded 32 bytes (openssl rand -base64 32). Used for AES-256-GCM
  // encryption of integration credentials at rest.
  INTEGRATIONS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'must be base64-encoded 32 bytes'),
  // Email alerts (Phase 5b). Both optional — unset disables alerting entirely
  // (worker idles, sendEmail no-ops), so dev without Resend boots cleanly.
  RESEND_API_KEY: z.string().optional(),
  ALERT_FROM_EMAIL: z.string().email().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(raw: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv(process.env);
