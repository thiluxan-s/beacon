import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertsConfigured, formatDowntime, openEmail, resolveEmail, sendEmail, type AlertTarget } from './email';
import { env } from './env';

const target: AlertTarget = {
  incidentId: 'inc-1', serviceName: 'Wayfare', failureDetail: 'HTTP 500',
  startedAt: new Date('2026-07-06T00:00:00.000Z'), resolvedAt: new Date('2026-07-06T00:05:00.000Z'),
  durationSeconds: 305, toEmail: 'me@e.com',
};

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('email builders', () => {
  it('formatDowntime renders s/m/h', () => {
    expect(formatDowntime(45)).toBe('45s');
    expect(formatDowntime(305)).toBe('5m 5s');
    expect(formatDowntime(3720)).toBe('1h 2m');
  });
  it('openEmail includes service, detail, and the incident link', () => {
    const { subject, text } = openEmail(target);
    expect(subject).toContain('Wayfare');
    expect(text).toContain('HTTP 500');
    expect(text).toContain(`${env.WEB_ORIGIN}/incidents/inc-1`);
  });
  it('resolveEmail includes recovery + downtime + link', () => {
    const { subject, text } = resolveEmail(target);
    expect(subject).toContain('Wayfare');
    expect(text).toContain('5m 5s');
    expect(text).toContain(`${env.WEB_ORIGIN}/incidents/inc-1`);
  });
});

describe('sendEmail', () => {
  it('no-ops when RESEND_API_KEY is unset', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    const res = await sendEmail({ to: 'a@b.com', subject: 's', text: 't' }, { fetchFn: (() => { throw new Error('should not call'); }) as unknown as typeof fetch });
    expect(res).toEqual({ ok: false, error: 'alerts disabled: email not configured' });
  });
  it('maps a non-2xx Resend response to failure', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test'); vi.stubEnv('ALERT_FROM_EMAIL', 'from@e.com');
    const fetchFn = vi.fn(async () => new Response('bad', { status: 422 })) as unknown as typeof fetch;
    const res = await sendEmail({ to: 'a@b.com', subject: 's', text: 't' }, { fetchFn });
    expect(res.ok).toBe(false);
  });
  it('returns ok on 2xx', async () => {
    vi.stubEnv('RESEND_API_KEY', 're_test'); vi.stubEnv('ALERT_FROM_EMAIL', 'from@e.com');
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const res = await sendEmail({ to: 'a@b.com', subject: 's', text: 't' }, { fetchFn });
    expect(res).toEqual({ ok: true });
  });
});
