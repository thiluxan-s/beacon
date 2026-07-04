import { currentUser } from '@clerk/nextjs/server';
import { fetchServices, type ServiceDto } from '@/lib/services-api';
import { ServiceFormDialog } from '@/components/services/service-form-dialog';
import { ServicesLiveList } from '@/components/services/services-live-list';

export default async function ServicesPage() {
  const user = await currentUser();

  let services: ServiceDto[] = [];
  let loadError = false;

  if (user) {
    try {
      services = await fetchServices(user.id);
    } catch {
      loadError = true;
    }
  }

  return (
    <main className="flex flex-1 flex-col">
      {/* ─── Page header ─── */}
      <div className="flex items-center justify-between border-b border-zinc-200/60 px-5 py-3.5">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-sm font-semibold text-zinc-900">Services</h1>
          {!loadError && (
            <span className="font-mono text-[10px] tabular-nums text-zinc-400">
              {services.length} endpoint{services.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <ServiceFormDialog triggerLabel="Add service" />
      </div>

      {/* ─── Data unavailable banner ─── */}
      {loadError && (
        <div className="flex items-center gap-2 border-b border-zinc-200/40 bg-zinc-50/70 px-5 py-2.5">
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400" aria-hidden="true" />
          <p className="font-mono text-[11px] text-zinc-500">
            Couldn&apos;t load services — retrying
          </p>
        </div>
      )}

      {/* ─── Empty state ─── */}
      {!loadError && services.length === 0 && (
        <div className="flex flex-1 items-center justify-center">
          <div className="py-16 text-center">
            {/* Minimal terminal-motif decoration */}
            <p className="mb-4 font-mono text-[10px] tracking-[0.15em] text-zinc-300 select-none uppercase">
              no endpoints configured
            </p>
            <p className="text-[13px] font-medium text-zinc-700">No services yet</p>
            <p className="mt-1.5 max-w-[260px] text-[12px] leading-relaxed text-zinc-400">
              Add a service and the background worker will start checking it within
              seconds.
            </p>
          </div>
        </div>
      )}

      {/* ─── Live status-derived UI (summary strip + column header + rows) ─── */}
      {!loadError && services.length > 0 && <ServicesLiveList initial={services} />}
    </main>
  );
}
