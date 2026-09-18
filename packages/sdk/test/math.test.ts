// Every expected number here is hand-computed from PRD 4.2/4.3 and written as a literal. Nothing in this file
// re-derives a value with the code under test.
import { describe, expect, it } from 'vitest';
import { INDEX_SCALE, MAX_UINT64, UNBOUNDED_RUNWAY, WAD_PER_UNIT } from '../src/constants.js';
import {
  accrue,
  accrueAndSettle,
  available,
  ceilDiv,
  claimable,
  claimableWad,
  fundedUntil,
  poolStatus,
  previewDeposit,
  previewWithdraw,
  runwaySeconds,
  settle,
  unstreamed,
} from '../src/math.js';
import type { AccrualMember, AccrualPool } from '../src/schemas.js';

const basePool: AccrualPool = {
  startTime: 0n,
  lastAccrual: 1_000n,
  cancelled: false,
  ratePerSecond: 1_000n,
  totalShares: 10n,
  balance: 1_000_000n, // 1 USDC = 1e18 wad
  owed: 0n,
  accIndex: 0n,
};

const pool = (overrides: Partial<AccrualPool> = {}): AccrualPool => ({ ...basePool, ...overrides });
const member = (overrides: Partial<AccrualMember> = {}): AccrualMember => ({
  shares: 0n,
  index: 0n,
  pending: 0n,
  ...overrides,
});

describe('ceilDiv', () => {
  it('rounds up and leaves exact multiples alone', () => {
    expect(ceilDiv(0n, WAD_PER_UNIT)).toBe(0n);
    expect(ceilDiv(1n, WAD_PER_UNIT)).toBe(1n);
    expect(ceilDiv(WAD_PER_UNIT, WAD_PER_UNIT)).toBe(1n);
    expect(ceilDiv(WAD_PER_UNIT + 1n, WAD_PER_UNIT)).toBe(2n);
    expect(ceilDiv(2_500_000_000_000n, WAD_PER_UNIT)).toBe(3n);
  });

  it('rejects a non-positive divisor', () => {
    expect(() => ceilDiv(1n, 0n)).toThrow(RangeError);
  });
});

describe('accrue', () => {
  it('streams rate * dt and moves the index by streamed * 1e18 / totalShares', () => {
    // dt = 100, streamed = 1000 * 100 = 100_000 wad, accIndex += 100_000 * 1e18 / 10 = 1e22
    const p = accrue(pool(), 1_100n);
    expect(p.owed).toBe(100_000n);
    expect(p.accIndex).toBe(10_000_000_000_000_000_000_000n);
    expect(p.lastAccrual).toBe(1_100n);
    expect(p.balance).toBe(1_000_000n); // balance only moves on deposit/withdraw
  });

  it('does not mutate its inputs', () => {
    const p = pool();
    const snapshot = { ...p };
    accrue(p, 1_100n);
    expect(p).toEqual(snapshot);
  });

  it('accepts a number timestamp and rejects a non-integer or negative one', () => {
    expect(accrue(pool(), 1_100).owed).toBe(100_000n);
    expect(() => accrue(pool(), 1_100.5)).toThrow(RangeError);
    expect(() => accrue(pool(), -1n)).toThrow(RangeError);
    expect(() => accrue(pool(), MAX_UINT64 + 1n)).toThrow(RangeError);
  });

  it('streams nothing when the rate is zero (pause) but still advances lastAccrual', () => {
    const p = accrue(pool({ ratePerSecond: 0n }), 9_999n);
    expect(p.owed).toBe(0n);
    expect(p.accIndex).toBe(0n);
    expect(p.lastAccrual).toBe(9_999n);
  });

  it('streams nothing and consumes nothing while totalShares is zero', () => {
    const p = accrue(pool({ totalShares: 0n }), 1_100n);
    expect(p.owed).toBe(0n);
    expect(p.accIndex).toBe(0n);
    expect(p.balance).toBe(1_000_000n);
    expect(available(p)).toBe(1_000_000_000_000_000_000n);
  });

  it('holds accrual back until startTime and then streams only from startTime', () => {
    const scheduled = pool({ startTime: 2_000n, ratePerSecond: WAD_PER_UNIT, totalShares: 1n });
    const early = accrue(scheduled, 1_500n);
    expect(early.owed).toBe(0n);
    expect(early.lastAccrual).toBe(1_500n);

    // from = max(lastAccrual 1500, startTime 2000) = 2000; dt = 500; streamed = 500 * 1e12
    const late = accrue(early, 2_500n);
    expect(late.owed).toBe(500_000_000_000_000n);
  });

  it('caps dt at available / rate: this is the freeze', () => {
    // balance 5 units = 5e12 wad, rate 1e12 wad/s -> only 5 seconds are funded out of 100
    const p = accrue(pool({ balance: 5n, ratePerSecond: WAD_PER_UNIT, totalShares: 1n }), 1_100n);
    expect(p.owed).toBe(5_000_000_000_000n);
    expect(available(p)).toBe(0n);
  });

  it('never back-pays frozen time after a deposit', () => {
    const frozen = accrue(pool({ balance: 1n, ratePerSecond: WAD_PER_UNIT, totalShares: 1n }), 1_100n);
    expect(frozen.owed).toBe(1_000_000_000_000n); // 1 second funded, then frozen for 99

    const funded = previewDeposit(frozen, 3n, 1_200n); // 100 s later
    expect(funded.owed).toBe(1_000_000_000_000n); // the frozen 100 s are gone, not owed
    expect(funded.balance).toBe(4n);

    const resumed = accrue(funded, 1_205n); // 5 s of stream, 3 of them funded
    expect(resumed.owed).toBe(4_000_000_000_000n);
    expect(available(resumed)).toBe(0n);
  });

  it('rejects a deposit of zero', () => {
    expect(() => previewDeposit(pool(), 0n, 1_100n)).toThrow(RangeError);
  });

  it('is a no-op on accrual when now is not past `from`', () => {
    const p = accrue(pool(), 1_000n);
    expect(p.owed).toBe(0n);
    expect(p.accIndex).toBe(0n);
    expect(p.lastAccrual).toBe(1_000n);
  });
});

describe('settle', () => {
  it('credits shares * (accIndex - index) / 1e18 and snapshots the index', () => {
    const p = accrue(pool(), 1_100n); // accIndex = 1e22
    const m = settle(p, member({ shares: 3n }));
    expect(m.pending).toBe(30_000n); // 3 * 1e22 / 1e18
    expect(m.index).toBe(p.accIndex);
  });

  it('credits nothing to a zero-share member but still snapshots the index', () => {
    const p = accrue(pool(), 1_100n);
    const m = settle(p, member({ shares: 0n, pending: 2_500_000_000_000n }));
    expect(m.pending).toBe(2_500_000_000_000n);
    expect(m.index).toBe(p.accIndex);
  });

  it('is idempotent once the index is snapshotted', () => {
    const p = accrue(pool(), 1_100n);
    const once = settle(p, member({ shares: 3n }));
    expect(settle(p, once)).toEqual(once);
  });

  it('keeps what a member accrued before their shares went to zero', () => {
    const p = accrue(pool(), 1_100n);
    const left = settle(p, member({ shares: 0n, index: 0n, pending: 1_500_000_000_000n }));
    const later = accrue({ ...p, totalShares: 7n }, 99_999n);
    expect(claimableWad(later, left, 99_999n)).toBe(1_500_000_000_000n);
  });

  it('floors every member share, and the dust stays in owed forever', () => {
    // totalShares 3, streamed 100_000 wad -> accIndex = 1e23 / 3 = 33333333333333333333333
    const p = accrue(pool({ totalShares: 3n }), 1_100n);
    expect(p.accIndex).toBe(33_333_333_333_333_333_333_333n);
    expect(p.owed).toBe(100_000n);
    const each = settle(p, member({ shares: 1n })).pending;
    expect(each).toBe(33_333n); // floor of 33_333.333…
    expect(each * 3n).toBe(99_999n);
    expect(p.owed - each * 3n).toBe(1n); // 1 wad of dust, under the MAX_TOTAL_SHARES bound
  });
});

describe('claimable', () => {
  it('truncates sub-unit pending to zero USDC units', () => {
    const p = pool();
    const m = member({ shares: 3n });
    expect(claimableWad(p, m, 1_100n)).toBe(30_000n);
    expect(claimable(p, m, 1_100n)).toBe(0n); // 30_000 wad < 1 unit (1e12 wad)
  });

  it('pays whole units once enough has streamed', () => {
    const p = pool({ ratePerSecond: WAD_PER_UNIT, totalShares: 1n });
    const m = member({ shares: 1n });
    expect(claimable(p, m, 1_100n)).toBe(100n); // 100 s x 1 unit/s
    expect(claimableWad(p, m, 1_100n)).toBe(100_000_000_000_000n);
  });

  it('splits by weight: shares 1 / 1 / 2 over 100 seconds', () => {
    const p = pool({ ratePerSecond: 4n * WAD_PER_UNIT, totalShares: 4n });
    expect(claimable(p, member({ shares: 1n }), 1_100n)).toBe(100n);
    expect(claimable(p, member({ shares: 2n }), 1_100n)).toBe(200n);
  });

  it('stops growing once the pool is frozen', () => {
    const p = pool({ balance: 5n, ratePerSecond: WAD_PER_UNIT, totalShares: 1n });
    const m = member({ shares: 1n });
    expect(claimable(p, m, 1_005n)).toBe(5n);
    expect(claimable(p, m, 1_100n)).toBe(5n);
    expect(claimable(p, m, 999_999n)).toBe(5n);
  });

  it('keeps 1 USDC / month meaningful over a simulated year', () => {
    // rate = 1e6 units * 1e12 / 2_592_000 s = 385_802_469_135 wad/s
    const p = pool({
      lastAccrual: 0n,
      ratePerSecond: 385_802_469_135n,
      totalShares: 1n,
      balance: 12_166_667n,
    });
    const m = member({ shares: 1n });
    expect(claimableWad(p, m, 31_536_000n)).toBe(12_166_666_666_641_360_000n);
    expect(claimable(p, m, 31_536_000n)).toBe(12_166_666n); // 12.166666 USDC, 365/30 months
  });

  it('accrueAndSettle returns the pool and the member at the same instant', () => {
    const { pool: p, member: m } = accrueAndSettle(pool(), member({ shares: 3n }), 1_100n);
    expect(p.lastAccrual).toBe(1_100n);
    expect(m.index).toBe(p.accIndex);
    expect(m.pending).toBe(30_000n);
  });
});

describe('fundedUntil and runwaySeconds', () => {
  it('is now + available / rate on the simulated state', () => {
    // 1e18 wad available, 1000 wad/s -> 1e15 seconds of runway from lastAccrual
    expect(fundedUntil(pool(), 1_000n)).toBe(1_000n + 1_000_000_000_000_000n);
    expect(runwaySeconds(pool(), 1_000n)).toBe(1_000_000_000_000_000n);
  });

  it('counts from startTime while the pool is still scheduled', () => {
    const p = pool({ startTime: 2_000n, ratePerSecond: WAD_PER_UNIT, totalShares: 1n });
    expect(fundedUntil(p, 1_500n)).toBe(2_000n + 1_000_000n);
    expect(runwaySeconds(p, 1_500n)).toBe(2_000n + 1_000_000n - 1_500n);
  });

  it('is unbounded when nothing is being consumed', () => {
    expect(fundedUntil(pool({ ratePerSecond: 0n }), 1_100n)).toBe(MAX_UINT64);
    expect(fundedUntil(pool({ totalShares: 0n }), 1_100n)).toBe(MAX_UINT64);
    expect(runwaySeconds(pool({ ratePerSecond: 0n }), 1_100n)).toBe(UNBOUNDED_RUNWAY);
  });

  it('reaches now exactly when the pool freezes, and stays there', () => {
    const p = pool({ balance: 5n, ratePerSecond: WAD_PER_UNIT, totalShares: 1n });
    expect(fundedUntil(p, 1_000n)).toBe(1_005n);
    expect(runwaySeconds(p, 1_005n)).toBe(0n);
    expect(fundedUntil(p, 1_100n)).toBe(1_100n);
    expect(runwaySeconds(p, 1_100n)).toBe(0n);
  });

  it('saturates at uint64 max when the pool is funded past any representable timestamp', () => {
    // 1e15 shares at 1 wad/s with 1e12 units of balance: the raw end is ~1e24, far outside uint64.
    // The contract's view returns uint64, so the mirror has to clamp to the same sentinel (vector 36).
    const p = pool({
      lastAccrual: 1_001_863_844_996n,
      ratePerSecond: 1n,
      totalShares: 1_000_000_000_000_000n,
      balance: 1_000_000_000_000n,
      owed: 0n,
    });
    expect(fundedUntil(p, 1_001_863_844_999n)).toBe(MAX_UINT64);
    expect(runwaySeconds(p, 1_001_863_844_999n)).toBe(UNBOUNDED_RUNWAY);
  });

  it('floors the partially funded second', () => {
    // 5.5 units of balance at 1 unit/s -> 5 whole funded seconds
    const p = pool({ balance: 5n, ratePerSecond: 500_000_000_000n, totalShares: 1n });
    expect(fundedUntil(p, 1_000n)).toBe(1_010n);
  });
});

describe('unstreamed', () => {
  it('reserves owed rounded up to whole units, so the owner never takes earned funds', () => {
    const p = pool({ ratePerSecond: 0n, balance: 10n, owed: 2_500_000_000_000n });
    expect(unstreamed(p, 5_000n)).toBe(7n); // 10 - ceil(2.5)
  });

  it('is zero when everything is owed', () => {
    const p = pool({ ratePerSecond: 0n, balance: 2n, owed: 2_000_000_000_000n });
    expect(unstreamed(p, 5_000n)).toBe(0n);
  });

  it('shrinks as the stream advances', () => {
    const p = pool({ balance: 1_000_000n, ratePerSecond: WAD_PER_UNIT, totalShares: 1n });
    expect(unstreamed(p, 1_000n)).toBe(1_000_000n);
    expect(unstreamed(p, 1_100n)).toBe(999_900n);
  });
});

describe('previewWithdraw', () => {
  it('pays whole units, keeps the remainder in pending and owed, and debits the balance', () => {
    const p = pool({ ratePerSecond: 0n, balance: 10n, owed: 2_500_000_000_000n });
    const m = member({ shares: 1n, pending: 2_500_000_000_000n, index: p.accIndex });
    const out = previewWithdraw(p, m, 5_000n);
    expect(out.units).toBe(2n);
    expect(out.member.pending).toBe(500_000_000_000n);
    expect(out.pool.owed).toBe(500_000_000_000n);
    expect(out.pool.balance).toBe(8n);
  });

  it('returns 0 units when there is nothing whole to withdraw (NothingToWithdraw)', () => {
    const p = pool({ ratePerSecond: 0n, balance: 10n, owed: 500_000_000_000n });
    const m = member({ shares: 1n, pending: 500_000_000_000n, index: p.accIndex });
    const out = previewWithdraw(p, m, 5_000n);
    expect(out.units).toBe(0n);
    expect(out.pool.balance).toBe(10n);
    expect(out.member.pending).toBe(500_000_000_000n);
  });

  it('accrues before paying, so a withdraw mid-stream includes the current second', () => {
    const p = pool({ ratePerSecond: WAD_PER_UNIT, totalShares: 1n });
    const out = previewWithdraw(p, member({ shares: 1n }), 1_100n);
    expect(out.units).toBe(100n);
    expect(out.pool.balance).toBe(999_900n);
    expect(out.pool.owed).toBe(0n);
    expect(out.member.pending).toBe(0n);
  });

  it('leaves a member with zero shares able to withdraw what they earned', () => {
    const p = pool({ ratePerSecond: 0n, balance: 10n, owed: 3_000_000_000_000n });
    const out = previewWithdraw(p, member({ shares: 0n, pending: 3_000_000_000_000n }), 9_999n);
    expect(out.units).toBe(3n);
    expect(out.pool.owed).toBe(0n);
  });
});

describe('poolStatus', () => {
  it('reports the state the UI shows', () => {
    expect(poolStatus(pool({ cancelled: true }), 1_100n)).toBe('cancelled');
    expect(poolStatus(pool({ ratePerSecond: 0n }), 1_100n)).toBe('paused');
    expect(poolStatus(pool({ startTime: 5_000n }), 1_100n)).toBe('scheduled');
    expect(poolStatus(pool({ totalShares: 0n }), 1_100n)).toBe('paused');
    expect(poolStatus(pool(), 1_100n)).toBe('streaming');
    expect(poolStatus(pool({ balance: 5n, ratePerSecond: WAD_PER_UNIT, totalShares: 1n }), 1_100n)).toBe(
      'frozen',
    );
  });
});

describe('scales', () => {
  it('matches the contract constants', () => {
    expect(WAD_PER_UNIT).toBe(10n ** 12n);
    expect(INDEX_SCALE).toBe(10n ** 18n);
  });
});
