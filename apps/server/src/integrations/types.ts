import type { z } from 'zod';

/** Loose per-integration payload; stored as JSONB and rendered by per-integration UI. */
export type IntegrationDataSnapshot = Record<string, unknown>;

export interface IntegrationDefinition<Creds = unknown, Config = unknown> {
  readonly id: string;
  readonly name: string;
  readonly credentialsSchema: z.ZodType<Creds>;
  readonly configSchema: z.ZodType<Config>;
  testCredentials(credentials: Creds, config: Config): Promise<{ ok: true } | { ok: false; error: string }>;
  fetchData(credentials: Creds, config: Config): Promise<IntegrationDataSnapshot>;
}
