import { Webhook } from 'svix';
import { describe, expect, it, vi } from 'vitest';
import { handleClerkWebhook } from './clerk-webhook';

const SECRET = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

function sign(payload: string) {
  const id = 'msg_test';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const wh = new Webhook(SECRET);
  const signature = wh.sign(id, new Date(Number(timestamp) * 1000), payload);
  return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature };
}

describe('handleClerkWebhook', () => {
  it('rejects an invalid signature with 400', async () => {
    const upsertUser = vi.fn();
    const out = await handleClerkWebhook('{}', { 'svix-id': 'x', 'svix-timestamp': '1', 'svix-signature': 'bad' }, {
      webhookSecret: SECRET,
      upsertUser,
    });
    expect(out.status).toBe(400);
    expect(upsertUser).not.toHaveBeenCalled();
  });

  it('upserts on user.created', async () => {
    const payload = JSON.stringify({
      type: 'user.created',
      data: { id: 'user_42', email_addresses: [{ email_address: 'z@example.com' }] },
    });
    const upsertUser = vi.fn().mockResolvedValue(undefined);
    const out = await handleClerkWebhook(payload, sign(payload), { webhookSecret: SECRET, upsertUser });
    expect(out.status).toBe(200);
    expect(upsertUser).toHaveBeenCalledWith({ clerkUserId: 'user_42', email: 'z@example.com' });
  });

  it('ignores unsubscribed event types with 200 { ignored: true }', async () => {
    const payload = JSON.stringify({ type: 'session.created', data: { id: 's_1' } });
    const upsertUser = vi.fn();
    const out = await handleClerkWebhook(payload, sign(payload), { webhookSecret: SECRET, upsertUser });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ignored: true });
    expect(upsertUser).not.toHaveBeenCalled();
  });
});
