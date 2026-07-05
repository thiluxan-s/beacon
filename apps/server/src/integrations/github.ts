import { z } from 'zod';
import type { IntegrationDataSnapshot, IntegrationDefinition } from './types';

const GithubCredentialsSchema = z.object({ token: z.string().min(1) });
const GithubConfigSchema = z.object({ owner: z.string().min(1), repo: z.string().min(1) });

export type GithubCredentials = z.infer<typeof GithubCredentialsSchema>;
export type GithubConfig = z.infer<typeof GithubConfigSchema>;

const API = 'https://api.github.com';

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure', 'action_required']);
const RUNNING = new Set(['in_progress', 'queued', 'requested', 'waiting', 'pending']);

function deriveCiStatus(run: { status: string; conclusion: string | null } | undefined): 'passing' | 'failing' | 'running' | null {
  if (!run) return null;
  if (run.conclusion === 'success') return 'passing';
  if (run.conclusion && FAILING.has(run.conclusion)) return 'failing';
  if (!run.conclusion && RUNNING.has(run.status)) return 'running';
  return null;
}

export const githubIntegration: IntegrationDefinition<GithubCredentials, GithubConfig> = {
  id: 'github',
  name: 'GitHub',
  credentialsSchema: GithubCredentialsSchema,
  configSchema: GithubConfigSchema,

  async testCredentials(credentials, config) {
    try {
      const res = await fetch(`${API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`, {
        headers: ghHeaders(credentials.token),
      });
      if (res.ok) return { ok: true };
      if (res.status === 404) return { ok: false, error: 'Repo not found or token lacks access' };
      if (res.status === 401) return { ok: false, error: 'Invalid GitHub token' };
      return { ok: false, error: `GitHub returned ${res.status}` };
    } catch {
      return { ok: false, error: 'Could not reach GitHub' };
    }
  },

  async fetchData(credentials, config) {
    const base = `${API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
    const headers = ghHeaders(credentials.token);

    const runsRes = await fetch(`${base}/actions/runs?per_page=5`, { headers });
    if (!runsRes.ok) throw new Error(`GitHub workflow runs returned ${runsRes.status}`);
    const runsBody = (await runsRes.json()) as { workflow_runs?: unknown[] };
    const rawRuns = Array.isArray(runsBody.workflow_runs) ? runsBody.workflow_runs : [];
    const workflowRuns = rawRuns.map((r) => {
      const run = r as Record<string, unknown>;
      return {
        name: typeof run.name === 'string' ? run.name : 'workflow',
        status: String(run.status ?? 'unknown'),
        conclusion: (run.conclusion as string | null) ?? null,
        event: (run.event as string | null) ?? null,
        createdAt: typeof run.created_at === 'string' ? run.created_at : null,
        headSha: (run.head_sha as string | null) ?? null,
        url: (run.html_url as string | null) ?? null,
      };
    });

    const commitsRes = await fetch(`${base}/commits?per_page=5`, { headers });
    if (!commitsRes.ok) throw new Error(`GitHub commits returned ${commitsRes.status}`);
    const rawCommits = (await commitsRes.json()) as unknown[];
    const commits = (Array.isArray(rawCommits) ? rawCommits : []).map((c) => {
      const commit = c as Record<string, unknown>;
      const inner = (commit.commit as Record<string, unknown> | undefined) ?? {};
      const author = (inner.author as Record<string, unknown> | undefined) ?? {};
      const message = typeof inner.message === 'string' ? inner.message.split('\n')[0]! : '';
      return {
        sha: typeof commit.sha === 'string' ? commit.sha : '',
        message,
        author: (author.name as string | undefined) ?? null,
        committedAt: (author.date as string | undefined) ?? null,
        url: (commit.html_url as string | null) ?? null,
      };
    });

    const snapshot: IntegrationDataSnapshot = {
      ciStatus: deriveCiStatus(workflowRuns[0]),
      workflowRuns,
      commits,
      fetchedAt: new Date().toISOString(),
    };
    return snapshot;
  },
};
