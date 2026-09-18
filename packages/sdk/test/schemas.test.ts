import { describe, expect, it } from 'vitest';
import { MAX_RATE, MAX_SHARES } from '../src/constants.js';
import { InvalidInputError } from '../src/errors.js';
import {
  parseAccrualMember,
  parseAccrualPool,
  parseMemberState,
  parsePoolEvent,
  parsePoolState,
} from '../src/schemas.js';

const rawPool = {
  startTime: '0',
  lastAccrual: '1700000000',
  cancelled: false,
  ratePerSecond: '385802469135802',
  totalShares: '4',
  balance: '1000000',
  owed: '0',
  accIndex: '0',
};

describe('pool schemas', () => {
  it('parses decimal strings into bigints', () => {
    const pool = parseAccrualPool(rawPool);
    expect(pool.lastAccrual).toBe(1_700_000_000n);
    expect(pool.ratePerSecond).toBe(385_802_469_135_802n);
    expect(pool.balance).toBe(1_000_000n);
  });

  it('accepts bigints and safe integer numbers alike', () => {
    const pool = parseAccrualPool({ ...rawPool, totalShares: 4, balance: 1_000_000n });
    expect(pool.totalShares).toBe(4n);
    expect(pool.balance).toBe(1_000_000n);
  });

  it('defaults cancelled to false', () => {
    const { cancelled, ...withoutFlag } = rawPool;
    expect(cancelled).toBe(false);
    expect(parseAccrualPool(withoutFlag).cancelled).toBe(false);
  });

  it('rejects floats, negatives and junk', () => {
    expect(() => parseAccrualPool({ ...rawPool, balance: 1.5 })).toThrow(InvalidInputError);
    expect(() => parseAccrualPool({ ...rawPool, balance: '-1' })).toThrow(InvalidInputError);
    expect(() => parseAccrualPool({ ...rawPool, balance: '1.0' })).toThrow(InvalidInputError);
    expect(() => parseAccrualPool({ ...rawPool, owed: 'lots' })).toThrow(InvalidInputError);
  });

  it('rejects a rate above MAX_RATE and shares above MAX_SHARES', () => {
    expect(() => parseAccrualPool({ ...rawPool, ratePerSecond: (MAX_RATE + 1n).toString() })).toThrow(
      InvalidInputError,
    );
    expect(() => parseAccrualMember({ shares: MAX_SHARES + 1n, index: 0n, pending: 0n })).toThrow(
      InvalidInputError,
    );
  });

  it('reports every problem as a readable issue line', () => {
    try {
      parseAccrualPool({ ...rawPool, balance: 'x', owed: 'y' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidInputError);
      const issues = (error as InvalidInputError).issues;
      expect(issues.length).toBeGreaterThanOrEqual(2);
      expect(issues.join(' ')).toMatch(/balance/);
    }
  });

  it('checksums addresses on a full pool state', () => {
    const state = parsePoolState({
      ...rawPool,
      owner: '0x1111111111111111111111111111111111111111',
      pendingOwner: '0x0000000000000000000000000000000000000000',
    });
    expect(state.owner).toBe('0x1111111111111111111111111111111111111111');
    expect(state.pendingOwner).toBe('0x0000000000000000000000000000000000000000');
  });

  it('rejects a non-address owner', () => {
    expect(() => parsePoolState({ ...rawPool, owner: '0xdead', pendingOwner: '0xdead' })).toThrow(
      InvalidInputError,
    );
  });
});

describe('member schemas', () => {
  it('parses an accrual member', () => {
    const m = parseAccrualMember({ shares: '3', index: '0', pending: '30000' });
    expect(m).toEqual({ shares: 3n, index: 0n, pending: 30_000n });
  });

  it('parses a full member state with a payout address', () => {
    const m = parseMemberState({
      shares: 1,
      index: 0,
      pending: 0,
      payout: '0x2222222222222222222222222222222222222222',
    });
    expect(m.payout).toBe('0x2222222222222222222222222222222222222222');
  });
});

describe('pool event union', () => {
  it('parses each event kind onto bigint fields', () => {
    const created = parsePoolEvent({
      type: 'PoolCreated',
      poolId: '1',
      owner: '0x1111111111111111111111111111111111111111',
      ratePerSecond: '1000',
      startTime: '0',
      name: 'r4to collective',
    });
    expect(created.type).toBe('PoolCreated');
    expect(created.poolId).toBe(1n);

    const shares = parsePoolEvent({
      type: 'SharesSet',
      poolId: 1,
      member: '0x2222222222222222222222222222222222222222',
      oldShares: 0,
      newShares: 2,
      totalShares: 4,
    });
    expect(shares).toMatchObject({ newShares: 2n, totalShares: 4n });

    const skipped = parsePoolEvent({
      type: 'WithdrawSkipped',
      poolId: 1,
      member: '0x2222222222222222222222222222222222222222',
      amount: '5',
    });
    expect(skipped).toMatchObject({ amount: 5n });
  });

  it('rejects an unknown event type and pool id 0', () => {
    expect(() => parsePoolEvent({ type: 'Nope', poolId: 1 })).toThrow(InvalidInputError);
    expect(() =>
      parsePoolEvent({
        type: 'Deposited',
        poolId: 0,
        from: '0x1111111111111111111111111111111111111111',
        amount: 1,
      }),
    ).toThrow(InvalidInputError);
  });
});
