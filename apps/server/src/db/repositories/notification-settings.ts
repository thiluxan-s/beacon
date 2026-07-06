import { eq } from 'drizzle-orm';
import type { NotificationSettingsUpdate } from '@beacon/shared';
import { db } from '../index';
import { notificationSettings, users } from '../schema';

export async function getResolvedSettings(userId: string): Promise<{ alertsEnabled: boolean; alertEmail: string }> {
  const rows = await db
    .select({
      alertsEnabled: notificationSettings.alertsEnabled,
      alertEmail: notificationSettings.alertEmail,
      userEmail: users.email,
    })
    .from(users)
    .leftJoin(notificationSettings, eq(notificationSettings.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);
  const r = rows[0];
  if (!r) return { alertsEnabled: true, alertEmail: '' };
  return { alertsEnabled: r.alertsEnabled ?? true, alertEmail: r.alertEmail ?? r.userEmail };
}

export async function upsertSettings(userId: string, patch: NotificationSettingsUpdate): Promise<void> {
  await db
    .insert(notificationSettings)
    .values({
      userId,
      alertsEnabled: patch.alertsEnabled ?? true,
      alertEmail: patch.alertEmail ?? null,
    })
    .onConflictDoUpdate({
      target: notificationSettings.userId,
      set: {
        ...(patch.alertsEnabled !== undefined ? { alertsEnabled: patch.alertsEnabled } : {}),
        ...(patch.alertEmail !== undefined ? { alertEmail: patch.alertEmail } : {}),
        updatedAt: new Date(),
      },
    });
}
