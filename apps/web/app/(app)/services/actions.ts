'use server';

import { currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { ServiceCreateSchema, ServiceUpdateSchema } from '@beacon/shared';

import {
  attachIntegration,
  createServiceOnServer,
  deleteServiceOnServer,
  pauseServiceOnServer,
  removeIntegration,
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

export async function attachVercelAction(
  serviceId: string,
  input: { apiToken: string; projectId: string; teamId?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const user = await currentUser();
    if (!user) return { ok: false, error: 'Not signed in' };
    const config: Record<string, unknown> = { projectId: input.projectId };
    if (input.teamId) config.teamId = input.teamId;
    const res = await attachIntegration(user.id, serviceId, { integrationId: 'vercel', config, credentials: { apiToken: input.apiToken } });
    if (res.ok) revalidatePath(`/services/${serviceId}`);
    return res;
  } catch (err) {
    console.error('[beacon-web] attachVercelAction failed', err);
    return { ok: false, error: 'Could not attach Vercel integration.' };
  }
}

export async function removeIntegrationAction(serviceId: string, integrationId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const user = await currentUser();
    if (!user) return { ok: false, error: 'Not signed in' };
    await removeIntegration(user.id, serviceId, integrationId);
    revalidatePath(`/services/${serviceId}`);
    return { ok: true };
  } catch (err) {
    console.error('[beacon-web] removeIntegrationAction failed', err);
    return { ok: false, error: 'Could not remove the integration.' };
  }
}
