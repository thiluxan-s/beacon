'use client';

import { useEffect, useState, useTransition, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createDomainAction } from '@/app/(app)/domains/actions';
import { useFocusTrap } from '@/lib/use-focus-trap';

export function DomainFormDialog() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const trapRef = useFocusTrap(open);

  function handleClose() {
    if (pending) return;
    setOpen(false);
    setError(null);
  }

  // Close on Escape. Include `pending` in deps so the listener re-registers
  // when a save starts/completes, ensuring the in-flight guard is never stale.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (pending) return;
      setOpen(false);
      setError(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, pending]);

  function onSubmit(formData: FormData) {
    setError(null);
    const domain = String(formData.get('domain') ?? '');
    start(async () => {
      const res = await createDomainAction({ domain });
      if (res.ok) setOpen(false);
      else setError(res.error);
    });
  }

  return (
    <>
      <Button size="sm" className="min-h-11 sm:min-h-7" onClick={() => setOpen(true)}>
        Add domain
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Add a domain"
        >
          {/* Backdrop — click outside to close */}
          <div
            className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[2px]"
            onClick={handleClose}
            aria-hidden="true"
          />

          {/* Dialog panel */}
          <form
            ref={trapRef as RefObject<HTMLFormElement | null>}
            action={onSubmit}
            className="relative z-10 w-full max-w-sm rounded-xl border border-zinc-200/80 bg-white shadow-2xl shadow-zinc-950/12"
          >
            {/* Header */}
            <div className="border-b border-zinc-100 px-5 py-4">
              <h2 className="text-[13px] font-semibold text-zinc-900">Add a domain</h2>
              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">
                Beacon will check DNS, SSL, and registration within a minute.
              </p>
            </div>

            {/* Fields */}
            <div className="space-y-4 px-5 py-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="dfd-domain"
                  className="block font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-400"
                >
                  Domain
                </label>
                <Input
                  id="dfd-domain"
                  name="domain"
                  required
                  placeholder="thiluxan.com"
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
                {pending ? 'Adding…' : 'Add domain'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
