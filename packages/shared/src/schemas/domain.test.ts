import { describe, expect, it } from 'vitest';
import { DomainCreateSchema } from './domain';

describe('DomainCreateSchema', () => {
  it('accepts valid domains and defaults the interval', () => {
    const r = DomainCreateSchema.safeParse({ domain: 'thiluxan.com' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.checkIntervalSeconds).toBe(3600);
    expect(DomainCreateSchema.safeParse({ domain: 'sub.thiluxan.com' }).success).toBe(true);
    expect(DomainCreateSchema.safeParse({ domain: 'a.b.co.uk' }).success).toBe(true);
  });
  it('rejects urls, spaces, empty, and single labels', () => {
    for (const domain of ['https://x.com', 'has space.com', '', 'localhost', 'x.com/path']) {
      expect(DomainCreateSchema.safeParse({ domain }).success).toBe(false);
    }
  });
});
