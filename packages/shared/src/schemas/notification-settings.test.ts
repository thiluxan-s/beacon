import { describe, expect, it } from 'vitest';
import { NotificationSettingsUpdateSchema } from './notification-settings';

describe('NotificationSettingsUpdateSchema', () => {
  it('accepts a partial update', () => {
    expect(NotificationSettingsUpdateSchema.safeParse({ alertsEnabled: false }).success).toBe(true);
    expect(NotificationSettingsUpdateSchema.safeParse({ alertEmail: 'x@y.com' }).success).toBe(true);
    expect(NotificationSettingsUpdateSchema.safeParse({ alertEmail: null }).success).toBe(true);
    expect(NotificationSettingsUpdateSchema.safeParse({}).success).toBe(true);
  });
  it('rejects a bad email', () => {
    expect(NotificationSettingsUpdateSchema.safeParse({ alertEmail: 'nope' }).success).toBe(false);
  });
});
