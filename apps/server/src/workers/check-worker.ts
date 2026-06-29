import { applyCheckResult, findDueServices } from '../db/repositories/services';
import { runBounded } from '../lib/concurrency';
import type { Service } from '../db/schema';
import { classifyCheck, type ClassifyInput } from './check-classify';

const POLL_INTERVAL_MS = 5_000;
const BATCH_LIMIT = 100;
const MAX_CONCURRENCY = 10;

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
    newStatus: r.serviceStatus,
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
    } catch (err) {
      console.error('[beacon-worker] poll cycle failed', err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
