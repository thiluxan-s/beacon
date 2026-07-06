import Link from 'next/link';

import { currentUser } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';

import { fetchIncident, type IncidentEventDto } from '@/lib/incidents-api';
import { relativeTime } from '@/lib/relative-time';
import { IncidentLiveHeader } from '@/components/incidents/incident-timeline-live';

// Event-type → dot color + label. Mirrors the incident-list dot semantics but
// adds `observed`/`note` for the finer-grained timeline. A resolved incident's
// final event is deliberately green here — the list page keeps a resolved
// row's dot red as a "this happened" historical marker, but the timeline is
// read chronologically, so the dot must say "this step went well," not
// "still failing."
const EVENT_STYLE: Record<string, { dot: string; label: string }> = {
  opened: { dot: 'bg-status-down', label: 'text-zinc-900' },
  observed: { dot: 'bg-status-degraded', label: 'text-zinc-900' },
  resolved: { dot: 'bg-status-up', label: 'text-zinc-900' },
  note: { dot: 'bg-zinc-300', label: 'text-zinc-500' },
};

export default async function IncidentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const user = await currentUser();
  if (!user) notFound();

  const detail = await fetchIncident(user.id, id);
  if (!detail) notFound();
  const { incident, events } = detail;

  return (
    <main className="flex flex-1 flex-col">
      {/* ─── Back link ─── */}
      <div className="px-5 pt-4">
        <Link
          href="/incidents"
          className="font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-400 transition-colors hover:text-zinc-600"
        >
          ← incidents
        </Link>
      </div>

      {/* ─── Header block ─── */}
      <div className="flex items-start justify-between gap-6 border-b border-zinc-200/60 px-5 py-3.5">
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-zinc-900">{incident.serviceName}</h1>
          <p className="mt-0.5 font-mono text-[11px] text-zinc-400" suppressHydrationWarning>
            Started {relativeTime(incident.startedAt)}
          </p>
        </div>
        <div className="shrink-0 pt-0.5">
          <IncidentLiveHeader
            incidentId={incident.id}
            serviceId={incident.serviceId}
            startedAt={incident.startedAt}
            resolvedAt={incident.resolvedAt}
            durationSeconds={incident.durationSeconds}
          />
        </div>
      </div>

      {/* ─── Timeline ─── */}
      <section className="flex flex-1 flex-col px-5 py-5">
        <h2 className="mb-4 font-mono text-[9px] uppercase tracking-[0.12em] text-zinc-400">
          Timeline
        </h2>
        <TimelineList events={events} />
      </section>
    </main>
  );
}

function TimelineList({ events }: { events: IncidentEventDto[] }) {
  if (events.length === 0) {
    return <p className="text-[12px] text-zinc-400">No events recorded for this incident.</p>;
  }

  return (
    <ol>
      {events.map((ev, i) => {
        const style = EVENT_STYLE[ev.eventType] ?? { dot: 'bg-zinc-300', label: 'text-zinc-500' };
        const isLast = i === events.length - 1;
        return (
          <li key={ev.id} className="flex gap-3 pb-4 last:pb-0">
            {/* Dot + connecting rule — both live in the same fixed-width flex
                column so the 1px rule is guaranteed centered under the dot via
                flexbox alignment, rather than hand-tuned absolute offsets. */}
            <div className="relative flex w-2 shrink-0 flex-col items-center">
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
              {!isLast && (
                <span className="absolute top-3 bottom-[-16px] w-px bg-zinc-200" aria-hidden="true" />
              )}
            </div>

            <div className="flex min-w-0 flex-1 items-baseline justify-between gap-4">
              <p className="text-[12.5px] leading-relaxed text-zinc-600">
                <span className={`font-medium capitalize ${style.label}`}>{ev.eventType}</span>
                <span className="text-zinc-300"> — </span>
                {ev.message}
              </p>
              <span
                className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-400"
                suppressHydrationWarning
              >
                {relativeTime(ev.occurredAt)}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
