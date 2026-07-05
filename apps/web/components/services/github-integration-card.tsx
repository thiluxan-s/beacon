import { relativeTime } from '@/lib/relative-time';
import type { IntegrationDto } from '@/lib/services-api';

// GitHub CI status → project --color-status-* tokens (globals.css @theme).
const CI_STYLE: Record<string, { text: string; dot: string; label: string }> = {
  passing: { text: 'text-status-up', dot: 'bg-status-up', label: 'passing' },
  failing: { text: 'text-status-down', dot: 'bg-status-down', label: 'failing' },
  running: { text: 'text-status-degraded', dot: 'bg-status-degraded', label: 'running' },
};

type WorkflowRun = {
  name: string;
  status: string;
  conclusion: string | null;
  event: string | null;
  createdAt: string | null;
  headSha: string | null;
  url: string | null;
};
type Commit = {
  sha: string;
  message: string;
  author: string | null;
  committedAt: string | null;
  url: string | null;
};

function parseSnapshot(snapshot: Record<string, unknown> | null): {
  ciStatus: string | null;
  workflowRuns: WorkflowRun[];
  commits: Commit[];
} | null {
  if (!snapshot) return null;
  const rawRuns = snapshot.workflowRuns;
  const rawCommits = snapshot.commits;
  if (!Array.isArray(rawRuns) || !Array.isArray(rawCommits)) return null;

  const workflowRuns: WorkflowRun[] = rawRuns.map((r) => {
    const run = (r ?? {}) as Record<string, unknown>;
    return {
      name: typeof run.name === 'string' ? run.name : 'workflow',
      status: typeof run.status === 'string' ? run.status : 'unknown',
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
      event: typeof run.event === 'string' ? run.event : null,
      createdAt: typeof run.createdAt === 'string' ? run.createdAt : null,
      headSha: typeof run.headSha === 'string' ? run.headSha : null,
      url: typeof run.url === 'string' ? run.url : null,
    };
  });

  const commits: Commit[] = rawCommits.map((c) => {
    const commit = (c ?? {}) as Record<string, unknown>;
    return {
      sha: typeof commit.sha === 'string' ? commit.sha : '',
      message: typeof commit.message === 'string' ? commit.message : '',
      author: typeof commit.author === 'string' ? commit.author : null,
      committedAt: typeof commit.committedAt === 'string' ? commit.committedAt : null,
      url: typeof commit.url === 'string' ? commit.url : null,
    };
  });

  const ciStatus = typeof snapshot.ciStatus === 'string' ? snapshot.ciStatus : null;
  return { ciStatus, workflowRuns, commits };
}

// ✓ for a successful conclusion, ✗ for a failing one, • otherwise (running/neutral).
function runGlyph(conclusion: string | null): string {
  if (conclusion === 'success') return '✓';
  if (conclusion && conclusion !== 'neutral' && conclusion !== 'skipped') return '✗';
  return '•';
}

export function GithubIntegrationCard({ integration }: { integration: IntegrationDto }) {
  const parsed = parseSnapshot(integration.snapshot);
  const ciStyle = parsed?.ciStatus ? (CI_STYLE[parsed.ciStatus] ?? null) : null;
  const latestRun = parsed?.workflowRuns[0] ?? null;

  return (
    <div className="rounded-lg border border-zinc-200/60">
      {/* Header */}
      <div className="flex items-center justify-between gap-2.5 border-b border-zinc-200/40 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-semibold text-zinc-900">GitHub</span>
          {ciStyle && (
            <span className="flex items-center gap-1.5">
              <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${ciStyle.dot}`} aria-hidden="true" />
              <span className={`font-mono text-[10px] font-medium ${ciStyle.text}`}>{ciStyle.label}</span>
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      {integration.lastError && !parsed ? (
        <p className="px-4 py-3 text-[12px] text-status-down">Couldn&apos;t reach GitHub — retrying</p>
      ) : !parsed || (parsed.workflowRuns.length === 0 && parsed.commits.length === 0) ? (
        <p className="px-4 py-3 text-[12px] text-zinc-400">No activity yet.</p>
      ) : (
        <div>
          {latestRun && (
            <div className="flex items-center gap-3 border-b border-zinc-200/40 px-4 py-2 text-[11px]">
              <span className="w-3 shrink-0 text-center font-mono text-zinc-400" aria-hidden="true">
                {runGlyph(latestRun.conclusion)}
              </span>
              <span className="min-w-0 flex-1 truncate text-zinc-600">{latestRun.name}</span>
              <span className="shrink-0 font-mono tabular-nums text-zinc-400">{relativeTime(latestRun.createdAt)}</span>
            </div>
          )}
          {parsed.commits.length === 0 ? (
            <p className="px-4 py-2 text-[11px] text-zinc-400">No commits.</p>
          ) : (
            <ul className="divide-y divide-zinc-200/40">
              {parsed.commits.map((commit, i) => (
                <li key={commit.sha || i} className="flex items-center gap-3 px-4 py-2 text-[11px]">
                  <span className="min-w-0 flex-1 truncate text-zinc-500">
                    {commit.message || '—'}
                    {commit.sha && <span className="ml-1.5 font-mono text-zinc-400">{commit.sha.slice(0, 7)}</span>}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-zinc-400">
                    {relativeTime(commit.committedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
