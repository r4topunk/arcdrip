'use client';

// Chain reads, all through the public RPC client (read-only mode works without a wallet). Every query is disabled
// when no DripPool is configured.
//
// The refresh interval is the "re-sync every 30 s" of PRD 6: between two syncs the member table ticks locally
// from `math.ts`, which is bit-identical to the contract, so the number on screen is never a guess.
import {
  dripPoolAbi,
  erc20Abi,
  getPoolMembers,
  type PoolMember,
  type PoolState,
  parsePoolState,
  splitBlockRange,
} from '@sharedarc/sdk';
import { useQuery } from '@tanstack/react-query';
import { type Address, type PublicClient, parseEventLogs } from 'viem';
import { getBlockNumber, getLogs, readContract } from 'viem/actions';
import { usePublicClient } from 'wagmi';
import { CHAIN_ID, config } from '@/lib/config';

const DRIP = config.drip;
/** PRD 6: the table re-syncs with the chain every 30 seconds (and after every transaction). */
export const REFRESH_MS = 30_000;

export function useClient() {
  return usePublicClient({ chainId: CHAIN_ID });
}

type Client = PublicClient;

/** One pool's full state, or null when the id does not exist (the contract reverts `PoolNotFound`). */
export function usePool(poolId: bigint | null) {
  const client = useClient();
  return useQuery({
    queryKey: ['pool', CHAIN_ID, DRIP, poolId?.toString()],
    enabled: !!client && !!DRIP && poolId !== null,
    refetchInterval: REFRESH_MS,
    retry: 1,
    queryFn: async (): Promise<PoolState | null> => {
      try {
        const raw = await readContract(client as Client, {
          address: DRIP!,
          abi: dripPoolAbi,
          functionName: 'getPool',
          args: [poolId!],
        });
        return parsePoolState(raw);
      } catch (error) {
        if (/PoolNotFound/.test(String((error as Error)?.message ?? ''))) return null;
        throw error;
      }
    },
  });
}

/** The pool's members, discovered from `SharesSet` logs in 10,000-block windows plus one `getMember` multicall. */
export function usePoolMembers(poolId: bigint | null) {
  const client = useClient();
  return useQuery({
    queryKey: ['pool-members', CHAIN_ID, DRIP, poolId?.toString()],
    enabled: !!client && !!DRIP && poolId !== null,
    refetchInterval: REFRESH_MS,
    queryFn: (): Promise<PoolMember[]> =>
      getPoolMembers(client as Client, {
        address: DRIP!,
        poolId: poolId!,
        fromBlock: config.deployBlock,
      }),
  });
}

export interface PoolSummary {
  poolId: bigint;
  owner: Address;
  ratePerSecond: bigint;
  startTime: bigint;
  name: string;
  blockNumber: bigint;
}

/** Every pool ever created on this deployment, newest first, read from `PoolCreated` logs. */
export function usePoolList(limit = 12) {
  const client = useClient();
  return useQuery({
    queryKey: ['pool-list', CHAIN_ID, DRIP, limit],
    enabled: !!client && !!DRIP,
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<PoolSummary[]> => {
      const latest = await getBlockNumber(client as Client, { cacheTime: 0 });
      const out: PoolSummary[] = [];
      for (const window of splitBlockRange(config.deployBlock, latest)) {
        const logs = await getLogs(client as Client, {
          address: DRIP!,
          fromBlock: window.fromBlock,
          toBlock: window.toBlock,
        });
        for (const log of parseEventLogs({ abi: dripPoolAbi, logs })) {
          if (log.eventName !== 'PoolCreated') continue;
          const args = log.args as unknown as Omit<PoolSummary, 'blockNumber'>;
          out.push({ ...args, blockNumber: log.blockNumber ?? 0n });
        }
      }
      out.sort((a, b) => (a.poolId === b.poolId ? 0 : a.poolId > b.poolId ? -1 : 1));
      return out.slice(0, limit);
    },
  });
}

/** USDC balance in the 6-decimal ERC-20 view; the 18-decimal native view of the same funds is never read. */
export function useUsdcBalance(account: Address | undefined) {
  const client = useClient();
  return useQuery({
    queryKey: ['usdc-balance', CHAIN_ID, config.usdc, account],
    enabled: !!client && !!account,
    refetchInterval: REFRESH_MS,
    queryFn: () =>
      readContract(client as Client, {
        address: config.usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account!],
      }),
  });
}

/**
 * Seconds between the chain clock and the local clock. Accrual is decided by `block.timestamp`, so the ticking
 * table follows the chain when a laptop's clock drifts. Offsets under 10 s are latency, not disagreement.
 */
export function useClockOffset(): number {
  const client = useClient();
  const { data } = useQuery({
    queryKey: ['chain-clock', CHAIN_ID],
    enabled: !!client && !!DRIP,
    refetchInterval: 60_000,
    queryFn: async () => {
      const block = await (client as Client).getBlock({ blockTag: 'latest' });
      return clockOffset(Number(block.timestamp), Date.now() / 1000);
    },
  });
  return data ?? 0;
}

/** Offsets below this are network latency and block time, not a clock disagreement. */
const MIN_OFFSET_SECONDS = 10;

/** Pure: the offset to apply, or 0 when the chain and local clocks agree within the tolerance. */
export function clockOffset(latestBlockTimestamp: number, localSeconds: number): number {
  const offset = Math.round(latestBlockTimestamp - localSeconds);
  return Math.abs(offset) < MIN_OFFSET_SECONDS ? 0 : offset;
}
