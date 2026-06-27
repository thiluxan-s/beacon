import { handleClerkWebhook } from '@/lib/clerk-webhook';
import { upsertUserOnServer } from '@/lib/ensure-user-exists';

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const out = await handleClerkWebhook(
    rawBody,
    {
      'svix-id': req.headers.get('svix-id') ?? '',
      'svix-timestamp': req.headers.get('svix-timestamp') ?? '',
      'svix-signature': req.headers.get('svix-signature') ?? '',
    },
    {
      webhookSecret: process.env.CLERK_WEBHOOK_SECRET ?? '',
      upsertUser: upsertUserOnServer,
    },
  );
  return Response.json(out.body, { status: out.status });
}
