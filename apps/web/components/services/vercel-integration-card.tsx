import type { IntegrationDto } from '@/lib/services-api';

// Vercel deployment `state` → project --color-status-* tokens (globals.css @theme).
// Anything unrecognized (QUEUED, CANCELED, INITIALIZING, ...) falls back to neutral zinc.
const STATE_STYLE: Record<string, { text: string; dot: string }> = {
  READY:    { text: 'text-status-up',       dot: 'bg-status-up' },
  ERROR:    { text: 'text-status-down',     dot: 'bg-status-down' },
  BUILDING: { text: 'text-status-degraded', dot: 'bg-status-degraded' },
};
const DEFAULT_STATE_STYLE = { text: 'text-zinc-500', dot: 'bg-zinc-300' };

type VercelDeployment = {
  state: string;
  target: string | null;
  url: string | null;
  createdAt: string | null;
  commitSha: string | null;
  commitMessage: string | null;
};

// Narrows `integration.snapshot` (Record<string, unknown> | null) into the shape
// the Vercel integration actually writes (apps/server/src/integrations/vercel.ts).
// Anything that doesn't match is treated as "no usable snapshot".
function parseSnapshot(snapshot: Record<string, unknown> | null): {
  deployments: VercelDeployment[];
  productionStatus: string | null;
} | null {
  if (!snapshot) return null;
  const rawDeployments = snapshot.deployments;
  if (!Array.isArray(rawDeployments)) return null;

  const deployments: VercelDeployment[] = rawDeployments.map((d) => {
    const dep = (d ?? {}) as Record<string, unknown>;
    return {
      state: typeof dep.state === 'string' ? dep.state : 'UNKNOWN',
      target: typeof dep.target === 'string' ? dep.target : null,
      url: typeof dep.url === 'string' ? dep.url : null,
      createdAt: typeof dep.createdAt === 'string' ? dep.createdAt : null,
      commitSha: typeof dep.commitSha === 'string' ? dep.commitSha : null,
      commitMessage: typeof dep.commitMessage === 'string' ? dep.commitMessage : null,
    };
  });

  const productionStatus = typeof snapshot.productionStatus === 'string' ? snapshot.productionStatus : null;

  return { deployments, productionStatus };
}

// Relative time — matches the detail page's Xs/Xm/Xh/Xd ago style. Computed
// once on the server (this is a Server Component), so no hydration guard needed.
function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export function VercelIntegrationCard({ integration }: { integration: IntegrationDto }) {
  const parsed = parseSnapshot(integration.snapshot);

  const prodStyle = parsed?.productionStatus
    ? (STATE_STYLE[parsed.productionStatus] ?? DEFAULT_STATE_STYLE)
    : null;

  return (
    <div className="rounded-lg border border-zinc-200/60">
      {/* Header */}
      <div className="flex items-center justify-between gap-2.5 border-b border-zinc-200/40 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-zinc-900">Vercel</span>
          {prodStyle && (
            <span className="flex items-center gap-1.5">
              <span
                className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${prodStyle.dot}`}
                aria-hidden="true"
              />
              <span className={`font-mono text-[10px] font-medium ${prodStyle.text}`}>
                {parsed?.productionStatus}
              </span>
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      {integration.lastError && !parsed ? (
        <p className="px-4 py-3 text-[12px] text-status-down">
          Couldn&apos;t reach Vercel — retrying
        </p>
      ) : !parsed || parsed.deployments.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-zinc-400">No deployments yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-200/40">
          {parsed.deployments.map((d, i) => {
            const style = STATE_STYLE[d.state] ?? DEFAULT_STATE_STYLE;
            return (
              <li
                key={d.url ?? i}
                className="flex items-center gap-3 px-4 py-2 text-[11px]"
              >
                <span
                  className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`}
                  aria-hidden="true"
                />
                <span className={`w-20 shrink-0 font-medium ${style.text}`}>
                  {d.target ?? '—'}
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-500">
                  {d.commitMessage ?? '—'}
                  {d.commitSha && (
                    <span className="ml-1.5 font-mono text-zinc-400">
                      {d.commitSha.slice(0, 7)}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono tabular-nums text-zinc-400">
                  {relativeTime(d.createdAt)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
