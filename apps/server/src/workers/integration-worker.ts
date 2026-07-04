import { findDueIntegrations, recordFetchError, recordFetchSuccess } from '../db/repositories/service-integrations';
import { IntegrationRegistry } from '../integrations/registry';
import type { IntegrationDefinition } from '../integrations/types';
import { decrypt } from '../lib/crypto';

const DUE_AFTER_MS = 5 * 60_000; // fetch each integration at most every 5 minutes
const POLL_INTERVAL_MS = 60_000; // wake once a minute to find due work
const BATCH = 20;

export async function processDueIntegrations(
  deps: { registry?: Map<string, IntegrationDefinition> } = {},
): Promise<void> {
  const registry = deps.registry ?? IntegrationRegistry;
  const due = await findDueIntegrations(DUE_AFTER_MS, BATCH);
  for (const row of due) {
    try {
      const def = registry.get(row.integrationId);
      if (!def) {
        await recordFetchError(row.id, `Unknown integration '${row.integrationId}'`);
        continue;
      }
      const credentials = def.credentialsSchema.parse(JSON.parse(decrypt(row.credentialsEncrypted)));
      const config = def.configSchema.parse(row.config);
      const snapshot = await def.fetchData(credentials, config);
      await recordFetchSuccess(row.id, snapshot);
    } catch (err) {
      // Never let one integration's failure stop the batch.
      const msg = err instanceof Error ? err.message : 'fetch failed';
      await recordFetchError(row.id, msg).catch(() => undefined);
    }
  }
}

export async function runIntegrationWorker(): Promise<never> {
  for (;;) {
    try {
      await processDueIntegrations();
    } catch (err) {
      console.error('[beacon-worker] integration pass failed', err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
