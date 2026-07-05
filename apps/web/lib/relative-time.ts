/**
 * Relative time — "Xs/Xm/Xh/Xd ago", or "—" for a null timestamp.
 * Computed from `Date.now()`; callers are Server Components, so there is no
 * hydration guard to worry about.
 */
export function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}
