import { currentUser } from '@clerk/nextjs/server';
import { notFound } from 'next/navigation';

import { fetchIncidents, type IncidentDto } from '@/lib/incidents-api';
import { IncidentsLiveList } from '@/components/incidents/incidents-live-list';

export default async function IncidentsPage() {
  const user = await currentUser();
  if (!user) notFound();

  let incidents: IncidentDto[] = [];
  let loadError = false;

  try {
    incidents = await fetchIncidents(user.id);
  } catch {
    loadError = true;
  }

  return (
    <main className="flex flex-1 flex-col">
      {/* ─── Page header ─── */}
      <div className="flex items-center justify-between border-b border-zinc-200/60 px-5 py-3.5">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-sm font-semibold text-zinc-900">Incidents</h1>
          {!loadError && (
            <span className="font-mono text-[10px] tabular-nums text-zinc-400">
              {incidents.length} recorded
            </span>
          )}
        </div>
      </div>

      {/* ─── Data unavailable banner ─── */}
      {loadError && (
        <div className="flex items-center gap-2 border-b border-zinc-200/40 bg-zinc-50/70 px-5 py-2.5">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400" aria-hidden="true" />
          <p className="font-mono text-[11px] text-zinc-500">
            Couldn&apos;t load incidents — retrying
          </p>
        </div>
      )}

      {/* ─── Live status-derived UI (summary strip + column header + rows) ─── */}
      {!loadError && <IncidentsLiveList initial={incidents} />}
    </main>
  );
}
