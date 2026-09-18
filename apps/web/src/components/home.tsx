'use client';

import { createPool, fromRatePerSecond, unitsPerPeriod } from '@sharedarc/sdk';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { type Address, isAddress } from 'viem';
import { useAccount } from 'wagmi';
import { formatUsdcShort } from '@/lib/format';
import { useMounted } from '@/lib/hooks';
import { buildRate, isRatePeriod, RATE_PERIODS, type RatePeriod } from '@/lib/pool';
import { AddressLink, ErrorNote, InlineLink, PageHeader, RequireDrip, RequireWallet } from './app-states';
import { useDocumentTitle, useI18n } from './i18n';
import { usePoolList } from './queries';
import { TxList, useTx } from './tx';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader, CardTitle, Field, Input, Select, Skeleton } from './ui/primitives';

export function HomePage() {
  const { t } = useI18n();
  useDocumentTitle(t('app.tagline'));
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6">
      <PageHeader eyebrow={t('home.eyebrow')} title={t('home.title')}>
        <div className="flex flex-col gap-2">
          <p>{t('home.lead1')}</p>
          <p>{t('home.lead2')}</p>
          <p>{t('home.lead3')}</p>
          <p>
            <InlineLink href="/docs/">{t('home.docsLink')} →</InlineLink>
          </p>
        </div>
      </PageHeader>
      <div className="grid gap-6 lg:grid-cols-2">
        <CreatePoolForm />
        <div className="flex flex-col gap-6">
          <RecentPools />
          <TxList />
        </div>
      </div>
    </div>
  );
}

function CreatePoolForm() {
  const { t } = useI18n();
  const ids = useId();
  const { address } = useAccount();
  const { run, busy, error } = useTx();
  const router = useRouter();

  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState<RatePeriod>('month');
  const [owner, setOwner] = useState('');
  const [start, setStart] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [created, setCreated] = useState<bigint | null>(null);

  const rate = amount.trim() === '' ? null : buildRate(amount, period);
  const preview =
    rate?.ok === true
      ? t('create.rateHint', {
          amount: fromRatePerSecond(rate.ratePerSecond, 'second'),
          perPeriod: formatUsdcShort(unitsPerPeriod(rate.ratePerSecond, period)),
          period: t(`create.per.${period}`),
        })
      : t('create.nameHint');

  async function submit() {
    setProblem(null);
    setCreated(null);
    if (!rate) {
      setProblem(t('error.rate.amount'));
      return;
    }
    if (!rate.ok) {
      setProblem(t(`error.rate.${rate.error}`));
      return;
    }
    const ownerText = owner.trim() === '' ? (address ?? '') : owner.trim();
    if (!isAddress(ownerText)) {
      setProblem(t('error.address'));
      return;
    }
    let startTime = 0n;
    if (start.trim() !== '') {
      const seconds = Math.floor(new Date(start).getTime() / 1000);
      if (!Number.isFinite(seconds) || seconds * 1000 <= Date.now()) {
        setProblem(t('error.startTime'));
        return;
      }
      startTime = BigInt(seconds);
    }
    const result = await run('tx.label.createPool', (sdk) =>
      createPool(sdk, { owner: ownerText as Address, ratePerSecond: rate.ratePerSecond, startTime, name }),
    );
    if (result) {
      setCreated(result.poolId);
      router.push(`/pool/?id=${result.poolId}`);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('create.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <RequireDrip>
          <RequireWallet reason={t('create.reason')}>
            <Field label={t('create.name')} htmlFor={`${ids}-name`} hint={t('create.nameHint')}>
              <Input
                id={`${ids}-name`}
                value={name}
                placeholder={t('create.namePlaceholder')}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
              <Field label={t('create.amount')} htmlFor={`${ids}-amount`} hint={preview}>
                <Input
                  id={`${ids}-amount`}
                  inputMode="decimal"
                  value={amount}
                  placeholder="1000"
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
              <Field label={t('create.per')} htmlFor={`${ids}-period`}>
                <Select
                  id={`${ids}-period`}
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
            <Field label={t('create.owner')} htmlFor={`${ids}-owner`} hint={t('create.ownerHint')}>
              <Input
                id={`${ids}-owner`}
                value={owner}
                placeholder={address ?? '0x…'}
                onChange={(e) => setOwner(e.target.value)}
                className="font-mono text-xs"
              />
            </Field>
            <Field label={t('create.start')} htmlFor={`${ids}-start`} hint={t('create.startHint')}>
              <Input
                id={`${ids}-start`}
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            {problem ? <ErrorNote message={problem} /> : null}
            {error ? <ErrorNote message={error} /> : null}
            {created !== null ? (
              <p className="text-ok text-sm">{t('create.created', { id: created.toString() })}</p>
            ) : null}
            <Button variant="accent" disabled={busy !== null} onClick={submit} className="w-fit">
              {t('create.submit')}
            </Button>
          </RequireWallet>
        </RequireDrip>
      </CardContent>
    </Card>
  );
}

function RecentPools() {
  const { t } = useI18n();
  const mounted = useMounted();
  const ids = useId();
  const router = useRouter();
  const [poolId, setPoolId] = useState('');
  const { data, isPending } = usePoolList();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('recent.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (/^\d+$/.test(poolId.trim()) && BigInt(poolId.trim()) > 0n)
              router.push(`/pool/?id=${poolId.trim()}`);
          }}
        >
          <Field label={t('recent.byId.label')} htmlFor={`${ids}-id`}>
            <Input
              id={`${ids}-id`}
              inputMode="numeric"
              value={poolId}
              placeholder="1"
              onChange={(e) => setPoolId(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="outline" className="h-10">
            {t('recent.byId.submit')}
          </Button>
        </form>
        <RequireDrip>
          {!mounted || isPending ? (
            <Skeleton className="h-24 w-full" />
          ) : !data || data.length === 0 ? (
            <p className="text-muted text-sm">{t('recent.empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-hairline">
              {data.map((p) => (
                <li key={p.poolId.toString()} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-sm">
                      {p.name || t('pool.untitled')}{' '}
                      <span className="text-faint">#{p.poolId.toString()}</span>
                    </span>
                    <AddressLink address={p.owner} className="text-faint" />
                  </span>
                  <Link
                    href={`/pool/?id=${p.poolId}`}
                    className="inline-flex shrink-0 items-center gap-1 text-accent text-sm underline-offset-4 hover:underline"
                  >
                    {t('recent.open')}
                    <ArrowRight aria-hidden className="size-3.5" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </RequireDrip>
      </CardContent>
    </Card>
  );
}
