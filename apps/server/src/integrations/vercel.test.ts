import { afterEach, describe, expect, it, vi } from 'vitest';
import { vercelIntegration } from './vercel';

const creds = { apiToken: 'tok_abc' };
const config = { projectId: 'prj_1' };

afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))));
}

describe('vercelIntegration', () => {
  it('validates credentials and config schemas', () => {
    expect(vercelIntegration.credentialsSchema.safeParse(creds).success).toBe(true);
    expect(vercelIntegration.credentialsSchema.safeParse({}).success).toBe(false);
    expect(vercelIntegration.configSchema.safeParse(config).success).toBe(true);
    expect(vercelIntegration.configSchema.safeParse({}).success).toBe(false);
  });

  it('testCredentials ok on 200', async () => {
    stubFetch(() => new Response('{"projects":[]}', { status: 200 }));
    expect(await vercelIntegration.testCredentials(creds, config)).toEqual({ ok: true });
  });

  it('testCredentials error on 401', async () => {
    stubFetch(() => new Response('unauthorized', { status: 401 }));
    const r = await vercelIntegration.testCredentials(creds, config);
    expect(r.ok).toBe(false);
  });

  it('fetchData maps deployments into a snapshot', async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          deployments: [
            { uid: 'd1', url: 'app.vercel.app', state: 'READY', target: 'production', createdAt: 1710000000000, meta: { githubCommitSha: 'abc123', githubCommitMessage: 'ship it' } },
          ],
        }),
        { status: 200 },
      ),
    );
    const snap = await vercelIntegration.fetchData(creds, config);
    expect(Array.isArray(snap.deployments)).toBe(true);
    expect((snap.deployments as unknown[]).length).toBe(1);
    expect(snap.productionStatus).toBe('READY');
  });
});
