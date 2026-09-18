'use client';

import {
  acceptPoolOwnership,
  cancel,
  fromRatePerSecond,
  type MemberRow,
  type PoolState,
  setRate,
  setShares,
  transferPoolOwnership,
  unitsPerPeriod,
  withdrawUnstreamed,
} from '@sharedarc/sdk';
import { useId, useState } from 'react';
import { type Address, isAddress } from 'viem';
import { useAccount } from 'wagmi';
import { AddressLink, ErrorNote } from '@/components/app-states';
import { useI18n } from '@/components/i18n';
import { useTx } from '@/components/tx';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Notice,
  Select,
} from '@/components/ui/primitives';
import { formatUsdc, formatUsdcShort, parseUsdc } from '@/lib/format';
import { buildRate, buildShares, isRatePeriod, RATE_PERIODS, type RatePeriod } from '@/lib/pool';

/**
 * Everything the pool owner can do (PRD 6). Rendered only for the owner; a cancelled pool disables all of it,
 * because the contract refuses every owner call but the ownership transfer pair once `cancelled` is set.
 */
export function OwnerPanel({
  poolId,
  pool,
  rows,
  unstreamedUnits,
}: {
  poolId: bigint;
  pool: PoolState;
  rows: readonly MemberRow[];
  unstreamedUnits: bigint;
}) {
  const { t } = useI18n();
  const { address } = useAccount();
  const { run, busy, error } = useTx();
  const ids = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const frozenByCancel = pool.cancelled;

  // --- shares
  const [member, setMember] = useState('');
  const [shares, setSharesInput] = useState('');
  async function submitShares() {
    setProblem(null);
    if (!isAddress(member.trim())) {
      setProblem(t('error.address'));
      return;
    }
    const current = rows.find((r) => r.address.toLowerCase() === member.trim().toLowerCase())?.shares ?? 0n;
    const built = buildShares(shares, { current, totalShares: pool.totalShares });
    if (!built.ok) {
      setProblem(t(`error.shares.${built.error}`));
      return;
    }
    const ok = await run('tx.label.setShares', (sdk) =>
      setShares(sdk, poolId, member.trim() as Address, built.shares),
    );
    if (ok) {
      setMember('');
      setSharesInput('');
    }
  }

  // --- rate
  const [amount, setAmount] = useState(formatUsdcShort(unitsPerPeriod(pool.ratePerSecond, 'month')));
  const [period, setPeriod] = useState<RatePeriod>('month');
  async function submitRate(rate?: bigint) {
    setProblem(null);
    let next = rate;
    if (next === undefined) {
      const built = buildRate(amount, period);
      if (!built.ok) {
        setProblem(t(`error.rate.${built.error}`));
        return;
      }
      next = built.ratePerSecond;
    }
    await run('tx.label.setRate', (sdk) => setRate(sdk, poolId, next));
  }

  // --- unstreamed
  const [pullAmount, setPullAmount] = useState('');
  const [pullTo, setPullTo] = useState('');
  async function submitUnstreamed() {
    setProblem(null);
    const parsed = parseUsdc(pullAmount);
    if (!parsed.ok) {
      setProblem(t(`error.amount.${parsed.error}`));
      return;
    }
    const to = pullTo.trim() === '' ? (address ?? '') : pullTo.trim();
    if (!isAddress(to)) {
      setProblem(t('error.address'));
      return;
    }
    const ok = await run('tx.label.withdrawUnstreamed', (sdk) =>
      withdrawUnstreamed(sdk, poolId, parsed.value, to as Address),
    );
    if (ok) setPullAmount('');
  }

  // --- cancel
  const [confirm, setConfirm] = useState('');
  const [cancelTo, setCancelTo] = useState('');
  async function submitCancel() {
    setProblem(null);
    if (confirm.trim() !== 'CANCEL') {
      setProblem(t('error.confirm'));
      return;
    }
    const to = cancelTo.trim() === '' ? (address ?? '') : cancelTo.trim();
    if (!isAddress(to)) {
      setProblem(t('error.address'));
      return;
    }
    await run('tx.label.cancel', (sdk) => cancel(sdk, poolId, to as Address));
  }

  // --- ownership
  const [newOwner, setNewOwner] = useState('');
  async function submitTransfer() {
    setProblem(null);
    if (!isAddress(newOwner.trim())) {
      setProblem(t('error.address'));
      return;
    }
    const ok = await run('tx.label.transferOwnership', (sdk) =>
      transferPoolOwnership(sdk, poolId, newOwner.trim() as Address),
    );
    if (ok) setNewOwner('');
  }

  const disabled = busy !== null || frozenByCancel;

  return (
    <Card data-testid="owner-panel">
      <CardHeader>
        <CardTitle>{t('owner.title')}</CardTitle>
        <p className="text-muted text-sm">{t('owner.only')}</p>
      </CardHeader>
      <CardContent>
        {frozenByCancel ? <Notice tone="danger">{t('owner.cancelledNote')}</Notice> : null}
        {problem ? <ErrorNote message={problem} /> : null}
        {error ? <ErrorNote message={error} /> : null}

        <section className="flex flex-col gap-3 border-hairline border-t pt-4">
          <h3 className="font-medium text-sm">{t('owner.shares.title')}</h3>
          <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
            <Field label={t('owner.shares.member')} htmlFor={`${ids}-member`}>
              <Input
                id={`${ids}-member`}
                value={member}
                placeholder="0x…"
                className="font-mono text-xs"
                onChange={(e) => setMember(e.target.value)}
              />
            </Field>
            <Field label={t('owner.shares.shares')} htmlFor={`${ids}-shares`} hint={t('owner.shares.hint')}>
              <Input
                id={`${ids}-shares`}
                inputMode="numeric"
                value={shares}
                placeholder="1"
                onChange={(e) => setSharesInput(e.target.value)}
              />
            </Field>
          </div>
          <Button variant="outline" className="w-fit" disabled={disabled} onClick={submitShares}>
            {t('owner.shares.submit')}
          </Button>
        </section>

        <section className="flex flex-col gap-3 border-hairline border-t pt-4">
          <h3 className="font-medium text-sm">{t('owner.rate.title')}</h3>
          {pool.ratePerSecond === 0n ? (
            <p className="text-muted text-xs">{t('owner.rate.pausedHint')}</p>
          ) : (
            <p className="text-muted text-xs">{fromRatePerSecond(pool.ratePerSecond, 'second')} USDC/s</p>
          )}
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <Field label={t('create.amount')} htmlFor={`${ids}-rate`}>
              <Input
                id={`${ids}-rate`}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label={t('create.per')} htmlFor={`${ids}-rate-period`}>
              <Select
                id={`${ids}-rate-period`}
                value={period}
                onChange={(e) => isRatePeriod(e.target.value) && setPeriod(e.target.value)}
              >
                {RATE_PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {t(`create.per.${p}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={disabled} onClick={() => submitRate()}>
              {t('owner.rate.submit')}
            </Button>
            <Button
              variant="ghost"
              disabled={disabled || pool.ratePerSecond === 0n}
              onClick={() => submitRate(0n)}
            >
              {t('owner.rate.pause')}
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-3 border-hairline border-t pt-4">
          <h3 className="font-medium text-sm">{t('owner.unstreamed.title')}</h3>
          <p className="text-muted text-xs">
            {t('owner.unstreamed.available', { amount: formatUsdc(unstreamedUnits) })} ·{' '}
            {t('owner.unstreamed.hint')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('deposit.amount')} htmlFor={`${ids}-pull`}>
              <Input
                id={`${ids}-pull`}
                inputMode="decimal"
                value={pullAmount}
                onChange={(e) => setPullAmount(e.target.value)}
              />
            </Field>
            <Field label={t('owner.unstreamed.to')} htmlFor={`${ids}-pull-to`}>
              <Input
                id={`${ids}-pull-to`}
                value={pullTo}
                placeholder={address ?? '0x…'}
                className="font-mono text-xs"
                onChange={(e) => setPullTo(e.target.value)}
              />
            </Field>
          </div>
          <Button variant="outline" className="w-fit" disabled={disabled} onClick={submitUnstreamed}>
            {t('owner.unstreamed.submit')}
          </Button>
        </section>

        <section className="flex flex-col gap-3 border-hairline border-t pt-4">
          <h3 className="font-medium text-sm">{t('owner.transfer.title')}</h3>
          <p className="text-muted text-xs">{t('owner.transfer.body')}</p>
          {pool.pendingOwner !== '0x0000000000000000000000000000000000000000' ? (
            <p className="text-muted text-xs">
              {t('owner.transfer.pending', { address: '' })} <AddressLink address={pool.pendingOwner} />
            </p>
          ) : null}
          <Field label={t('owner.transfer.newOwner')} htmlFor={`${ids}-owner`}>
            <Input
              id={`${ids}-owner`}
              value={newOwner}
              placeholder="0x…"
              className="font-mono text-xs"
              onChange={(e) => setNewOwner(e.target.value)}
            />
          </Field>
          {/* Ownership transfer is the one owner action the contract still allows on a cancelled pool. */}
          <Button variant="outline" className="w-fit" disabled={busy !== null} onClick={submitTransfer}>
            {t('owner.transfer.submit')}
          </Button>
        </section>

        <section className="flex flex-col gap-3 border-hairline border-t pt-4">
          <h3 className="font-medium text-sm">{t('owner.cancel.title')}</h3>
          <p className="text-muted text-xs">{t('owner.cancel.body')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('owner.unstreamed.to')} htmlFor={`${ids}-cancel-to`}>
              <Input
                id={`${ids}-cancel-to`}
                value={cancelTo}
                placeholder={address ?? '0x…'}
                className="font-mono text-xs"
                onChange={(e) => setCancelTo(e.target.value)}
              />
            </Field>
            <Field label={t('owner.cancel.confirm')} htmlFor={`${ids}-confirm`}>
              <Input
                id={`${ids}-confirm`}
                value={confirm}
                placeholder="CANCEL"
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
          </div>
          <Button variant="danger" className="w-fit" disabled={disabled} onClick={submitCancel}>
            {t('owner.cancel.submit')}
          </Button>
        </section>
      </CardContent>
    </Card>
  );
}

/** The one action the pending owner can take. Works on a cancelled pool too (PRD 4.3). */
export function AcceptOwnership({ poolId }: { poolId: bigint }) {
  const { t } = useI18n();
  const { run, busy, error } = useTx();
  return (
    <Card data-testid="accept-ownership">
      <CardHeader>
        <CardTitle>{t('owner.accept.title')}</CardTitle>
        <p className="text-muted text-sm">{t('owner.accept.body')}</p>
      </CardHeader>
      <CardContent>
        {error ? <ErrorNote message={error} /> : null}
        <Button
          variant="accent"
          className="w-fit"
          disabled={busy !== null}
          onClick={() => run('tx.label.acceptOwnership', (sdk) => acceptPoolOwnership(sdk, poolId))}
        >
          {t('owner.accept.submit')}
        </Button>
      </CardContent>
    </Card>
  );
}
