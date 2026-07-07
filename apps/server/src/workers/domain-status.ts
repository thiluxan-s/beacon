export type DomainStatus = 'pending' | 'healthy' | 'warning' | 'expiring_soon' | 'expired' | 'unhealthy';

export const WARN_DAYS = 30;
export const SOON_DAYS = 7;
const MS_PER_DAY = 86_400_000;

export function classifyDomain(input: {
  dnsResolved: boolean;
  sslExpiresAt: Date | null;
  domainExpiresAt: Date | null;
  now: Date;
}): Exclude<DomainStatus, 'pending'> {
  const { dnsResolved, sslExpiresAt, domainExpiresAt, now } = input;
  if (!dnsResolved) return 'unhealthy';
  if (sslExpiresAt === null) return 'unhealthy';

  const t = now.getTime();
  if (sslExpiresAt.getTime() < t || (domainExpiresAt !== null && domainExpiresAt.getTime() < t)) {
    return 'expired';
  }

  const sslDays = Math.floor((sslExpiresAt.getTime() - t) / MS_PER_DAY);
  const regDays = domainExpiresAt !== null ? Math.floor((domainExpiresAt.getTime() - t) / MS_PER_DAY) : Infinity;
  const worst = Math.min(sslDays, regDays);

  if (worst <= SOON_DAYS) return 'expiring_soon';
  if (worst <= WARN_DAYS) return 'warning';
  return 'healthy';
}
