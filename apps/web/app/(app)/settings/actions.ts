'use server';

import { currentUser } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { NotificationSettingsUpdateSchema } from '@beacon/shared';

import { updateNotificationSettings } from '@/lib/notification-settings-api';
import { updateServiceOnServer } from '@/lib/services-api';
import { setDomainPublicOnServer } from '@/lib/domains-api';

type Result = { ok: true } | { ok: false; error: string };

async function requireClerkId(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new Error('not authenticated');
  return user.id;
}

export async function updateAlertSettingsAction(patch: unknown): Promise<Result> {
  const parsed = NotificationSettingsUpdateSchema.safeParse(patch);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  try {
    const clerkId = await requireClerkId();
    await updateNotificationSettings(clerkId, parsed.data);
    revalidatePath('/settings');
    return { ok: true };
  } catch (err) {
    console.error('[beacon-web] updateAlertSettingsAction failed', err);
    return { ok: false, error: 'Could not save settings.' };
  }
}

export async function toggleServiceAlertsAction(serviceId: string, alertsEnabled: boolean): Promise<Result> {
  try {
    const clerkId = await requireClerkId();
    await updateServiceOnServer(clerkId, serviceId, { alertsEnabled });
    revalidatePath('/settings');
    return { ok: true };
  } catch (err) {
    console.error('[beacon-web] toggleServiceAlertsAction failed', err);
    return { ok: false, error: 'Could not update the service.' };
  }
}

export async function toggleServicePublicAction(id: string, isPublic: boolean): Promise<Result> {
  try {
    const clerkId = await requireClerkId();
    await updateServiceOnServer(clerkId, id, { isPublic });
    revalidatePath('/settings');
    revalidatePath('/demo');
    return { ok: true };
  } catch (err) {
    console.error('[beacon-web] toggleServicePublicAction failed', err);
    return { ok: false, error: 'Could not update visibility.' };
  }
}

export async function toggleDomainPublicAction(id: string, isPublic: boolean): Promise<Result> {
  try {
    const clerkId = await requireClerkId();
    await setDomainPublicOnServer(clerkId, id, isPublic);
    revalidatePath('/settings');
    revalidatePath('/demo');
    return { ok: true };
  } catch (err) {
    console.error('[beacon-web] toggleDomainPublicAction failed', err);
    return { ok: false, error: 'Could not update visibility.' };
  }
}
