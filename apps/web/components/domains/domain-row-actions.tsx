'use client';

import { useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { deleteDomainAction, recheckDomainAction } from '@/app/(app)/domains/actions';

export function DomainRowActions({ id }: { id: string }) {
  const [pending, start] = useTransition();

  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await recheckDomainAction(id);
          })
        }
      >
        Recheck
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        // Use --color-status-down token for destructive tint (aligns with design system)
        className="text-status-down/80 hover:bg-red-50 hover:text-status-down"
        onClick={() =>
          start(async () => {
            await deleteDomainAction(id);
          })
        }
      >
        Delete
      </Button>
    </div>
  );
}
