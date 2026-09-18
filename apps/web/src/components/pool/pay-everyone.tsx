'use client';

import { type MemberRow, payEveryone } from '@arcdrip/sdk';
import { useState } from 'react';
import { ErrorNote, RequireWallet } from '@/components/app-states';
import { useI18n } from '@/components/i18n';
import { useTx } from '@/components/tx';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Notice } from '@/components/ui/primitives';
import { formatUsdc } from '@/lib/format';
import { planBatch } from '@/lib/pool';

/**
 * "Pay everyone": `withdrawForBatch` over the members with something to withdraw, in chunks of 100 (MAX_BATCH).
 * The contract skips a member whose USDC transfer fails instead of reverting the batch, which is what makes this
 * safe against the issuer's blocklist (PRD D15) — those members are reported back here.
 */
export function PayEveryone({ poolId, rows }: { poolId: bigint; rows: readonly MemberRow[] }) {
  const { t } = useI18n();
  const { run, busy, error } = useTx();
  const [result, setResult] = useState<{ total: bigint; paid: number; skipped: number } | null>(null);

  const plan = planBatch(rows);

  async function submit() {
    setResult(null);
    const res = await run('tx.label.payEveryone', (sdk) => payEveryone(sdk, poolId, plan.payable));
    if (res) setResult({ total: res.total, paid: res.paid.length, skipped: res.skipped.length });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('pay.title')}</CardTitle>
        <p className="text-muted text-sm">{t('pay.body')}</p>
      </CardHeader>
      <CardContent>
        {plan.payable.length === 0 ? (
          <p className="text-muted text-sm">{t('pay.none')}</p>
        ) : (
          <p className="text-muted text-sm" data-testid="pay-plan">
            {t('pay.plan', {
              count: plan.payable.length,
              total: formatUsdc(plan.total),
              chunks: plan.chunks.length,
            })}
          </p>
        )}
        {error ? <ErrorNote message={error} /> : null}
        {result ? (
          <div className="flex flex-col gap-2">
            <p className="text-ok text-sm">
              {t('pay.done', { total: formatUsdc(result.total), count: result.paid })}
            </p>
            {result.skipped > 0 ? (
              <Notice tone="warn">{t('pay.skipped', { count: result.skipped })}</Notice>
            ) : null}
          </div>
        ) : null}
        <RequireWallet reason={t('pay.reason')}>
          <Button
            variant="accent"
            className="w-fit"
            disabled={busy !== null || plan.payable.length === 0}
            onClick={submit}
          >
            {t('pay.submit')}
          </Button>
        </RequireWallet>
      </CardContent>
    </Card>
  );
}
