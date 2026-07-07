import { z } from 'zod';

// Dot-separated DNS labels + a TLD; case-insensitive. Rejects scheme/path/spaces
// and single-label hosts (localhost). Case is normalized server-side in createDomain.
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

export const DomainCreateSchema = z.object({
  domain: z.string().trim().regex(HOSTNAME_RE, 'must be a valid domain'),
  checkIntervalSeconds: z.number().int().min(300).max(86_400).default(3600),
});
export type DomainCreateInput = z.infer<typeof DomainCreateSchema>;
