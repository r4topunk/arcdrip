// The pure half of member discovery: block-range chunking, the "range too large" retry trigger, candidate
// extraction and the offchain member rows. The RPC half is covered on anvil in `actions.anvil.test.ts`.
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { MAX_LOG_RANGE_BLOCKS } from '../src/constants.js';
import {
  candidatesFromLogs,
  isMulticallUnavailable,
  isRangeTooLarge,
  type PoolMember,
  type SharesSetLog,
  sharesSetEvent,
  splitBlockRange,
  toMemberRows,
} from '../src/members.js';
import type { AccrualPool } from '../src/schemas.js';

const A = '0x1111111111111111111111111111111111111111' as Address;
const B = '0x2222222222222222222222222222222222222222' as Address;

const log = (member: Address, newShares: bigint, blockNumber: bigint, logIndex = 0): SharesSetLog => ({
  poolId: 1n,
  member,
  oldShares: 0n,
  newShares,
  totalShares: newShares,
  blockNumber,
  logIndex,
  transactionHash: '0xabc',
});

describe('splitBlockRange', () => {
  it('defaults to the 10,000-block cap of Arc public RPCs', () => {
    expect(MAX_LOG_RANGE_BLOCKS).toBe(10_000n);
    const windows = splitBlockRange(0n, 25_000n);
    expect(windows).toEqual([
      { fromBlock: 0n, toBlock: 9_999n },
      { fromBlock: 10_000n, toBlock: 19_999n },
      { fromBlock: 20_000n, toBlock: 25_000n },
    ]);
  });

  it('produces inclusive, contiguous, non-overlapping windows', () => {
    const windows = splitBlockRange(7n, 37n, 10n);
    expect(windows).toEqual([
      { fromBlock: 7n, toBlock: 16n },
      { fromBlock: 17n, toBlock: 26n },
      { fromBlock: 27n, toBlock: 36n },
      { fromBlock: 37n, toBlock: 37n },
    ]);
    const covered = windows.reduce((sum, w) => sum + (w.toBlock - w.fromBlock + 1n), 0n);
    expect(covered).toBe(31n);
  });

  it('returns one window when the range fits, and none when it is empty', () => {
    expect(splitBlockRange(5n, 5n)).toEqual([{ fromBlock: 5n, toBlock: 5n }]);
    expect(splitBlockRange(10n, 9n)).toEqual([]);
  });

  it('rejects a non-positive window size and a negative start', () => {
    expect(() => splitBlockRange(0n, 10n, 0n)).toThrow(RangeError);
    expect(() => splitBlockRange(-1n, 10n)).toThrow(RangeError);
  });

  it('never exceeds the requested size, over a long history', () => {
    const windows = splitBlockRange(1n, 1_000_000n);
    expect(windows).toHaveLength(100);
    for (const w of windows) expect(w.toBlock - w.fromBlock + 1n).toBeLessThanOrEqual(10_000n);
    expect(windows.at(-1)?.toBlock).toBe(1_000_000n);
  });
});

describe('isRangeTooLarge', () => {
  it('matches the phrasings public nodes use', () => {
    expect(isRangeTooLarge({ message: 'query returned more than 10000 results' })).toBe(false);
    expect(isRangeTooLarge({ message: 'block range too large' })).toBe(true);
    expect(isRangeTooLarge({ details: 'exceed maximum block range: 10000' })).toBe(true);
    expect(isRangeTooLarge({ shortMessage: 'limit exceeded' })).toBe(true);
    expect(isRangeTooLarge({ message: 'error -32012: too many logs' })).toBe(true);
  });

  it('does not match unrelated failures, which must propagate', () => {
    expect(isRangeTooLarge(new Error('socket hang up'))).toBe(false);
    expect(isRangeTooLarge(undefined)).toBe(false);
  });
});

describe('candidatesFromLogs', () => {
  it('keeps first-seen order and de-duplicates case-insensitively', () => {
    const logs = [log(A, 1n, 1n), log(B, 2n, 2n), log(A, 0n, 3n)];
    expect(candidatesFromLogs(logs)).toEqual([A, B]);
  });

  it('keeps an address whose last event set shares to zero (they may still hold funds)', () => {
    expect(candidatesFromLogs([log(A, 0n, 9n)])).toEqual([A]);
  });

  it('is empty for an empty log stream', () => {
    expect(candidatesFromLogs([])).toEqual([]);
  });
});

describe('the SharesSet event', () => {
  it('is found in the generated ABI with its indexed poolId', () => {
    expect(sharesSetEvent.name).toBe('SharesSet');
    expect(sharesSetEvent.inputs[0]).toMatchObject({ name: 'poolId', indexed: true });
    expect(sharesSetEvent.inputs[1]).toMatchObject({ name: 'member', indexed: true });
  });
});

describe('toMemberRows', () => {
  const pool: AccrualPool = {
    startTime: 0n,
    lastAccrual: 1_000n,
    cancelled: false,
    ratePerSecond: 4_000_000_000_000n, // 4 USDC-units/s in wad
    totalShares: 4n,
    balance: 1_000_000n,
    owed: 0n,
    accIndex: 0n,
  };
  const members: PoolMember[] = [
    { address: A, shares: 3n, payout: A, index: 0n, pending: 0n, formerMember: false },
    { address: B, shares: 1n, payout: B, index: 0n, pending: 0n, formerMember: false },
  ];

  it('splits the stream by share fraction', () => {
    const rows = toMemberRows(pool, members, 1_100n);
    expect(rows[0]!.shareFraction).toBeCloseTo(0.75);
    expect(rows[1]!.shareFraction).toBeCloseTo(0.25);
    expect(rows[0]!.claimable).toBe(rows[1]!.claimable * 3n);
    expect(rows[0]!.claimable + rows[1]!.claimable).toBeLessThanOrEqual(400n);
  });

  it('reports a zero fraction when the pool has no shares at all', () => {
    const rows = toMemberRows({ ...pool, totalShares: 0n }, members, 1_100n);
    expect(rows.every((row) => row.shareFraction === 0)).toBe(true);
    expect(rows.every((row) => row.claimable === 0n)).toBe(true);
  });
});

describe('isMulticallUnavailable', () => {
  it('recognises a chain without Multicall3, so discovery can fall back to plain reads', () => {
    expect(isMulticallUnavailable({ name: 'ChainDoesNotSupportContract' })).toBe(true);
    expect(isMulticallUnavailable({ message: 'Chain "Anvil" does not support contract "multicall3"' })).toBe(
      true,
    );
  });

  it('lets a real read failure propagate instead of silently retrying', () => {
    expect(isMulticallUnavailable(new Error('execution reverted'))).toBe(false);
    expect(isMulticallUnavailable(undefined)).toBe(false);
  });
});
