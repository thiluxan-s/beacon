import type { z } from 'zod';

/** Loose per-integration payload; stored as JSONB and rendered by per-integration UI. */
export type IntegrationDataSnapshot = Record<string, unknown>;

/** Presentation metadata for one attach-form field. Zod stays the validation
 *  source of truth; this drives the generic attach form (labels, masking, order). */
export type IntegrationFieldDef = {
  name: string; // must match a key in the section's Zod schema
  label: string;
  type: 'text' | 'password'; // 'password' renders masked
  section: 'credentials' | 'config'; // which Zod schema this field feeds
  placeholder?: string;
  optional?: boolean; // false/absent → required
};

export interface IntegrationDefinition<Creds = unknown, Config = unknown> {
  readonly id: string;
  readonly name: string;
  readonly credentialsSchema: z.ZodType<Creds>;
  readonly configSchema: z.ZodType<Config>;
  readonly fields: readonly IntegrationFieldDef[];
  testCredentials(credentials: Creds, config: Config): Promise<{ ok: true } | { ok: false; error: string }>;
  fetchData(credentials: Creds, config: Config): Promise<IntegrationDataSnapshot>;
}
