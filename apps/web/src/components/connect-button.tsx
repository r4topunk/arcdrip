'use client';

import { LogOut, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { CHAIN_ID, config } from '@/lib/config';
import { errorMessage } from '@/lib/errors';
import { shortAddress } from '@/lib/format';
import { useMounted } from '@/lib/hooks';
import { useI18n } from './i18n';
import { Button } from './ui/button';

export function ConnectButton({ size = 'sm' }: { size?: 'sm' | 'default' }) {
  const mounted = useMounted();
  const { t, locale } = useI18n();
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connectAsync, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChainAsync, isPending: switching } = useSwitchChain();

  if (!mounted) {
    return (
      <Button size={size} variant="outline" disabled aria-label={t('wallet.loading')}>
        <Wallet /> {t('wallet.connect')}
      </Button>
    );
  }

  if (isConnected && address) {
    if (chainId !== CHAIN_ID) {
      return (
        <Button
          size={size}
          variant="danger"
          disabled={switching}
          onClick={() =>
            switchChainAsync({ chainId: CHAIN_ID }).catch((e) => toast.error(errorMessage(e, locale)))
          }
        >
          {t('wallet.switch', { chain: config.chainLabel })}
        </Button>
      );
    }
    return (
      <div className="flex items-center gap-1">
        <span
          className="hidden h-8 items-center gap-2 rounded-lg border border-hairline-strong px-2.5 font-mono text-xs sm:inline-flex"
          title={t('wallet.connected', { address })}
        >
          <span className="size-1.5 rounded-full bg-ok" aria-hidden />
          {shortAddress(address)}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={t('wallet.disconnect')}
          onClick={() => disconnect()}
        >
          <LogOut />
        </Button>
      </div>
    );
  }

  // Prefer a wallet announced through EIP-6963, else the generic injected connector.
  const connector = connectors.find((c) => c.type === 'injected' && c.id !== 'injected') ?? connectors[0];

  return (
    <Button
      size={size}
      variant="outline"
      disabled={isPending}
      onClick={async () => {
        if (!connector) {
          toast.error(t('wallet.noProvider'));
          return;
        }
        try {
          await connectAsync({ connector, chainId: CHAIN_ID });
        } catch (e) {
          toast.error(errorMessage(e, locale));
        }
      }}
    >
      <Wallet /> {isPending ? t('wallet.connecting') : t('wallet.connect')}
    </Button>
  );
}
