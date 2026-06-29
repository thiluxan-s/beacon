'use client';

import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { ServiceFormDialog } from '@/components/services/service-form-dialog';
import { deleteServiceAction, pauseServiceAction } from '@/app/(app)/services/actions';
import type { ServiceDto } from '@/lib/services-api';

export function ServiceRowActions({ service }: { service: ServiceDto }) {
  const [pending, start] = useTransition();

  return (
    <div className="flex items-center gap-1">
      <ServiceFormDialog service={service} triggerLabel="Edit" triggerVariant="ghost" />
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await pauseServiceAction(service.id, !service.paused);
          })
        }
      >
        {service.paused ? 'Resume' : 'Pause'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        // Use --color-status-down token for destructive tint (aligns with design system)
        className="text-status-down/80 hover:bg-red-50 hover:text-status-down"
        onClick={() =>
          start(async () => {
            await deleteServiceAction(service.id);
          })
        }
      >
        Delete
      </Button>
    </div>
  );
}
