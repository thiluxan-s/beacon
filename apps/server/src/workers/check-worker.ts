import { applyCheckResult, deleteChecksOlderThan, findDueServices } from '../db/repositories/services';
import { runBounded } from '../lib/concurrency';
import type { Service } from '../db/schema';
import { classifyCheck, type ClassifyInput } from './check-classify';

const POLL_INTERVAL_MS = 5_000;
const BATCH_LIMIT = 100;
const MAX_CONCURRENCY = 10;

// Prune check history older than this once a day so the table stays bounded.
const CHECK_RETENTION_DAYS = 30;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastCleanupAt = 0;

type CheckDeps = { fetchFn?: typeof fetch; apply?: typeof applyCheckResult };

// Module-scoped in-flight guard: tracks service IDs currently being checked.
// Prevents duplicate concurrent checks of the same service when a check takes
// longer than the poll interval (default timeout 10s > 5s poll).
const inFlight = new Set<string>();

export async function checkOne(service: Service, deps: CheckDeps = {}): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const apply = deps.apply ?? applyCheckResult;
  const url = `${service.baseUrl}${service.healthCheckPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), service.timeoutSeconds * 1000);
  const startedAt = Date.now();

  let input: ClassifyInput;
  try {
    const res = await fetchFn(url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    input = {
      outcome: 'response',
      statusCode: res.status,
      responseTimeMs: Date.now() - startedAt,
      expectedStatusCodes: service.expectedStatusCodes,
    };
    // Drain the body to release the socket; guard so it can't throw past the timing capture.
    await res.body?.cancel().catch(() => undefined);
  } catch (err) {
    if (controller.signal.aborted) {
      input = { outcome: 'timeout', responseTimeMs: Date.now() - startedAt };
    } else {
      input = { outcome: 'error', errorMessage: err instanceof Error ? err.message : String(err) };
    }
  } finally {
    clearTimeout(timer);
  }

  const r = classifyCheck(input);
  await apply({
    service,
    check: { status: r.status, statusCode: r.statusCode, responseTimeMs: r.responseTimeMs, errorMessage: r.errorMessage },
    rawStatus: r.serviceStatus,
  });
}

export async function runWorker(): Promise<never> {
  while (true) {
    try {
      const due = await findDueServices(BATCH_LIMIT);
      // Skip services already being checked to prevent duplicate concurrent checks.
      const runnable = due.filter((s) => !inFlight.has(s.id));
      await runBounded(runnable, MAX_CONCURRENCY, async (svc) => {
        inFlight.add(svc.id);
        try {
          await checkOne(svc);
        } catch (err) {
          // A single check must never crash the loop.
          console.error('[beacon-worker] check failed', svc.id, err);
        } finally {
          inFlight.delete(svc.id);
        }
      });

      // Daily maintenance: prune old check history. Runs at most once per 24h and
      // never blocks or crashes the poll loop on failure.
      if (Date.now() - lastCleanupAt > CLEANUP_INTERVAL_MS) {
        lastCleanupAt = Date.now();
        try {
          const removed = await deleteChecksOlderThan(CHECK_RETENTION_DAYS);
          if (removed > 0) console.log(`[beacon-worker] pruned ${removed} old service_checks`);
        } catch (err) {
          console.error('[beacon-worker] cleanup failed', err);
        }
      }
    } catch (err) {
      console.error('[beacon-worker] poll cycle failed', err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
