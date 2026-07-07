'use server';

import { currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { DomainCreateSchema } from '@beacon/shared';

import { createDomainOnServer, deleteDomainOnServer, recheckDomainOnServer } from '@/lib/domains-api';

type Result = { ok: true } | { ok: false; error: string };

async function requireClerkId(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error('not authenticated');
  return user.id;
}

export async function createDomainAction(input: unknown): Promise<Result> {
  const parsed = DomainCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  try {
    const clerkId = await requireClerkId();
    const res = await createDomainOnServer(clerkId, { domain: parsed.data.domain });
    if (res.ok) revalidatePath('/domains');
    return res;
  } catch (err) {
    console.error('[beacon-web] createDomainAction failed', err);
    return { ok: false, error: 'Could not add the domain.' };
  }
}

export async function deleteDomainAction(id: string): Promise<Result> {
  try {
    const clerkId = await requireClerkId();
    await deleteDomainOnServer(clerkId, id);
    revalidatePath('/domains');
    return { ok: true };
  } catch (err) {
    console.error('[beacon-web] deleteDomainAction failed', err);
    return { ok: false, error: 'Could not delete the domain.' };
  }
}

export async function recheckDomainAction(id: string): Promise<Result> {
  try {
    const clerkId = await requireClerkId();
    await recheckDomainOnServer(clerkId, id);
    revalidatePath('/domains');
    return { ok: true };
  } catch (err) {
    console.error('[beacon-web] recheckDomainAction failed', err);
    return { ok: false, error: 'Could not recheck the domain.' };
  }
}
