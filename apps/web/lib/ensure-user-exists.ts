import 'server-only';
import { currentUser } from '@clerk/nextjs/server';

export async function upsertUserOnServer(input: {
  clerkUserId: string;
  email: string;
}): Promise<void> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/internal/users/upsert`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '',
    },
    body: JSON.stringify(input),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`upsertUserOnServer failed: ${res.status}`);
}

export async function ensureUserExists(): Promise<void> {
  const user = await currentUser();
  if (!user) return;
  const email = user.emailAddresses[0]?.emailAddress ?? '';
  try {
    await upsertUserOnServer({ clerkUserId: user.id, email });
  } catch {
    // Non-fatal: the webhook is the primary path; log-and-continue keeps the page rendering.
  }
}
