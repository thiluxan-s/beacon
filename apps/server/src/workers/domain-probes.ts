import { promises as dnsPromises } from 'node:dns';
import { connect as tlsConnect, type PeerCertificate } from 'node:tls';

export type DnsResult = { resolved: boolean; ip: string | null; error?: string };
export type SslResult = { expiresAt: Date | null; issuer: string | null; error?: string };
export type RdapResult = { expiresAt: Date | null; error?: string };
export type CertLike = { valid_to?: string; issuer?: { O?: string; CN?: string } } | null;

const PROBE_TIMEOUT_MS = 10_000;

export function parseRdapExpiration(json: unknown): Date | null {
  if (typeof json !== 'object' || json === null) return null;
  const events = (json as { events?: unknown }).events;
  if (!Array.isArray(events)) return null;
  for (const ev of events) {
    if (ev && typeof ev === 'object' && (ev as { eventAction?: unknown }).eventAction === 'expiration') {
      const date = (ev as { eventDate?: unknown }).eventDate;
      if (typeof date === 'string') {
        const d = new Date(date);
        if (!Number.isNaN(d.getTime())) return d;
      }
    }
  }
  return null;
}

export function parseCertExpiry(cert: CertLike): { expiresAt: Date | null; issuer: string | null } {
  if (!cert || typeof cert.valid_to !== 'string') return { expiresAt: null, issuer: null };
  const d = new Date(cert.valid_to);
  const expiresAt = Number.isNaN(d.getTime()) ? null : d;
  const issuer = cert.issuer?.O ?? cert.issuer?.CN ?? null;
  return { expiresAt, issuer };
}

export async function resolveDns(
  host: string,
  deps: { lookup?: (h: string) => Promise<{ address: string }> } = {},
): Promise<DnsResult> {
  const lookup = deps.lookup ?? ((h: string) => dnsPromises.lookup(h));
  try {
    const res = await lookup(host);
    return { resolved: true, ip: res.address ?? null };
  } catch (err) {
    return { resolved: false, ip: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// Default cert fetch: TLS-connect on 443 with rejectUnauthorized:false so an
// expired cert still yields its valid_to. Boundary adapter — the parsing it
// feeds (parseCertExpiry) is what's unit-tested; this socket code is injected
// past in tests via deps.getCert.
function defaultGetCert(host: string): Promise<CertLike> {
  return new Promise<CertLike>((resolve) => {
    let settled = false;
    const finish = (v: CertLike) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already closed */ }
      resolve(v);
    };
    const socket = tlsConnect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate() as PeerCertificate | undefined;
      finish(cert && Object.keys(cert).length > 0 ? (cert as CertLike) : null);
    });
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish(null));
    socket.on('error', () => finish(null));
  });
}

export async function probeSsl(
  host: string,
  deps: { getCert?: (h: string) => Promise<CertLike> } = {},
): Promise<SslResult> {
  const getCert = deps.getCert ?? defaultGetCert;
  try {
    const cert = await getCert(host);
    return parseCertExpiry(cert);
  } catch (err) {
    return { expiresAt: null, issuer: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function rdapCandidates(domain: string): string[] {
  const labels = domain.split('.');
  if (labels.length <= 2) return [domain];
  return [domain, labels.slice(-2).join('.')];
}

export async function probeRdap(
  domain: string,
  deps: { fetchFn?: typeof fetch } = {},
): Promise<RdapResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  for (const cand of rdapCandidates(domain)) {
    try {
      const res = await fetchFn(`https://rdap.org/domain/${encodeURIComponent(cand)}`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const exp = parseRdapExpiration(await res.json());
      if (exp) return { expiresAt: exp };
    } catch {
      // try the next candidate
    }
  }
  return { expiresAt: null };
}
