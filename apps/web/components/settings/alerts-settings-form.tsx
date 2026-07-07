'use client';

import { useState, useTransition } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { NotificationSettingsDto } from '@/lib/notification-settings-api';
import { updateAlertSettingsAction } from '@/app/(app)/settings/actions';

export function AlertsSettingsForm({ initial }: { initial: NotificationSettingsDto }) {
  const [enabled, setEnabled] = useState(initial.alertsEnabled);
  const [email, setEmail] = useState('');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function save(next: { alertsEnabled?: boolean; alertEmail?: string | null }) {
    setError(null);
    start(async () => {
      const res = await updateAlertSettingsAction(next);
      if (!res.ok) setError(res.error);
    });
  }

  return (
    <div className="flex flex-col gap-4 px-5 pb-4">
      <label className="flex items-center gap-2.5">
        <input
          type="checkbox"
          checked={enabled}
          disabled={pending}
          onChange={(e) => { setEnabled(e.target.checked); save({ alertsEnabled: e.target.checked }); }}
          className="h-3.5 w-3.5 rounded-[3px] border-zinc-300 accent-status-up"
        />
        <span className="text-[13px] font-medium text-zinc-900">Email me when a service goes down</span>
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">Destination email</span>
        <div className="flex items-center gap-2">
          <Input
            type="email"
            value={email}
            placeholder={initial.alertEmail}
            disabled={pending}
            onChange={(e) => setEmail(e.target.value)}
            className="max-w-[280px]"
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            // Blank submit clears any override (alertEmail: null) → falls back to the
            // account email, matching the helper text below. A value sets the override.
            onClick={() => save({ alertEmail: email.trim() === '' ? null : email.trim() })}
          >
            Save
          </Button>
        </div>
        <span className="text-[11px] text-zinc-400">Leave blank to use your account email ({initial.alertEmail}).</span>
      </div>

      {error && <p className="text-[12px] text-status-down">{error}</p>}
    </div>
  );
}
