import { describe, expect, it } from 'vitest';
import { MAX_RATE, WAD_PER_UNIT } from '../src/constants.js';
import {
  formatUsdc,
  formatWad,
  fromRatePerSecond,
  memberRate,
  memberShareFraction,
  PERIOD_SECONDS,
  parseUsdc,
  periodToSeconds,
  toRatePerSecond,
  unitsPerPeriod,
} from '../src/rate.js';
import type { AccrualMember, AccrualPool } from '../src/schemas.js';

describe('periods', () => {
  it('uses a 30-day month and a 365-day year, by documented convention', () => {
    expect(PERIOD_SECONDS.month).toBe(2_592_000n);
    expect(PERIOD_SECONDS.month).toBe(30n * PERIOD_SECONDS.day);
    expect(PERIOD_SECONDS.year).toBe(31_536_000n);
    expect(PERIOD_SECONDS.week).toBe(604_800n);
  });

  it('accepts a raw number of seconds', () => {
    expect(periodToSeconds(90n)).toBe(90n);
    expect(periodToSeconds(90)).toBe(90n);
  });

  it('rejects an unknown name, a zero period and a fractional one', () => {
    expect(() => periodToSeconds('fortnight' as 'week')).toThrow(RangeError);
    expect(() => periodToSeconds(0)).toThrow(RangeError);
    expect(() => periodToSeconds(1.5)).toThrow(RangeError);
  });
});

describe('parseUsdc / formatUsdc', () => {
  it('parses decimal strings to 6-decimal units', () => {
    expect(parseUsdc('1')).toBe(1_000_000n);
    expect(parseUsdc('12.5')).toBe(12_500_000n);
    expect(parseUsdc('0.000001')).toBe(1n);
    expect(parseUsdc('0')).toBe(0n);
    expect(parseUsdc(3)).toBe(3_000_000n);
  });

  it('refuses to silently drop precision', () => {
    expect(() => parseUsdc('0.0000001')).toThrow(RangeError);
    expect(() => parseUsdc('-1')).toThrow(RangeError);
    expect(() => parseUsdc('1e6')).toThrow(RangeError);
    expect(() => parseUsdc('abc')).toThrow(RangeError);
  });

  it('formats units back to a trimmed decimal string', () => {
    expect(formatUsdc(1_000_000n)).toBe('1');
    expect(formatUsdc(1_234_567n)).toBe('1.234567');
    expect(formatUsdc(1n)).toBe('0.000001');
    expect(formatUsdc(0n)).toBe('0');
  });

  it('round-trips any 6-decimal amount', () => {
    for (const amount of ['0', '1', '0.000001', '12.5', '999999.999999']) {
      expect(formatUsdc(parseUsdc(amount))).toBe(amount);
    }
  });

  it('formats wad with 18 decimals', () => {
    expect(formatWad(10n ** 18n)).toBe('1');
    expect(formatWad(WAD_PER_UNIT)).toBe('0.000001');
  });
});

describe('toRatePerSecond', () => {
  it('converts USDC per period to wad per second, floored', () => {
    // 1000 USDC / month = 1000e6 units * 1e12 / 2_592_000 s
    expect(toRatePerSecond({ amount: '1000', per: 'month' })).toBe(385_802_469_135_802n);
    // 1 USDC / month must not round to zero: that is why amounts are wad (D9)
    expect(toRatePerSecond({ amount: '1', per: 'month' })).toBe(385_802_469_135n);
    expect(toRatePerSecond({ amount: '1', per: 'day' })).toBe(11_574_074_074_074n);
    expect(toRatePerSecond({ amount: '1', per: 'week' })).toBe(1_653_439_153_439n);
    expect(toRatePerSecond({ amount: '1', per: 'second' })).toBe(10n ** 18n); // 1e6 units x 1e12 wad
    expect(toRatePerSecond({ amount: '3', per: 'day' })).toBe(34_722_222_222_222n);
  });

  it('accepts a raw number of seconds as the period', () => {
    expect(toRatePerSecond({ amount: '1', per: 100 })).toBe(10_000_000_000_000_000n);
  });

  it('keeps even divisions exact', () => {
    expect(toRatePerSecond({ amount: '86400', per: 'day' })).toBe(10n ** 18n);
  });

  it('rejects a rate above MAX_RATE', () => {
    expect(() => toRatePerSecond({ amount: '1000000000000000000000', per: 'second' })).toThrow(/MAX_RATE/);
    expect(toRatePerSecond({ amount: '1000000000000', per: 'second' })).toBe(MAX_RATE);
  });
});

describe('fromRatePerSecond', () => {
  it('inverts an exact rate', () => {
    expect(fromRatePerSecond(10n ** 18n, 'day')).toBe('86400');
    expect(fromRatePerSecond(WAD_PER_UNIT, 'second')).toBe('0.000001');
    expect(fromRatePerSecond(0n, 'month')).toBe('0');
  });

  it('shows exactly what the floored rate really streams per period', () => {
    const rate = toRatePerSecond({ amount: '1000', per: 'month' });
    // 385_802_469_135_802 * 2_592_000 = 999_999_999_999_998_784_000 wad
    expect(fromRatePerSecond(rate, 'month')).toBe('999.999999999998784');
    expect(unitsPerPeriod(rate, 'month')).toBe(999_999_999n); // 999.999999 USDC actually transferable
  });

  it('round-trips through units for amounts that divide evenly', () => {
    for (const [amount, per] of [
      ['86400', 'day'],
      ['1', 'second'],
      ['604800', 'week'],
    ] as const) {
      expect(fromRatePerSecond(toRatePerSecond({ amount, per }), per)).toBe(amount);
    }
  });

  it('rejects a negative rate', () => {
    expect(() => fromRatePerSecond(-1n, 'day')).toThrow(RangeError);
    expect(() => unitsPerPeriod(-1n, 'day')).toThrow(RangeError);
  });
});

const pool = (overrides: Partial<AccrualPool> = {}): AccrualPool => ({
  startTime: 0n,
  lastAccrual: 0n,
  cancelled: false,
  ratePerSecond: 1_000n,
  totalShares: 10n,
  balance: 0n,
  owed: 0n,
  accIndex: 0n,
  ...overrides,
});
const member = (shares: bigint): AccrualMember => ({ shares, index: 0n, pending: 0n });

describe('memberRate', () => {
  it('is the member slice of the pool rate, floored', () => {
    expect(memberRate(pool(), member(3n))).toBe(300n);
    expect(memberRate(pool({ totalShares: 3n }), member(1n))).toBe(333n);
  });

  it('is zero without shares on either side', () => {
    expect(memberRate(pool({ totalShares: 0n }), member(0n))).toBe(0n);
    expect(memberRate(pool(), member(0n))).toBe(0n);
  });

  it('reads back as USDC per month for the UI', () => {
    const rate = toRatePerSecond({ amount: '1000', per: 'month' });
    const p = pool({ ratePerSecond: rate, totalShares: 4n });
    expect(fromRatePerSecond(memberRate(p, member(1n)), 'month')).toBe('249.9999999999984');
  });

  it('exposes a display-only share fraction', () => {
    expect(memberShareFraction(pool(), member(3n))).toBeCloseTo(0.3, 12);
    expect(memberShareFraction(pool({ totalShares: 0n }), member(3n))).toBe(0);
  });
});
