'use client';

import { useEffect, useState, useTransition, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { attachIntegrationAction } from '@/app/(app)/services/actions';
import type { AvailableIntegration } from '@/lib/services-api';
import { useFocusTrap } from '@/lib/use-focus-trap';

export function IntegrationAttachDialog({
  serviceId,
  available,
}: {
  serviceId: string;
  available: AvailableIntegration[];
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const active = activeId ? (available.find((i) => i.id === activeId) ?? null) : null;
  const trapRef = useFocusTrap(Boolean(active));

  function close() {
    if (pending) return;
    setActiveId(null);
    setError(null);
  }

  // Re-register on `active`/`pending` so the in-flight guard is never stale.
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || pending) return;
      setActiveId(null);
      setError(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, pending]);

  function onSubmit(formData: FormData) {
    if (!active) return;
    setError(null);
    const credentials: Record<string, unknown> = {};
    const config: Record<string, unknown> = {};
    for (const f of active.fields) {
      const value = String(formData.get(f.name) ?? '').trim();
      if (f.optional && value === '') continue; // omit blank optional fields
      (f.section === 'credentials' ? credentials : config)[f.name] = value;
    }
    start(async () => {
      const res = await attachIntegrationAction(serviceId, active.id, { credentials, config });
      if (res.ok) setActiveId(null);
      else setError(res.error);
    });
  }

  return (
    <>
      <div className="relative">
        <Button
          size="sm"
          variant="ghost"
          className="min-h-11 sm:min-h-7"
          onClick={() => setMenuOpen((o) => !o)}
        >
          Attach ▾
        </Button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 z-50 mt-1 w-32 overflow-hidden rounded-lg border border-zinc-200/80 bg-white py-1 shadow-lg shadow-zinc-950/10">
              {available.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-[12px] text-zinc-700 hover:bg-zinc-50"
                  onClick={() => {
                    setMenuOpen(false);
                    setError(null);
                    setActiveId(i.id);
                  }}
                >
                  {i.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {active && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Attach ${active.name}`}
        >
          <div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[2px]" onClick={close} aria-hidden="true" />
          <form
            ref={trapRef as RefObject<HTMLFormElement | null>}
            action={onSubmit}
            className="relative z-10 w-full max-w-sm rounded-xl border border-zinc-200/80 bg-white shadow-2xl shadow-zinc-950/12"
          >
            <div className="border-b border-zinc-100 px-5 py-4">
              <h2 className="text-[13px] font-semibold text-zinc-900">Attach {active.name}</h2>
              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">Beacon will validate before saving.</p>
            </div>

            <div className="space-y-4 px-5 py-4">
              {active.fields.map((f) => (
                <div key={f.name} className="space-y-1.5">
                  <label
                    htmlFor={`iad-${f.name}`}
                    className="block font-mono text-[10px] uppercase tracking-[0.1em] text-zinc-400"
                  >
                    {f.label}
                    {f.optional && <span className="normal-case text-zinc-300"> (optional)</span>}
                  </label>
                  <Input
                    id={`iad-${f.name}`}
                    name={f.name}
                    type={f.type}
                    required={!f.optional}
                    placeholder={f.placeholder}
                    className="h-8 font-mono text-[12px]"
                  />
                </div>
              ))}

              {error && <p className="rounded-md bg-red-50 px-3 py-2 text-[12px] text-status-down">{error}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-zinc-100 px-5 py-3.5">
              <Button type="button" variant="ghost" size="sm" onClick={close}>
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
