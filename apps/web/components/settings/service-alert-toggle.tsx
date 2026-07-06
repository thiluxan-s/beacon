'use client';

import { useState, useTransition } from 'react';

import type { ServiceDto } from '@/lib/services-api';
import { toggleServiceAlertsAction } from '@/app/(app)/settings/actions';

export function ServiceAlertToggle({ service }: { service: ServiceDto }) {
  const [enabled, setEnabled] = useState(service.alertsEnabled);
  const [pending, start] = useTransition();

  return (
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={enabled}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          setEnabled(next);
          start(async () => { await toggleServiceAlertsAction(service.id, next); });
        }}
        className="h-3.5 w-3.5 rounded-[3px] border-zinc-300 accent-status-up"
      />
      <span className="text-[11px] text-zinc-500">alerts</span>
    </label>
  );
}
