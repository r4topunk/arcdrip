'use client';

import { type DripPoolConfig, WalletRequiredError, type WriteResult, type WriteSuccess } from '@arcdrip/sdk';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { Hash, PublicClient, WalletClient } from 'viem';
import { useAccount, useConfig, usePublicClient } from 'wagmi';
import { getWalletClient, switchChain } from 'wagmi/actions';
import { CHAIN_ID, config, explorerTx } from '@/lib/config';
import { errorMessage, revertMessage } from '@/lib/errors';
import { shortHash } from '@/lib/format';
import type { MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useI18n } from './i18n';

export type TxLabel = Extract<MessageKey, `tx.label.${string}`>;
export type TxStatus = 'pending' | 'success' | 'reverted';
export interface TxRecord {
  label: TxLabel;
  hash: Hash;
  status: TxStatus;
}

interface TxStore {
  history: TxRecord[];
  record: (r: TxRecord) => void;
}

const TxContext = createContext<TxStore>({ history: [], record: () => {} });

/** Keeps every transaction sent this session (newest first) so each page can list hashes with explorer links. */
export function TxProvider({ children }: { children: ReactNode }) {
  const [history, setHistory] = useState<TxRecord[]>([]);
  const record = useCallback((r: TxRecord) => {
    setHistory((h) => [r, ...h.filter((x) => x.hash !== r.hash)].slice(0, 20));
  }, []);
  const value = useMemo(() => ({ history, record }), [history, record]);
  return <TxContext.Provider value={value}>{children}</TxContext.Provider>;
}

export function TxHashLink({ hash, className }: { hash: Hash; className?: string }) {
  const { t } = useI18n();
  const href = explorerTx(hash);
  if (!href) return <span className={cn('font-mono text-xs', className)}>{shortHash(hash)}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`${t('tx.view')}: ${hash}`}
      className={cn(
        'inline-flex items-center gap-1 font-mono text-accent text-xs underline-offset-2 hover:underline',
        className,
      )}
    >
      {shortHash(hash)}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}

/**
 * Runs one SDK write: makes sure a wallet is connected on the right chain, hands the action a `DripPoolConfig`,
 * and turns the result into UI. The SDK simulates before signing, so a refused call costs no gas and comes back
 * as `{ ok: false, error }` with the custom error already decoded — that is the message shown (PRD 6).
 * Every write refreshes the chain queries, which is the "re-sync after each tx" the ticking table needs.
 */
export function useTx() {
  const wagmi = useConfig();
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const queryClient = useQueryClient();
  const { t, locale } = useI18n();
  const { history, record } = useContext(TxContext);
  const [busy, setBusy] = useState<TxLabel | null>(null);
  const [error, setError] = useState<string | null>(null);

  const getWallet = useCallback(async (): Promise<WalletClient> => {
    if (!isConnected || !address) throw new WalletRequiredError('transaction');
    if (chainId !== CHAIN_ID) await switchChain(wagmi, { chainId: CHAIN_ID });
    return getWalletClient(wagmi, { chainId: CHAIN_ID });
  }, [wagmi, address, chainId, isConnected]);

  const run = useCallback(
    async <T,>(
      label: TxLabel,
      send: (sdk: DripPoolConfig) => Promise<WriteResult<T>>,
    ): Promise<WriteSuccess<T> | null> => {
      const name = t(label);
      setBusy(label);
      setError(null);
      const id = toast.loading(t('tx.confirmWallet', { label: name }));
      try {
        if (!config.drip) throw new Error(t('error.noDrip'));
        const walletClient = await getWallet();
        const result = await send({
          publicClient: publicClient as PublicClient,
          walletClient,
          address: config.drip,
        });
        if (!result.ok) {
          const msg = revertMessage(result.error, locale);
          setError(msg);
          toast.error(t('tx.failed', { label: name }), { id, description: msg });
          return null;
        }
        record({ label, hash: result.hash, status: 'success' });
        toast.success(name, { id, description: <TxHashLink hash={result.hash} /> });
        await queryClient.invalidateQueries();
        return result;
      } catch (e) {
        const msg = errorMessage(e, locale);
        setError(msg);
        toast.error(t('tx.failed', { label: name }), { id, description: msg });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [getWallet, publicClient, queryClient, record, t, locale],
  );

  return { busy, error, setError, run, history };
}

/** Transactions sent this session, each with its hash and explorer link. */
export function TxList({ labels }: { labels?: readonly TxLabel[] }) {
  const { t } = useI18n();
  const { history } = useContext(TxContext);
  const items = labels ? history.filter((h) => labels.includes(h.label)) : history;
  if (items.length === 0) return null;
  const dot: Record<TxStatus, string> = { pending: 'bg-warn', success: 'bg-ok', reverted: 'bg-danger' };
  return (
    <div className="rounded-xl border border-hairline-strong p-4" aria-live="polite">
      <p className="eyebrow mb-2">{t('tx.title')}</p>
      <ul className="flex flex-col gap-2 text-sm">
        {items.map((r) => (
          <li key={r.hash} className="flex flex-wrap items-center justify-between gap-2">
            <span className="inline-flex items-center gap-2">
              <span aria-hidden className={cn('size-2 rounded-full', dot[r.status])} />
              {t(r.label)}
              <span className="text-muted text-xs">{t(`tx.${r.status}`)}</span>
            </span>
            <TxHashLink hash={r.hash} />
          </li>
        ))}
      </ul>
    </div>
  );
}
