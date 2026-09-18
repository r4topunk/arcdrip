'use client';

import { type MemberRow, setPayoutAddress } from '@sharedarc/sdk';
import { useId, useState } from 'react';
import { type Address, isAddress, zeroAddress } from 'viem';
import { AddressLink, ErrorNote } from '@/components/app-states';
import { useI18n } from '@/components/i18n';
import { useTx } from '@/components/tx';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Field, Input } from '@/components/ui/primitives';
import { formatUsdc } from '@/lib/format';

/**
 * What a member can do for themselves: see what they have accrued and point their payout somewhere else. Setting
 * a payout address works even with zero shares, which is how a blocklisted member recovers what the pool owes.
 */
export function MemberPanel({
  poolId,
  row,
  account,
}: {
  poolId: bigint;
  row: MemberRow | undefined;
  account: Address;
}) {
  const { t } = useI18n();
  const ids = useId();
  const { run, busy, error } = useTx();
  const [payout, setPayout] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(to?: Address) {
    setProblem(null);
    const target = to ?? payout.trim();
    if (!isAddress(target)) {
      setProblem(t('error.address'));
      return;
    }
    const ok = await run('tx.label.setPayout', (sdk) => setPayoutAddress(sdk, poolId, target as Address));
    if (ok) setPayout('');
  }

  const current = row?.payout;
  const ownPayout = !current || current === zeroAddress || current.toLowerCase() === account.toLowerCase();

  return (
    <Card data-testid="member-panel">
      <CardHeader>
        <CardTitle>{t('member.title')}</CardTitle>
        {row ? (
          <p className="text-muted text-sm">{t('member.claimable', { amount: formatUsdc(row.claimable) })}</p>
        ) : (
          <p className="text-muted text-sm">{t('member.notMember')}</p>
        )}
      </CardHeader>
      <CardContent>
        <h3 className="font-medium text-sm">{t('member.payout.title')}</h3>
        <p className="text-muted text-xs">
          {ownPayout ? (
            t('member.payout.own')
          ) : (
            <>
              {t('member.payout.current', { address: '' })} <AddressLink address={current} />
            </>
          )}
        </p>
        <Field label={t('member.payout.title')} htmlFor={`${ids}-payout`} hint={t('member.payout.hint')}>
          <Input
            id={`${ids}-payout`}
            value={payout}
            placeholder="0x…"
            className="font-mono text-xs"
            onChange={(e) => setPayout(e.target.value)}
          />
        </Field>
        {problem ? <ErrorNote message={problem} /> : null}
        {error ? <ErrorNote message={error} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy !== null} onClick={() => submit()}>
            {t('member.payout.submit')}
          </Button>
          <Button variant="ghost" disabled={busy !== null || ownPayout} onClick={() => submit(account)}>
            {t('member.payout.reset')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
