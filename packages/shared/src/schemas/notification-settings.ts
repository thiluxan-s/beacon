import { z } from 'zod';

export const NotificationSettingsUpdateSchema = z.object({
  alertsEnabled: z.boolean().optional(),
  alertEmail: z.string().email().nullable().optional(),
});
export type NotificationSettingsUpdate = z.infer<typeof NotificationSettingsUpdateSchema>;
