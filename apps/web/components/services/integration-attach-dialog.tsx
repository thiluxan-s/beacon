'use client';

import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { attachGithubAction, attachVercelAction } from '@/app/(app)/services/actions';

type Kind = 'vercel' | 'github';
type FieldDef = { name: string; label: string; type: 'text' | 'password'; placeholder: string; optional?: boolean };
type Result = { ok: true } | { ok: false; error: string };

type KindDef = {
  title: string;
  fields: FieldDef[];
  submit: (serviceId: string, values: Record<string, string>) => Promise<Result>;
};

const KINDS: Record<Kind, KindDef> = {
  vercel: {
    title: 'Attach Vercel',
    fields: [
      { name: 'apiToken', label: 'API token', type: 'password', placeholder: '••••••••••••' },
      { name: 'projectId', label: 'Project ID', type: 'text', placeholder: 'prj_abc123' },
      { name: 'teamId', label: 'Team ID', type: 'text', placeholder: 'team_abc123', optional: true },
    ],
    submit: (serviceId, v) =>
      attachVercelAction(serviceId, {
        apiToken: v.apiToken ?? '',
        projectId: v.projectId ?? '',
        teamId: (v.teamId ?? '').trim() || undefined,
      }),
  },
  github: {
    title: 'Attach GitHub',
    fields: [
      { name: 'token', label: 'Personal access token', type: 'password', placeholder: '••••••••••••' },
      { name: 'owner', label: 'Owner', type: 'text', placeholder: 'thiluxan-s' },
      { name: 'repo', label: 'Repository', type: 'text', placeholder: 'beacon' },
    ],
    submit: (serviceId, v) =>
      attachGithubAction(serviceId, { token: v.token ?? '', owner: v.owner ?? '', repo: v.repo ?? '' }),
  },
};

const LABELS: Record<Kind, string> = { vercel: 'Vercel', github: 'GitHub' };

export function IntegrationAttachDialog({ serviceId }: { serviceId: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [kind, setKind] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function close() {
    if (pending) return;
    setKind(null);
    setError(null);
  }

  // Re-register on `pending` so the in-flight guard is never stale.
  useEffect(() => {
    if (!kind) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || pending) return;
      setKind(null);
      setError(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kind, pending]);

  function onSubmit(formData: FormData) {
    if (!kind) return;
    setError(null);
    const def = KINDS[kind];
    const values: Record<string, string> = {};
    for (const f of def.fields) values[f.name] = String(formData.get(f.name) ?? '');
    start(async () => {
      const res = await def.submit(serviceId, values);
      if (res.ok) {
        setKind(null);
      } else {
        setError(res.error);
      }
    });
  }

  const active = kind ? KINDS[kind] : null;

  return (
    <>
      <div className="relative">
        <Button size="sm" variant="ghost" onClick={() => setMenuOpen((o) => !o)}>
          Attach ▾
        </Button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 z-50 mt-1 w-32 overflow-hidden rounded-lg border border-zinc-200/80 bg-white py-1 shadow-lg shadow-zinc-950/10">
              {(Object.keys(KINDS) as Kind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  className="block w-full px-3 py-1.5 text-left text-[12px] text-zinc-700 hover:bg-zinc-50"
                  onClick={() => {
                    setMenuOpen(false);
                    setError(null);
                    setKind(k);
                  }}
                >
                  {LABELS[k]}
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
          aria-label={active.title}
        >
          <div className="absolute inset-0 bg-zinc-950/40 backdrop-blur-[2px]" onClick={close} aria-hidden="true" />
          <form
            action={onSubmit}
            className="relative z-10 w-full max-w-sm rounded-xl border border-zinc-200/80 bg-white shadow-2xl shadow-zinc-950/12"
          >
            <div className="border-b border-zinc-100 px-5 py-4">
              <h2 className="text-[13px] font-semibold text-zinc-900">{active.title}</h2>
              <p className="mt-0.5 text-[12px] leading-relaxed text-zinc-400">
                Beacon will validate before saving.
              </p>
            </div>

            <div className="space-y-4 px-5 py-4">
              {active.fields.map((f, i) => (
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
                    autoFocus={i === 0}
                    placeholder={f.placeholder}
                    className="h-8 font-mono text-[12px]"
                  />
                </div>
              ))}

              {error && (
                <p className="rounded-md bg-red-50 px-3 py-2 text-[12px] text-status-down">{error}</p>
              )}
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
