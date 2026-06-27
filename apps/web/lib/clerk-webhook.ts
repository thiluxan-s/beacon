import { Webhook } from 'svix';

type WebhookDeps = {
  webhookSecret: string;
  upsertUser: (input: { clerkUserId: string; email: string }) => Promise<void>;
};

type ClerkUserEvent = {
  type: string;
  data: { id: string; email_addresses?: { email_address: string }[] };
};

export async function handleClerkWebhook(
  rawBody: string,
  headers: { 'svix-id'?: string; 'svix-timestamp'?: string; 'svix-signature'?: string },
  deps: WebhookDeps,
): Promise<{ status: number; body: unknown }> {
  const wh = new Webhook(deps.webhookSecret);
  let evt: ClerkUserEvent;
  try {
    evt = wh.verify(rawBody, {
      'svix-id': headers['svix-id'] ?? '',
      'svix-timestamp': headers['svix-timestamp'] ?? '',
      'svix-signature': headers['svix-signature'] ?? '',
    }) as ClerkUserEvent;
  } catch {
    return { status: 400, body: { error: 'invalid signature' } };
  }

  if (evt.type === 'user.created' || evt.type === 'user.updated') {
    const email = evt.data.email_addresses?.[0]?.email_address ?? '';
    await deps.upsertUser({ clerkUserId: evt.data.id, email });
    return { status: 200, body: { ok: true } };
  }
  return { status: 200, body: { ignored: true } };
}
