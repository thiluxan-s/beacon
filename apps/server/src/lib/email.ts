import { env } from './env';

export type AlertTarget = {
  incidentId: string;
  serviceName: string;
  failureDetail: string;
  startedAt: Date;
  resolvedAt: Date | null;
  durationSeconds: number | null;
  toEmail: string;
};

export type SendResult = { ok: true } | { ok: false; error: string };

// Read live from process.env (not the frozen `env`) so tests can toggle with vi.stubEnv.
function resendKey(): string | undefined { return process.env.RESEND_API_KEY || undefined; }
function fromEmail(): string | undefined { return process.env.ALERT_FROM_EMAIL || undefined; }

export function alertsConfigured(): boolean {
  return Boolean(resendKey() && fromEmail());
}

export function formatDowntime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function incidentLink(incidentId: string): string {
  return `${env.WEB_ORIGIN}/incidents/${incidentId}`;
}

export function openEmail(t: AlertTarget): { subject: string; text: string } {
  return {
    subject: `🔴 ${t.serviceName} is DOWN`,
    text:
      `${t.serviceName} is down.\n\n` +
      `Detail: ${t.failureDetail}\n` +
      `Since: ${t.startedAt.toISOString()}\n\n` +
      `Incident: ${incidentLink(t.incidentId)}\n`,
  };
}

export function resolveEmail(t: AlertTarget): { subject: string; text: string } {
  const downtime = t.durationSeconds != null ? formatDowntime(t.durationSeconds) : 'unknown';
  return {
    subject: `✅ ${t.serviceName} has recovered`,
    text:
      `${t.serviceName} is back up.\n\n` +
      `Downtime: ${downtime}\n\n` +
      `Incident: ${incidentLink(t.incidentId)}\n`,
  };
}

export async function sendEmail(
  input: { to: string; subject: string; text: string },
  deps: { fetchFn?: typeof fetch } = {},
): Promise<SendResult> {
  if (!alertsConfigured()) return { ok: false, error: 'alerts disabled: email not configured' };
  const fetchFn = deps.fetchFn ?? fetch;
  try {
    const res = await fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${resendKey()}` },
      body: JSON.stringify({ from: fromEmail(), to: input.to, subject: input.subject, text: input.text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[beacon-alert] resend non-2xx', res.status, body);
      return { ok: false, error: `resend ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error('[beacon-alert] resend request failed', err);
    return { ok: false, error: 'resend request failed' };
  }
}
