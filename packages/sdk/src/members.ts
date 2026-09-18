// Member discovery (PRD 5). `DripPool` deliberately keeps no on-chain member list — enumerating members on-chain
// would turn every join into an O(n) write — so the member set is rebuilt from `SharesSet` logs and then
// confirmed with one `getMember` multicall.
//
// Two constraints shape this file:
//   - Arc's public RPC caps `eth_getLogs` at 10,000 blocks, so ranges are split into windows and the window is
//     halved automatically if a node still refuses it.
//   - A member with zero shares is not gone: they keep whatever they accrued until they withdraw it. So the
//     result keeps every address that has shares OR a pending balance, and only drops the ones that are truly
//     settled at zero.
import type { AbiEvent, Address, PublicClient } from 'viem';
import { dripPoolAbi } from './abi/DripPool.js';
import { MAX_LOG_RANGE_BLOCKS } from './constants.js';
import { claimable } from './math.js';
import type { AccrualPool, MemberState } from './schemas.js';
import { memberStateSchema, parseWith } from './schemas.js';

/** The `SharesSet` event, the only one that can introduce a member. */
export const sharesSetEvent = dripPoolAbi.find(
  (item) => item.type === 'event' && item.name === 'SharesSet',
) as AbiEvent;

export type BlockWindow = { fromBlock: bigint; toBlock: bigint };

/**
 * Splits `[fromBlock, toBlock]` into inclusive windows of at most `size` blocks. Pure; the chunking is tested
 * on its own because it is the part that breaks silently against a real RPC.
 */
export function splitBlockRange(
  fromBlock: bigint,
  toBlock: bigint,
  size: bigint = MAX_LOG_RANGE_BLOCKS,
): BlockWindow[] {
  if (size <= 0n) throw new RangeError('window size must be > 0');
  if (fromBlock < 0n) throw new RangeError('fromBlock must be >= 0');
  if (toBlock < fromBlock) return [];
  const windows: BlockWindow[] = [];
  for (let start = fromBlock; start <= toBlock; start += size) {
    const end = start + size - 1n;
    windows.push({ fromBlock: start, toBlock: end < toBlock ? end : toBlock });
  }
  return windows;
}

/** True when an RPC error is "your block range is too wide", the one error worth retrying with a smaller window. */
export function isRangeTooLarge(error: unknown): boolean {
  const err = error as { message?: string; details?: string; shortMessage?: string } | undefined;
  const text = `${err?.message ?? ''} ${err?.details ?? ''} ${err?.shortMessage ?? ''}`.toLowerCase();
  return (
    text.includes('range too large') ||
    text.includes('block range') ||
    text.includes('exceed maximum block range') ||
    text.includes('too many results') ||
    text.includes('limit exceeded') ||
    text.includes('-32012')
  );
}

export type SharesSetLog = {
  poolId: bigint;
  member: Address;
  oldShares: bigint;
  newShares: bigint;
  totalShares: bigint;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
};

export type GetSharesSetLogsOptions = {
  address: Address;
  poolId: bigint;
  fromBlock?: bigint;
  toBlock?: bigint;
  /** Blocks per request. Capped at 10,000, the public RPC limit. */
  chunkSize?: bigint;
  /** Called after every window; useful for a progress bar over a long history. */
  onWindow?: (window: BlockWindow, logs: number) => void;
};

/** Every `SharesSet` log for one pool, in (block, logIndex) order, fetched in 10,000-block windows. */
export async function getSharesSetLogs(
  client: PublicClient,
  options: GetSharesSetLogsOptions,
): Promise<SharesSetLog[]> {
  const from = options.fromBlock ?? 0n;
  // `cacheTime: 0`: viem caches the block number for a polling interval by default, and a member added a second
  // ago would then fall outside the range and vanish from the result.
  const to = options.toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
  let size = options.chunkSize ?? MAX_LOG_RANGE_BLOCKS;
  if (size > MAX_LOG_RANGE_BLOCKS) size = MAX_LOG_RANGE_BLOCKS;
  const out: SharesSetLog[] = [];
  let cursor = from;
  while (cursor <= to) {
    const end = cursor + size - 1n < to ? cursor + size - 1n : to;
    let logs: Awaited<ReturnType<PublicClient['getLogs']>>;
    try {
      logs = await client.getLogs({
        address: options.address,
        event: sharesSetEvent,
        args: { poolId: options.poolId },
        fromBlock: cursor,
        toBlock: end,
      });
    } catch (error) {
      if (size > 1n && isRangeTooLarge(error)) {
        size = size / 2n > 0n ? size / 2n : 1n;
        continue;
      }
      throw error;
    }
    for (const log of logs) {
      const args = (log as unknown as { args: Record<string, unknown> }).args;
      out.push({
        poolId: args.poolId as bigint,
        member: args.member as Address,
        oldShares: args.oldShares as bigint,
        newShares: args.newShares as bigint,
        totalShares: args.totalShares as bigint,
        blockNumber: log.blockNumber ?? 0n,
        logIndex: log.logIndex ?? 0,
        transactionHash: log.transactionHash ?? '0x',
      });
    }
    options.onWindow?.({ fromBlock: cursor, toBlock: end }, logs.length);
    cursor = end + 1n;
  }
  out.sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
  return out;
}

/** Distinct member addresses in first-seen order. The log stream is the only source of candidates. */
export function candidatesFromLogs(logs: readonly SharesSetLog[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const log of logs) {
    const key = log.member.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(log.member);
  }
  return out;
}

export type PoolMember = MemberState & {
  address: Address;
  /** True when shares are 0 but the member still has funds to pull out. */
  formerMember: boolean;
};

export type GetPoolMembersOptions = GetSharesSetLogsOptions & {
  /** Keep addresses whose shares AND pending are both zero. Default false. */
  includeSettled?: boolean;
  /**
   * Multicall3 address. Arc mainnet and testnet carry the canonical one, which viem uses by default; pass this
   * only for a chain where it sits elsewhere. When no Multicall3 is reachable the reads fall back to one
   * `getMember` call per candidate, which is slower but always correct.
   */
  multicallAddress?: Address;
};

/**
 * One `getMember` per candidate, batched through Multicall3 when the chain has one. A chain without Multicall3
 * (a bare anvil, for instance) falls back to sequential reads rather than failing the whole discovery.
 */
async function readMemberStates(
  client: PublicClient,
  options: GetPoolMembersOptions,
  candidates: readonly Address[],
): Promise<unknown[]> {
  const contracts = candidates.map((member) => ({
    address: options.address,
    abi: dripPoolAbi,
    functionName: 'getMember' as const,
    args: [options.poolId, member] as const,
  }));
  try {
    return (await client.multicall({
      allowFailure: false,
      contracts,
      ...(options.multicallAddress ? { multicallAddress: options.multicallAddress } : {}),
    })) as unknown[];
  } catch (error) {
    if (!isMulticallUnavailable(error)) throw error;
    const out: unknown[] = [];
    for (const contract of contracts) out.push(await client.readContract(contract));
    return out;
  }
}

/** True when the chain simply has no Multicall3 deployed (or none configured), not when the reads themselves failed. */
export function isMulticallUnavailable(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? '';
  const text = `${(error as { message?: string })?.message ?? ''}`.toLowerCase();
  return (
    name === 'ChainDoesNotSupportContract' ||
    text.includes('does not support contract') ||
    text.includes('multicall3')
  );
}

/**
 * The pool's members right now: every address that ever had shares, filtered down to those that still have
 * shares or still have money waiting. One `getMember` multicall confirms the state, because the logs alone
 * cannot tell whether a zero-share address has already withdrawn.
 */
export async function getPoolMembers(
  client: PublicClient,
  options: GetPoolMembersOptions,
): Promise<PoolMember[]> {
  const logs = await getSharesSetLogs(client, options);
  const candidates = candidatesFromLogs(logs);
  if (candidates.length === 0) return [];
  const states = await readMemberStates(client, options, candidates);
  const out: PoolMember[] = [];
  for (const [i, raw] of states.entries()) {
    const state = parseWith(memberStateSchema, 'member', raw);
    const address = candidates[i]!;
    if (!options.includeSettled && state.shares === 0n && state.pending === 0n) continue;
    out.push({ ...state, address, formerMember: state.shares === 0n });
  }
  out.sort((a, b) =>
    a.shares === b.shares ? a.address.localeCompare(b.address) : a.shares > b.shares ? -1 : 1,
  );
  return out;
}

/** A member row as the payroll table shows it: state plus what they can withdraw at `now`. */
export type MemberRow = PoolMember & { claimable: bigint; shareFraction: number };

/**
 * Adds the per-member claimable to each row using the offchain mirror, so a UI can tick every second without
 * touching the RPC. `pool` must be the state read in the same breath as the members.
 */
export function toMemberRows(
  pool: AccrualPool,
  members: readonly PoolMember[],
  now: bigint | number,
): MemberRow[] {
  return members.map((member) => ({
    ...member,
    claimable: claimable(pool, member, now),
    shareFraction: pool.totalShares === 0n ? 0 : Number(member.shares) / Number(pool.totalShares),
  }));
}
