'use client';

import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { attachVercelAction } from '@/app/(app)/services/actions';

export function IntegrationAttachDialog({ serviceId }: { serviceId: string }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

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
    const input = {
      apiToken: String(formData.get('apiToken') ?? ''),
      projectId: String(formData.get('projectId') ?? ''),
      teamId: String(formData.get('teamId') ?? '').trim() || undefined,
    };
    start(async () => {
      const res = await attachVercelAction(serviceId, input);
      if (res.ok) setOpen(false);
      else setError(res.error);
    });
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Attach Vercel
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Attach Vercel integration"
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
              <h2 className="text-[13px] font-semibold text-zinc-900">Attach Vercel</h2>
              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">
                Beacon will validate the token before saving.
              </p>
            </div>

            {/* Fields */}
            <div className="space-y-4 px-5 py-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="iad-apiToken"
                  className="block font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-400"
                >
                  API token
                </label>
                <Input
                  id="iad-apiToken"
                  name="apiToken"
                  type="password"
                  required
                  autoFocus
                  placeholder="••••••••••••"
                  className="h-8 font-mono text-[12px]"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="iad-projectId"
                  className="block font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-400"
                >
                  Project ID
                </label>
                <Input
                  id="iad-projectId"
                  name="projectId"
                  required
                  placeholder="prj_abc123"
                  className="h-8 font-mono text-[12px]"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="iad-teamId"
                  className="block font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-400"
                >
                  Team ID <span className="normal-case text-zinc-300">(optional)</span>
                </label>
                <Input
                  id="iad-teamId"
                  name="teamId"
                  placeholder="team_abc123"
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
                {pending ? 'Attaching…' : 'Attach'}
              </Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
