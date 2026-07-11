import type { PublicDomainDto } from '@/lib/public-api';
import { DOMAIN_STATUS_STYLE, formatDaysUntil } from '@/lib/domain-status-style';

export function PublicDomainsList({ initial }: { initial: PublicDomainDto[] }) {
  if (initial.length === 0) {
    return <p className="px-5 pb-4 text-[12px] text-zinc-400">No public domains.</p>;
  }

  return (
    <ul className="divide-y divide-zinc-200/40">
      {initial.map((d) => {
        const style = DOMAIN_STATUS_STYLE[d.currentStatus] ?? { text: 'text-zinc-500', dot: 'bg-zinc-300', pulse: false };
        return (
          <li key={d.id} className="flex items-center gap-4 px-5 py-3">
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-zinc-900">{d.domain}</span>
            <div className="flex w-28 items-center gap-1.5">
              <span
                className={[
                  'inline-block h-1.5 w-1.5 shrink-0 rounded-full',
                  style.dot,
                  style.pulse ? 'animate-pulse' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              />
              <span className={`text-[12px] font-medium capitalize ${style.text}`}>
                {d.currentStatus.replace('_', ' ')}
              </span>
            </div>
            <span className="hidden w-20 text-right font-mono text-[11px] tabular-nums text-zinc-400 sm:block">
              {formatDaysUntil(d.sslExpiresAt)}
            </span>
            <span className="hidden w-20 text-right font-mono text-[11px] tabular-nums text-zinc-400 sm:block">
              {formatDaysUntil(d.domainExpiresAt)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
