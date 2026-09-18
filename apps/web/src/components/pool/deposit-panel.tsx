'use client';

import { type AccrualPool, approveAndDeposit, WAD_PER_UNIT } from '@sharedarc/sdk';
import { useId, useState } from 'react';
import { useAccount } from 'wagmi';
import { ErrorNote, RequireWallet } from '@/components/app-states';
import { useI18n } from '@/components/i18n';
import { useTx } from '@/components/tx';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Field, Input } from '@/components/ui/primitives';
import { formatDuration, formatUsdc, formatUsdcShort, parseUsdc } from '@/lib/format';

/** Deposit: approve (only when the allowance is short) then deposit. Permissionless on a live pool (PRD D13). */
export function DepositPanel({
  poolId,
  pool,
  usdcBalance,
}: {
  poolId: bigint;
  pool: AccrualPool;
  usdcBalance: bigint | undefined;
}) {
  const { t } = useI18n();
  const ids = useId();
  const { address } = useAccount();
  const { run, busy, error } = useTx();
  const [amount, setAmount] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<bigint | null>(null);

  const parsed = amount.trim() === '' ? null : parseUsdc(amount);
  // How much runway the typed amount buys at the current rate, so the number means something before signing.
  const addedRunway =
    parsed?.ok && pool.ratePerSecond > 0n && pool.totalShares > 0n
      ? (parsed.value * WAD_PER_UNIT) / pool.ratePerSecond
      : null;

  async function submit() {
    setProblem(null);
    setDone(null);
    if (!parsed) {
      setProblem(t('error.amount.empty'));
      return;
    }
    if (!parsed.ok) {
      setProblem(t(`error.amount.${parsed.error}`));
      return;
    }
    // No `token` override: the SDK reads `usdc()` from the pool contract, so the approval can never target the
    // wrong token because of a build-time environment variable.
    const result = await run('tx.label.deposit', (sdk) => approveAndDeposit(sdk, poolId, parsed.value));
    if (result) {
      setDone(parsed.value);
      setAmount('');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('deposit.title')}</CardTitle>
        <p className="text-muted text-sm">{t('deposit.body')}</p>
      </CardHeader>
      <CardContent>
        <RequireWallet reason={t('deposit.reason')}>
          <Field
            label={t('deposit.amount')}
            htmlFor={`${ids}-amount`}
            hint={
              addedRunway !== null
                ? t('deposit.addsRunway', { duration: formatDuration(addedRunway) })
                : address && usdcBalance !== undefined
                  ? t('deposit.balance', { amount: formatUsdcShort(usdcBalance) })
                  : undefined
            }
          >
            <Input
              id={`${ids}-amount`}
              inputMode="decimal"
              value={amount}
              placeholder="1"
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          {problem ? <ErrorNote message={problem} /> : null}
          {error ? <ErrorNote message={error} /> : null}
          {done !== null ? (
            <p className="text-ok text-sm">{t('deposit.done', { amount: formatUsdc(done) })}</p>
          ) : null}
          <Button variant="accent" className="w-fit" disabled={busy !== null} onClick={submit}>
            {t('deposit.submit')}
          </Button>
        </RequireWallet>
      </CardContent>
    </Card>
  );
}
