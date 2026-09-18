'use client';

import { type AccrualPool, type MemberRow, memberRate, unitsPerPeriod } from '@arcdrip/sdk';
import type { Address } from 'viem';
import { AddressLink } from '@/components/app-states';
import { useI18n } from '@/components/i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/primitives';
import { formatInt, formatPercent, formatUsdc, formatUsdcShort, shortAddress } from '@/lib/format';

/**
 * The payroll table. Every claimable in `rows` came from `toMemberRows(pool, members, now)`, i.e. from the same
 * `math.ts` the contract mirrors, so the number ticking here is the number the chain would pay this second.
 *
 * Presentational on purpose: `now` and `rows` are passed in, which is what lets the ticking be tested against
 * `math.ts` directly.
 */
export function MemberTable({
  pool,
  rows,
  account,
  onWithdraw,
  onWithdrawFor,
  busy,
}: {
  pool: AccrualPool;
  rows: readonly MemberRow[];
  account?: Address | undefined;
  onWithdraw?: () => void;
  onWithdrawFor?: (member: Address) => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  if (rows.length === 0) return <p className="text-muted text-sm">{t('table.empty')}</p>;
  const you = account?.toLowerCase();
  return (
    <div className="overflow-x-auto rounded-xl border border-hairline-strong">
      <table className="w-full min-w-[42rem] border-collapse text-sm">
        <thead>
          <tr className="bg-surface-2 text-left">
            <th className="px-4 py-2.5 font-medium">{t('table.member')}</th>
            <th className="px-4 py-2.5 text-right font-medium">{t('table.shares')}</th>
            <th className="px-4 py-2.5 text-right font-medium">{t('table.share')}</th>
            <th className="px-4 py-2.5 text-right font-medium">{t('table.rate')}</th>
            <th className="px-4 py-2.5 text-right font-medium">{t('table.claimable')}</th>
            <th className="px-4 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const mine = you !== undefined && row.address.toLowerCase() === you;
            const perMonth = unitsPerPeriod(memberRate(pool, row), 'month');
            return (
              <tr key={row.address} data-member={row.address} className="border-hairline border-t">
                <td className="px-4 py-2.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <AddressLink address={row.address} />
                    {mine ? <Badge tone="accent">{t('table.you')}</Badge> : null}
                    {row.formerMember ? <Badge tone="muted">{t('table.former')}</Badge> : null}
                  </span>
                  {row.payout !== '0x0000000000000000000000000000000000000000' &&
                  row.payout.toLowerCase() !== row.address.toLowerCase() ? (
                    <span className="text-faint text-xs">
                      {t('table.payoutTo', { address: shortAddress(row.payout) })}
                    </span>
                  ) : null}
                </td>
                <td className="tnum px-4 py-2.5 text-right">{formatInt(row.shares)}</td>
                <td className="tnum px-4 py-2.5 text-right text-muted">{formatPercent(row.shareFraction)}</td>
                <td className="tnum px-4 py-2.5 text-right text-muted">
                  {t('table.perMonth', { amount: formatUsdcShort(perMonth) })}
                </td>
                <td className="tnum px-4 py-2.5 text-right font-medium" data-claimable={row.address}>
                  {formatUsdc(row.claimable)}
                </td>
                <td className="px-4 py-2.5 text-right">
                  {mine && onWithdraw ? (
                    <Button
                      size="sm"
                      variant="accent"
                      disabled={busy || row.claimable === 0n}
                      onClick={onWithdraw}
                    >
                      {t('withdraw.own')}
                    </Button>
                  ) : onWithdrawFor ? (
                    <Button
                      size="sm"
                      variant="outline"
                      title={t('withdraw.forHint')}
                      disabled={busy || row.claimable === 0n}
                      onClick={() => onWithdrawFor(row.address)}
                    >
                      {t('withdraw.for')}
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
