import { findDueDomains, applyDomainCheckResult } from '../db/repositories/domains';
import { classifyDomain } from './domain-status';
import { probeRdap, probeSsl, resolveDns, type DnsResult, type RdapResult, type SslResult } from './domain-probes';
import { runBounded } from '../lib/concurrency';
import type { Domain } from '../db/schema';

const POLL_INTERVAL_MS = 30_000;
const BATCH_LIMIT = 100;
const MAX_CONCURRENCY = 5;
const MS_PER_DAY = 86_400_000;

export type ProbeDeps = {
  resolveDns?: (host: string) => Promise<DnsResult>;
  probeSsl?: (host: string) => Promise<SslResult>;
  probeRdap?: (domain: string) => Promise<RdapResult>;
};

const inFlight = new Set<string>();

export async function checkDomainOnce(domain: Domain, deps: ProbeDeps = {}): Promise<void> {
  const dnsFn = deps.resolveDns ?? resolveDns;
  const sslFn = deps.probeSsl ?? probeSsl;
  const rdapFn = deps.probeRdap ?? probeRdap;
  const now = new Date();

  const [dns, ssl, rdap] = await Promise.all([dnsFn(domain.domain), sslFn(domain.domain), rdapFn(domain.domain)]);

  const status = classifyDomain({ dnsResolved: dns.resolved, sslExpiresAt: ssl.expiresAt, domainExpiresAt: rdap.expiresAt, now });
  const sslDays = ssl.expiresAt ? Math.floor((ssl.expiresAt.getTime() - now.getTime()) / MS_PER_DAY) : null;
  const sslValid = ssl.expiresAt ? ssl.expiresAt.getTime() > now.getTime() : null;

  await applyDomainCheckResult({
    domain,
    check: {
      dnsResolved: dns.resolved,
      dnsIp: dns.ip,
      sslValid,
      sslExpiresAt: ssl.expiresAt,
      sslDaysUntilExpiry: sslDays,
      errorMessage: dns.error ?? ssl.error ?? rdap.error ?? null,
    },
    status,
    sslExpiresAt: ssl.expiresAt,
    domainExpiresAt: rdap.expiresAt,
    sslIssuer: ssl.issuer,
  });
}

export async function runDomainWorker(deps: ProbeDeps = {}): Promise<never> {
  while (true) {
    try {
      const due = await findDueDomains(BATCH_LIMIT);
      const runnable = due.filter((d) => !inFlight.has(d.id));
      await runBounded(runnable, MAX_CONCURRENCY, async (d) => {
        inFlight.add(d.id);
        try {
          await checkDomainOnce(d, deps);
        } catch (err) {
          // one domain's failure must never crash the loop
          console.error('[beacon-domain] check failed', d.id, err);
        } finally {
          inFlight.delete(d.id);
        }
      });
    } catch (err) {
      console.error('[beacon-domain] poll cycle failed', err);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}
