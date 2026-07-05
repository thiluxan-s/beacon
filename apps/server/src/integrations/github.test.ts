import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubIntegration } from './github';

const creds = { token: 'ghp_abc' };
const config = { owner: 'thiluxan-s', repo: 'beacon' };

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))));
}

describe('githubIntegration', () => {
  it('validates credentials and config schemas', () => {
    expect(githubIntegration.credentialsSchema.safeParse(creds).success).toBe(true);
    expect(githubIntegration.credentialsSchema.safeParse({}).success).toBe(false);
    expect(githubIntegration.configSchema.safeParse(config).success).toBe(true);
    expect(githubIntegration.configSchema.safeParse({ owner: 'x' }).success).toBe(false);
  });

  it('testCredentials ok on 200', async () => {
    stubFetch(() => new Response('{"full_name":"thiluxan-s/beacon"}', { status: 200 }));
    expect(await githubIntegration.testCredentials(creds, config)).toEqual({ ok: true });
  });

  it('testCredentials error on 404 (repo not found / no access)', async () => {
    stubFetch(() => new Response('{"message":"Not Found"}', { status: 404 }));
    const r = await githubIntegration.testCredentials(creds, config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found|access/i);
  });

  it('testCredentials error on 401 (bad token)', async () => {
    stubFetch(() => new Response('{"message":"Bad credentials"}', { status: 401 }));
    const r = await githubIntegration.testCredentials(creds, config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/token/i);
  });

  it('fetchData maps runs + commits and derives ciStatus=passing', async () => {
    stubFetch((url) => {
      if (url.includes('/actions/runs')) {
        return new Response(
          JSON.stringify({
            workflow_runs: [
              { name: 'CI', status: 'completed', conclusion: 'success', event: 'push', created_at: '2026-07-04T10:00:00Z', head_sha: 'abc1234', html_url: 'https://github.com/x/y/actions/runs/1' },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify([
          { sha: 'abc1234def', html_url: 'https://github.com/x/y/commit/abc1234def', commit: { message: 'ship it\n\nbody', author: { name: 'Thiluxan', date: '2026-07-04T09:00:00Z' } } },
        ]),
        { status: 200 },
      );
    });
    const snap = await githubIntegration.fetchData(creds, config);
    expect(snap.ciStatus).toBe('passing');
    expect((snap.workflowRuns as unknown[]).length).toBe(1);
    const commits = snap.commits as Array<{ message: string; sha: string }>;
    expect(commits[0]!.message).toBe('ship it'); // first line only
    expect(commits[0]!.sha).toBe('abc1234def');
  });

  it('fetchData with no workflow runs → ciStatus null, no throw', async () => {
    stubFetch((url) => {
      if (url.includes('/actions/runs')) return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
      return new Response('[]', { status: 200 });
    });
    const snap = await githubIntegration.fetchData(creds, config);
    expect(snap.ciStatus).toBeNull();
    expect(snap.workflowRuns).toEqual([]);
    expect(snap.commits).toEqual([]);
  });

  it('fetchData throws when a call is not ok (worker records last_error)', async () => {
    stubFetch(() => new Response('nope', { status: 500 }));
    await expect(githubIntegration.fetchData(creds, config)).rejects.toThrow(/GitHub/);
  });
});
