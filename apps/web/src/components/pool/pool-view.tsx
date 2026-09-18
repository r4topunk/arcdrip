'use client';

import {
  type AccrualPool,
  fundedUntil,
  type MemberRow,
  type PoolState,
  poolStatus,
  runwaySeconds,
  toAccrualPool,
  toMemberRows,
  unitsPerPeriod,
  unstreamed,
  withdraw,
  withdrawFor,
} from '@arcdrip/sdk';
import { useSearchParams } from 'next/navigation';
import { type ReactNode, useMemo } from 'react';
import type { Address } from 'viem';
import { useAccount } from 'wagmi';
import { AddressLink, ErrorNote, PageHeader, RequireDrip, RpcError } from '@/components/app-states';
import { useDocumentTitle, useI18n } from '@/components/i18n';
import { usePool, usePoolList, usePoolMembers, useUsdcBalance } from '@/components/queries';
import { StatusChip } from '@/components/status-chip';
import { TxList, useTx } from '@/components/tx';
import { Card, CardContent, CardHeader, CardTitle, Notice, Skeleton, Stat } from '@/components/ui/primitives';
import { formatDateTime, formatInt, formatUsdc, formatUsdcShort, runwayView } from '@/lib/format';
import { useMounted, useNow } from '@/lib/hooks';
import { isOwner, isPendingOwner, ownRow } from '@/lib/pool';
import { DepositPanel } from './deposit-panel';
import { MemberPanel } from './member-panel';
import { MemberTable } from './member-table';
import { AcceptOwnership, OwnerPanel } from './owner-panel';
import { PayEveryone } from './pay-everyone';

/** Parses `?id=7`. Ids start at 1, so anything else is "no pool asked for". */
export function parsePoolId(raw: string | null): bigint | null {
  if (!raw || !/^\d+$/.test(raw.trim())) return null;
  const id = BigInt(raw.trim());
  return id > 0n ? id : null;
}

export function PoolView() {
  const { t } = useI18n();
  const params = useSearchParams();
  const poolId = parsePoolId(params?.get('id') ?? null);
  const mounted = useMounted();
  const now = useNow();
  const { address } = useAccount();

  const pool = usePool(poolId);
  const members = usePoolMembers(poolId);
  const balance = useUsdcBalance(address);
  const list = usePoolList(50);
  const nameFromLogs = list.data?.find((p) => p.poolId === poolId)?.name;

  const title = nameFromLogs || t('pool.untitled');
  useDocumentTitle(poolId === null ? t('nav.pools') : `${title} #${poolId}`);

  if (poolId === null) {
    return (
      <Shell eyebrow={t('nav.pools')} title={t('nav.pools')}>
        <Notice tone="warn">{t('pool.idMissing')}</Notice>
      </Shell>
    );
  }
  if (!mounted || now === null || pool.isPending) {
    return (
      <Shell eyebrow={t('pool.eyebrow', { id: poolId.toString() })} title={title}>
        <Skeleton className="h-64 w-full" />
      </Shell>
    );
  }
  if (pool.isError) {
    return (
      <Shell eyebrow={t('pool.eyebrow', { id: poolId.toString() })} title={title}>
        <RpcError onRetry={() => void pool.refetch()} />
      </Shell>
    );
  }
  if (!pool.data) {
    return (
      <Shell eyebrow={t('pool.eyebrow', { id: poolId.toString() })} title={title}>
        <Notice tone="danger">{t('pool.notFound', { id: poolId.toString() })}</Notice>
      </Shell>
    );
  }

  return (
    <PoolDetail
      poolId={poolId}
      pool={pool.data}
      name={title}
      members={members.data ?? []}
      membersPending={members.isPending}
      now={now}
      account={address}
      usdcBalance={balance.data}
    />
  );
}

function Shell({
  eyebrow,
  title,
  actions,
  children,
}: {
  eyebrow: string;
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6">
      <PageHeader eyebrow={eyebrow} title={title} actions={actions} />
      <RequireDrip>{children}</RequireDrip>
    </div>
  );
}

function PoolDetail({
  poolId,
  pool,
  name,
  members,
  membersPending,
  now,
  account,
  usdcBalance,
}: {
  poolId: bigint;
  pool: PoolState;
  name: string;
  members: Parameters<typeof toMemberRows>[1];
  membersPending: boolean;
  now: bigint;
  account: Address | undefined;
  usdcBalance: bigint | undefined;
}) {
  const { t, locale } = useI18n();
  const { run, busy, error } = useTx();

  // Everything below is derived locally from the last chain read plus `now`, with the SDK's mirror of the
  // contract's own accrual. That is what lets the page tick at 1 Hz without touching the RPC (PRD 6).
  const accrual: AccrualPool = useMemo(() => toAccrualPool(pool), [pool]);
  const rows: MemberRow[] = useMemo(() => toMemberRows(accrual, members, now), [accrual, members, now]);
  const status = poolStatus(accrual, now);
  const runway = runwayView(runwaySeconds(accrual, now));
  const dryAt = fundedUntil(accrual, now);
  const free = unstreamed(accrual, now);
  const owner = isOwner(pool, account);
  const pending = isPendingOwner(pool, account);
  const mine = ownRow(rows, account);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6">
      <PageHeader
        eyebrow={t('pool.eyebrow', { id: poolId.toString() })}
        title={name}
        actions={<StatusChip status={status} />}
      >
        <span className="flex flex-wrap items-center gap-2 text-sm">
          {t('pool.owner')}: <AddressLink address={pool.owner} />
        </span>
      </PageHeader>

      <div className="grid gap-6 rounded-xl border border-hairline-strong p-5 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={t('pool.rate')}
          value={t('pool.ratePerMonth', {
            amount: formatUsdcShort(unitsPerPeriod(pool.ratePerSecond, 'month')),
          })}
          sub={
            pool.startTime > now
              ? t('pool.startsAt', { time: formatDateTime(pool.startTime, locale) })
              : undefined
          }
        />
        <Stat label={t('pool.balance')} value={formatUsdc(pool.balance)} />
        <Stat
          label={t('pool.runway')}
          value={
            runway.kind === 'duration'
              ? runway.text
              : runway.kind === 'frozen'
                ? t('pool.runway.frozen')
                : t('pool.runway.unbounded')
          }
          tone={
            runway.kind === 'frozen'
              ? 'danger'
              : runway.kind === 'duration' && runway.danger
                ? 'danger'
                : undefined
          }
          sub={
            runway.kind === 'duration'
              ? t('pool.driesAt', { time: formatDateTime(dryAt, locale) })
              : undefined
          }
        />
        <Stat
          label={t('pool.totalShares')}
          value={formatInt(pool.totalShares)}
          sub={`${t('pool.unstreamed')}: ${formatUsdc(free)}`}
        />
      </div>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold text-xl">{t('pool.members')}</h2>
          <p className="max-w-xl text-muted text-xs">{t('pool.membersHint')}</p>
        </div>
        {error ? <ErrorNote message={error} /> : null}
        {membersPending ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <MemberTable
            pool={accrual}
            rows={rows}
            account={account}
            busy={busy !== null}
            onWithdraw={() => void run('tx.label.withdraw', (sdk) => withdraw(sdk, poolId))}
            onWithdrawFor={(member) =>
              void run('tx.label.withdrawFor', (sdk) => withdrawFor(sdk, poolId, member))
            }
          />
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        {pool.cancelled ? (
          <Card>
            <CardHeader>
              <CardTitle>{t('status.cancelled')}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted text-sm">{t('status.hint.cancelled')}</p>
            </CardContent>
          </Card>
        ) : (
          <DepositPanel poolId={poolId} pool={accrual} usdcBalance={usdcBalance} />
        )}
        <PayEveryone poolId={poolId} rows={rows} />
        {account ? <MemberPanel poolId={poolId} row={mine} account={account} /> : null}
        {pending ? <AcceptOwnership poolId={poolId} /> : null}
        {owner ? <OwnerPanel poolId={poolId} pool={pool} rows={rows} unstreamedUnits={free} /> : null}
      </div>

      <TxList />
    </div>
  );
}
