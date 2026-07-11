'use client';

import { useState, useTransition } from 'react';

import type { ServiceDto } from '@/lib/services-api';
import type { DomainDto } from '@/lib/domains-api';
import { toggleServicePublicAction, toggleDomainPublicAction } from '@/app/(app)/settings/actions';

function PublicToggle({
  initial,
  onToggle,
}: {
  initial: boolean;
  onToggle: (next: boolean) => Promise<{ ok: boolean }>;
}) {
  const [isPublic, setIsPublic] = useState(initial);
  const [pending, start] = useTransition();

  return (
    <label className="flex min-h-11 items-center gap-2 sm:min-h-0">
      <input
        type="checkbox"
        checked={isPublic}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.checked;
          setIsPublic(next);
          start(async () => {
            const res = await onToggle(next);
            if (!res.ok) setIsPublic(!next); // revert on failure
          });
        }}
        className="h-3.5 w-3.5 rounded-[3px] border-zinc-300 accent-status-up"
      />
      <span className="text-[11px] text-zinc-500">public</span>
    </label>
  );
}

export function ServicePublicToggle({ service }: { service: ServiceDto }) {
  return <PublicToggle initial={service.isPublic} onToggle={(next) => toggleServicePublicAction(service.id, next)} />;
}

export function DomainPublicToggle({ domain }: { domain: DomainDto }) {
  return <PublicToggle initial={domain.isPublic} onToggle={(next) => toggleDomainPublicAction(domain.id, next)} />;
}
