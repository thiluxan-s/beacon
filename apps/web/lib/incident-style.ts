// Incident severity → status tokens (globals.css @theme). Ongoing incidents pulse.
export const SEVERITY_STYLE: Record<string, { text: string; dot: string }> = {
  down: { text: 'text-status-down', dot: 'bg-status-down' },
};

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
