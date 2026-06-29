'use client';

import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createServiceAction, updateServiceAction } from '@/app/(app)/services/actions';

type Initial = { id?: string; name?: string; baseUrl?: string; healthCheckPath?: string };

export function ServiceFormDialog({
  service,
  triggerLabel,
  triggerVariant = 'default',
}: {
  service?: Initial;
  triggerLabel: string;
  triggerVariant?: 'default' | 'ghost';
}) {
  const isEdit = Boolean(service?.id);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') handleClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function onSubmit(formData: FormData) {
    setError(null);
    const input = {
      name: String(formData.get('name') ?? ''),
      baseUrl: String(formData.get('baseUrl') ?? ''),
      healthCheckPath: String(formData.get('healthCheckPath') || '/'),
    };
    start(async () => {
      const res = isEdit
        ? await updateServiceAction(service!.id!, input)
        : await createServiceAction(input);
      if (res.ok) setOpen(false);
      else setError(res.error);
    });
  }

  function handleClose() {
    if (pending) return;
    setOpen(false);
    setError(null);
  }

  return (
    <>
      <Button size="sm" variant={triggerVariant} onClick={() => setOpen(true)}>
        {triggerLabel}
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={isEdit ? 'Edit service' : 'Add a service'}
        >
          {/* Backdrop — click outside to close */}
          <div
            className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[2px]"
            onClick={handleClose}
            aria-hidden="true"
          />

          {/* Dialog panel */}
          <form
            action={onSubmit}
            className="relative z-10 w-full max-w-sm rounded-xl border border-zinc-200/80 bg-white shadow-2xl shadow-zinc-950/12"
          >
            {/* Header */}
            <div className="border-b border-zinc-100 px-5 py-4">
              <h2 className="text-[13px] font-semibold text-zinc-900">
                {isEdit ? 'Edit service' : 'Add a service'}
              </h2>
              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">
                {isEdit
                  ? 'Update the service configuration.'
                  : 'Beacon will start checking this endpoint within seconds.'}
              </p>
            </div>

            {/* Fields */}
            <div className="space-y-4 px-5 py-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="sfd-name"
                  className="block font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-400"
                >
                  Name
                </label>
                <Input
                  id="sfd-name"
                  name="name"
                  required
                  autoFocus
                  defaultValue={service?.name ?? ''}
                  placeholder="Wayfare"
                  className="h-8 text-[13px]"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="sfd-baseUrl"
                  className="block font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-400"
                >
                  Base URL
                </label>
                <Input
                  id="sfd-baseUrl"
                  name="baseUrl"
                  required
                  type="url"
                  defaultValue={service?.baseUrl ?? ''}
                  placeholder="https://wayfare.thiluxan.com"
                  className="h-8 font-mono text-[12px]"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="sfd-healthCheckPath"
                  className="block font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-400"
                >
                  Health check path
                </label>
                <Input
                  id="sfd-healthCheckPath"
                  name="healthCheckPath"
                  defaultValue={service?.healthCheckPath ?? '/'}
                  placeholder="/"
                  className="h-8 font-mono text-[12px]"
                />
              </div>

              {error && (
                <p className="rounded-md bg-red-50 px-3 py-2 text-[12px] text-status-down">
                  {error}
                </p>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 border-t border-zinc-100 px-5 py-3.5">
              <Button type="button" variant="ghost" size="sm" onClick={handleClose}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Add service'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
