import 'server-only';
import { serverApiBaseUrl } from './api-base';

export type NotificationSettingsDto = { alertsEnabled: boolean; alertEmail: string };

function headers(clerkUserId: string): HeadersInit {
  return { 'content-type': 'application/json', 'x-internal-secret': process.env.INTERNAL_API_SECRET ?? '', 'x-clerk-user-id': clerkUserId };
}

export async function fetchNotificationSettings(clerkUserId: string): Promise<NotificationSettingsDto> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/notification-settings`, { headers: headers(clerkUserId), cache: 'no-store' });
  if (!res.ok) throw new Error(`fetchNotificationSettings failed: ${res.status}`);
  return (await res.json()) as NotificationSettingsDto;
}

export async function updateNotificationSettings(
  clerkUserId: string,
  patch: { alertsEnabled?: boolean; alertEmail?: string | null },
): Promise<NotificationSettingsDto> {
  const res = await fetch(`${serverApiBaseUrl()}/internal/notification-settings`, {
    method: 'PUT', headers: headers(clerkUserId), body: JSON.stringify(patch), cache: 'no-store',
  });
  if (!res.ok) throw new Error(`updateNotificationSettings failed: ${res.status}`);
  return (await res.json()) as NotificationSettingsDto;
}
