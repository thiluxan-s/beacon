import { z } from 'zod';
import type { IntegrationDataSnapshot, IntegrationDefinition } from './types';

const VercelCredentialsSchema = z.object({ apiToken: z.string().min(1) });
const VercelConfigSchema = z.object({ projectId: z.string().min(1), teamId: z.string().optional() });

export type VercelCredentials = z.infer<typeof VercelCredentialsSchema>;
export type VercelConfig = z.infer<typeof VercelConfigSchema>;

const API = 'https://api.vercel.com';

function teamQuery(teamId?: string): string {
  return teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';
}

export const vercelIntegration: IntegrationDefinition<VercelCredentials, VercelConfig> = {
  id: 'vercel',
  name: 'Vercel',
  credentialsSchema: VercelCredentialsSchema,
  configSchema: VercelConfigSchema,
  fields: [
    { name: 'apiToken', label: 'API token', type: 'password', section: 'credentials', placeholder: '••••••••••••' },
    { name: 'projectId', label: 'Project ID', type: 'text', section: 'config', placeholder: 'prj_abc123' },
    { name: 'teamId', label: 'Team ID', type: 'text', section: 'config', placeholder: 'team_abc123', optional: true },
  ],

  async testCredentials(credentials) {
    try {
      const res = await fetch(`${API}/v2/projects?limit=1`, {
        headers: { Authorization: `Bearer ${credentials.apiToken}` },
      });
      if (res.ok) return { ok: true };
      return { ok: false, error: `Vercel returned ${res.status}` };
    } catch {
      return { ok: false, error: 'Could not reach Vercel' };
    }
  },

  async fetchData(credentials, config) {
    const url = `${API}/v6/deployments?projectId=${encodeURIComponent(config.projectId)}&limit=5${teamQuery(config.teamId)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${credentials.apiToken}` } });
    if (!res.ok) throw new Error(`Vercel deployments returned ${res.status}`);
    const body = (await res.json()) as { deployments?: unknown[] };
    const raw = Array.isArray(body.deployments) ? body.deployments : [];
    const deployments = raw.map((d) => {
      const dep = d as Record<string, unknown>;
      const meta = (dep.meta as Record<string, unknown> | undefined) ?? {};
      return {
        state: String(dep.state ?? 'UNKNOWN'),
        target: (dep.target as string | null) ?? null,
        url: (dep.url as string | null) ?? null,
        createdAt: typeof dep.createdAt === 'number' ? new Date(dep.createdAt).toISOString() : null,
        commitSha: (meta.githubCommitSha as string | undefined) ?? null,
        commitMessage: (meta.githubCommitMessage as string | undefined) ?? null,
      };
    });
    const production = deployments.find((d) => d.target === 'production');
    const snapshot: IntegrationDataSnapshot = {
      deployments,
      productionStatus: production?.state ?? null,
      fetchedAt: new Date().toISOString(),
    };
    return snapshot;
  },
};
