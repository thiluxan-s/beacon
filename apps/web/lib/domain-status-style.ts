// Domain status → status tokens (globals.css @theme). warning/expiring lean amber,
// expired/unhealthy red, healthy green, pending neutral. The label carries the specifics.
//
// `pulse` escalates urgency *within* a color tier, reusing the same `animate-pulse`
// motion language STATUS_STYLE uses for services' live "up" dot — here it means
// "time-critical, look now" rather than "currently live." `warning` and
// `expiring_soon` share the same amber hue, so without `pulse` they'd be visually
// identical even though expiring is the more urgent of the two; `expired` and
// `unhealthy` are already red (more urgent than amber by color alone) but pulse
// too since both mean the domain is actively broken right now.
export const DOMAIN_STATUS_STYLE: Record<string, { text: string; dot: string; pulse: boolean }> = {
  pending:       { text: 'text-zinc-400',        dot: 'bg-zinc-300',        pulse: false },
  healthy:       { text: 'text-status-up',       dot: 'bg-status-up',       pulse: false },
  warning:       { text: 'text-status-degraded', dot: 'bg-status-degraded', pulse: false },
  expiring_soon: { text: 'text-status-degraded', dot: 'bg-status-degraded', pulse: true  },
  expired:       { text: 'text-status-down',     dot: 'bg-status-down',     pulse: true  },
  unhealthy:     { text: 'text-status-down',     dot: 'bg-status-down',     pulse: true  },
};

export function formatDaysUntil(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const days = Math.floor((d.getTime() - now.getTime()) / 86_400_000);
  return days < 0 ? 'expired' : `${days}d`;
}
