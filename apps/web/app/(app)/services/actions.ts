'use server';

import { currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { ServiceCreateSchema, ServiceUpdateSchema } from '@beacon/shared';

import {
  createServiceOnServer,
  deleteServiceOnServer,
  pauseServiceOnServer,
  updateServiceOnServer,
} from '@/lib/services-api';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function requireClerkId(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error('not authenticated');
  return user.id;
}

export async function createServiceAction(input: unknown): Promise<Result<{ id: string }>> {
  const parsed = ServiceCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  try {
    const clerkId = await requireClerkId();
    const svc = await createServiceOnServer(clerkId, parsed.data);
    revalidatePath('/services');
    return { ok: true, data: { id: svc.id } };
  } catch (err) {
    console.error('[beacon-web] createServiceAction failed', err);
    return { ok: false, error: 'Could not create the service.' };
  }
}

export async function updateServiceAction(id: string, patch: unknown): Promise<Result<{ id: string }>> {
  const parsed = ServiceUpdateSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  try {
    const clerkId = await requireClerkId();
    const svc = await updateServiceOnServer(clerkId, id, parsed.data);
    revalidatePath('/services');
    return { ok: true, data: { id: svc.id } };
  } catch (err) {
    console.error('[beacon-web] updateServiceAction failed', err);
    return { ok: false, error: 'Could not update the service.' };
  }
}

export async function deleteServiceAction(id: string): Promise<Result<null>> {
  try {
    const clerkId = await requireClerkId();
    await deleteServiceOnServer(clerkId, id);
    revalidatePath('/services');
    return { ok: true, data: null };
  } catch (err) {
    console.error('[beacon-web] deleteServiceAction failed', err);
    return { ok: false, error: 'Could not delete the service.' };
  }
}

export async function pauseServiceAction(id: string, paused: boolean): Promise<Result<null>> {
  try {
    const clerkId = await requireClerkId();
    await pauseServiceOnServer(clerkId, id, paused);
    revalidatePath('/services');
    return { ok: true, data: null };
  } catch (err) {
    console.error('[beacon-web] pauseServiceAction failed', err);
    return { ok: false, error: 'Could not update the service.' };
  }
}
