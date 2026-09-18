'use client';

import type { PoolStatus } from '@arcdrip/sdk';
import { STATUS_TONE } from '@/lib/pool';
import { useI18n } from './i18n';
import { Badge } from './ui/primitives';

const DOT: Record<PoolStatus, string> = {
  streaming: 'bg-ok animate-pulse',
  scheduled: 'bg-info',
  paused: 'bg-faint',
  frozen: 'bg-warn',
  cancelled: 'bg-danger',
};

/** One chip per derived status (PRD 6), with the meaning as its accessible description. */
export function StatusChip({ status }: { status: PoolStatus }) {
  const { t } = useI18n();
  return (
    <Badge tone={STATUS_TONE[status]} data-status={status} title={t(`status.hint.${status}`)}>
      <span aria-hidden className={`size-1.5 rounded-full ${DOT[status]}`} />
      {t(`status.${status}`)}
      <span className="sr-only">: {t(`status.hint.${status}`)}</span>
    </Badge>
  );
}
