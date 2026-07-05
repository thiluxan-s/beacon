// Service status → project --color-status-* tokens (globals.css @theme).
// `pulse` drives the live "up" indicator animation. Shared by the dashboard
// list and the live status pill so they can never drift apart.
export const STATUS_STYLE: Record<string, { text: string; dot: string; pulse: boolean }> = {
  up:       { text: 'text-status-up',       dot: 'bg-status-up',       pulse: true  },
  down:     { text: 'text-status-down',     dot: 'bg-status-down',     pulse: false },
  degraded: { text: 'text-status-degraded', dot: 'bg-status-degraded', pulse: false },
  paused:   { text: 'text-status-paused',   dot: 'bg-status-paused',   pulse: false },
  pending:  { text: 'text-zinc-400',        dot: 'bg-zinc-300',        pulse: false },
};
