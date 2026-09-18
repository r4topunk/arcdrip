import {
  type AccrualPool,
  claimable,
  MAX_BATCH,
  MAX_SHARES,
  MAX_TOTAL_SHARES,
  type MemberRow,
  poolStatus,
  runwaySeconds,
  toMemberRows,
  toRatePerSecond,
  UNBOUNDED_RUNWAY,
} from '@sharedarc/sdk';
import { describe, expect, it } from 'vitest';
import { runwayView } from '@/lib/format';
import { buildRate, buildShares, isOwner, isPendingOwner, ownRow, planBatch, STATUS_TONE } from '@/lib/pool';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;

/** A pool streaming 3 USDC/day since t=1000, funded with `balance` USDC units. */
function pool(over: Partial<AccrualPool> = {}): AccrualPool {
  return {
    startTime: 1_000n,
    lastAccrual: 1_000n,
    cancelled: false,
    ratePerSecond: toRatePerSecond({ amount: '3', per: 'day' }),
    totalShares: 4n,
    balance: 1_000_000n,
    owed: 0n,
    accIndex: 0n,
    ...over,
  };
}

describe('status derivation', () => {
  it('is streaming while funded and scheduled before the start time', () => {
    expect(poolStatus(pool(), 2_000n)).toBe('streaming');
    expect(poolStatus(pool({ startTime: 10_000n }), 2_000n)).toBe('scheduled');
  });

  it('is paused at rate zero or with no shares, and cancelled beats everything', () => {
    expect(poolStatus(pool({ ratePerSecond: 0n }), 2_000n)).toBe('paused');
    expect(poolStatus(pool({ totalShares: 0n }), 2_000n)).toBe('paused');
    expect(poolStatus(pool({ cancelled: true, ratePerSecond: 0n }), 2_000n)).toBe('cancelled');
  });

  it('freezes exactly when the pool runs dry, and streams again after a deposit', () => {
    // 1 USDC at 3 USDC/day funds 8 hours.
    const dry = 1_000n + 8n * 3_600n;
    expect(poolStatus(pool(), dry - 10n)).toBe('streaming');
    expect(poolStatus(pool(), dry + 10n)).toBe('frozen');
    expect(poolStatus(pool({ balance: 6_000_000n }), dry + 10n)).toBe('streaming');
  });

  it('gives every status a tone', () => {
    for (const status of ['streaming', 'scheduled', 'paused', 'frozen', 'cancelled'] as const) {
      expect(STATUS_TONE[status]).toBeTruthy();
    }
  });
});

describe('runway', () => {
  it('counts down to the second the pool dries out, then reads frozen', () => {
    const p = pool();
    expect(runwaySeconds(p, 1_000n)).toBe(8n * 3_600n);
    expect(runwayView(runwaySeconds(p, 1_000n))).toEqual({
      kind: 'duration',
      text: '8 h 00 m',
      danger: true,
    });
    expect(runwayView(runwaySeconds(p, 1_000n + 8n * 3_600n))).toEqual({ kind: 'frozen' });
  });

  it('is unbounded while nothing is being consumed', () => {
    expect(runwaySeconds(pool({ ratePerSecond: 0n }), 2_000n)).toBe(UNBOUNDED_RUNWAY);
    expect(runwayView(runwaySeconds(pool({ totalShares: 0n }), 2_000n))).toEqual({ kind: 'unbounded' });
  });
});

describe('rate builder', () => {
  it('converts an amount per period into wad per second', () => {
    expect(buildRate('3', 'day')).toEqual({
      ok: true,
      ratePerSecond: toRatePerSecond({ amount: '3', per: 'day' }),
    });
    expect(buildRate('1000', 'month').ok).toBe(true);
  });

  it('refuses an amount that would stream nothing, and too many decimals', () => {
    expect(buildRate('0', 'day')).toEqual({ ok: false, error: 'amount' });
    expect(buildRate('abc', 'day')).toEqual({ ok: false, error: 'amount' });
    expect(buildRate('1.2345678', 'day')).toEqual({ ok: false, error: 'decimals' });
  });
});

describe('shares builder', () => {
  it('accepts zero (removal) and whole numbers', () => {
    expect(buildShares('0')).toEqual({ ok: true, shares: 0n });
    expect(buildShares('7')).toEqual({ ok: true, shares: 7n });
    expect(buildShares('1.5')).toEqual({ ok: false, error: 'format' });
  });

  it('checks the per-member cap and the pool-wide cap on the resulting total', () => {
    expect(buildShares((MAX_SHARES + 1n).toString())).toEqual({ ok: false, error: 'tooLarge' });
    expect(buildShares('2', { current: 1n, totalShares: MAX_TOTAL_SHARES })).toEqual({
      ok: false,
      error: 'poolTooLarge',
    });
    // Replacing the member's own shares keeps the total inside the cap.
    expect(buildShares('1', { current: 1n, totalShares: MAX_TOTAL_SHARES })).toEqual({
      ok: true,
      shares: 1n,
    });
  });
});

describe('batch planning', () => {
  const row = (address: string, claimableUnits: bigint): MemberRow =>
    ({
      address,
      shares: 1n,
      index: 0n,
      pending: 0n,
      payout: ZERO,
      formerMember: false,
      claimable: claimableUnits,
      shareFraction: 0.5,
    }) as MemberRow;

  it('skips members with nothing to withdraw and sums what the batch would move', () => {
    const plan = planBatch([row(A, 5n), row(B, 0n)]);
    expect(plan.payable).toEqual([A]);
    expect(plan.total).toBe(5n);
    expect(plan.chunks).toEqual([[A]]);
  });

  it('chunks at the contract MAX_BATCH of 100', () => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      row(`0x${(i + 1).toString(16).padStart(40, '0')}`, 1n),
    );
    const plan = planBatch(rows);
    expect(MAX_BATCH).toBe(100);
    expect(plan.chunks).toHaveLength(3);
    expect(plan.chunks.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(plan.chunks.flat()).toEqual(plan.payable);
  });

  it('plans nothing when nobody has a whole unit yet', () => {
    expect(planBatch([row(A, 0n)])).toMatchObject({ payable: [], chunks: [], total: 0n });
  });
});

describe('panel gating', () => {
  const state = { owner: A, pendingOwner: ZERO } as const;

  it('recognises the owner regardless of address casing', () => {
    expect(isOwner(state, A.toUpperCase() as typeof A)).toBe(true);
    expect(isOwner(state, B)).toBe(false);
    expect(isOwner(undefined, A)).toBe(false);
    expect(isOwner(state, undefined)).toBe(false);
  });

  it('never treats the zero pending owner as a pending owner', () => {
    expect(isPendingOwner(state, ZERO)).toBe(false);
    expect(isPendingOwner({ pendingOwner: B }, B)).toBe(true);
    expect(isPendingOwner({ pendingOwner: B }, A)).toBe(false);
  });

  it('finds the connected wallet row for the member panel', () => {
    const rows = toMemberRows(
      pool(),
      [
        { address: A, shares: 1n, index: 0n, pending: 0n, payout: ZERO, formerMember: false },
        { address: B, shares: 3n, index: 0n, pending: 0n, payout: ZERO, formerMember: false },
      ],
      2_000n,
    );
    expect(ownRow(rows, B)?.address).toBe(B);
    expect(ownRow(rows, undefined)).toBeUndefined();
    expect(ownRow(rows, '0x3333333333333333333333333333333333333333')).toBeUndefined();
  });
});

describe('member rows mirror math.ts', () => {
  it('gives each member exactly what claimable() says, share-weighted', () => {
    const p = pool();
    const members = [
      { address: A, shares: 1n, index: 0n, pending: 0n, payout: ZERO, formerMember: false },
      { address: B, shares: 3n, index: 0n, pending: 0n, payout: ZERO, formerMember: false },
    ];
    const now = 1_000n + 3_600n;
    const rows = toMemberRows(p, members, now);
    expect(rows[0]?.claimable).toBe(claimable(p, members[0]!, now));
    expect(rows[1]?.claimable).toBe(claimable(p, members[1]!, now));
    expect(rows[1]!.claimable).toBeGreaterThan(rows[0]!.claimable);
    expect(rows[0]?.shareFraction).toBeCloseTo(0.25);
  });
});
