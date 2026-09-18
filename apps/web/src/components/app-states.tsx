'use client';

import { CircleAlert, RefreshCw, WifiOff } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useAccount } from 'wagmi';
import { CHAIN_ID, config, explorerAddress } from '@/lib/config';
import { shortAddress } from '@/lib/format';
import { useMounted } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import { ConnectButton } from './connect-button';
import { useI18n } from './i18n';
import { Button } from './ui/button';
import { Card, Skeleton } from './ui/primitives';

export function PageHeader({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow: string;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-hairline border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="kicker">{eyebrow}</span>
        <h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">{title}</h1>
        {children ? <div className="max-w-2xl text-muted">{children}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function NotConfigured() {
  const { t } = useI18n();
  return (
    <Card className="flex flex-col gap-3 p-6 sm:p-8">
      <span className="eyebrow">{config.chainLabel}</span>
      <h2 className="font-semibold text-xl">{t('state.notConfigured.title')}</h2>
      <p className="max-w-xl text-muted text-sm">{t('state.notConfigured.body')}</p>
      <a
        href={`${config.repoUrl}/blob/main/DEPLOY.md`}
        target="_blank"
        rel="noreferrer"
        className="w-fit text-accent text-sm underline underline-offset-4"
      >
        {t('state.notConfigured.link')}
      </a>
    </Card>
  );
}

export function RpcError({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <Card role="alert" className="flex flex-col items-start gap-3 p-6">
      <WifiOff aria-hidden className="size-5 text-danger" />
      <h2 className="font-semibold text-lg">{t('state.rpcError.title')}</h2>
      <p className="text-muted text-sm">{t('state.rpcError.body', { rpc: config.rpcUrl })}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw /> {t('state.retry')}
      </Button>
    </Card>
  );
}

/** Children only when a DripPool address is configured; otherwise the not-configured card. */
export function RequireDrip({ children }: { children: ReactNode }) {
  if (!config.drip) return <NotConfigured />;
  return <>{children}</>;
}

/** Children only when a wallet is connected on the configured chain; otherwise a connect or switch prompt. */
export function RequireWallet({ children, reason }: { children: ReactNode; reason: string }) {
  const mounted = useMounted();
  const { isConnected, chainId } = useAccount();
  const { t } = useI18n();
  if (!mounted) return <Skeleton className="h-28 w-full" />;
  if (!isConnected || chainId !== CHAIN_ID) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg bg-surface-2 p-4">
        <p className="font-medium text-sm">
          {isConnected ? t('state.switch.title', { chain: config.chainLabel }) : t('state.connect.title')}
        </p>
        <p className="text-muted text-sm">{reason}</p>
        <ConnectButton size="default" />
      </div>
    );
  }
  return <>{children}</>;
}

export function AddressLink({
  address,
  label,
  className,
}: {
  address: string;
  label?: string;
  className?: string;
}) {
  const href = explorerAddress(address);
  const text = label ?? shortAddress(address);
  if (!href)
    return (
      <span title={address} className={cn('font-mono text-xs', className)}>
        {text}
      </span>
    );
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={address}
      className={cn(
        'font-mono text-xs underline decoration-hairline-strong underline-offset-4 hover:decoration-accent',
        className,
      )}
    >
      {text}
    </a>
  );
}

export function ErrorNote({ message, className }: { message: string; className?: string }) {
  return (
    <div
      role="alert"
      className={cn('flex gap-2 rounded-lg bg-danger-soft px-4 py-3 text-danger text-sm', className)}
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="text-accent underline underline-offset-4">
      {children}
    </Link>
  );
}
