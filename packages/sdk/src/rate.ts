// Rate helpers: turn "1000 USDC per month" into the wad/s the contract stores, and back. Pure bigint.
//
// A month is 30 days (2,592,000 s) and a year is 365 days. That is a convention, not a calendar: the contract
// only ever sees `ratePerSecond`, so "1 USDC / month" means 1 USDC every 30 days, forever. The UI must label it
// the same way.
import { MAX_RATE, USDC_DECIMALS, WAD_PER_UNIT } from './constants.js';
import type { AccrualMember, AccrualPool } from './schemas.js';

/** Named periods accepted by the rate helpers, in seconds. */
export const PERIOD_SECONDS = {
  second: 1n,
  minute: 60n,
  hour: 3_600n,
  day: 86_400n,
  week: 604_800n,
  /** 30 days, by convention. */
  month: 2_592_000n,
  /** 365 days, by convention. */
  year: 31_536_000n,
} as const;

export type PeriodName = keyof typeof PERIOD_SECONDS;
/** A named period, or a raw number of seconds. */
export type Period = PeriodName | bigint | number;

/** Seconds in a period. Throws on an unknown name or a non-positive number of seconds. */
export function periodToSeconds(per: Period): bigint {
  if (typeof per === 'string') {
    const seconds = PERIOD_SECONDS[per as PeriodName];
    if (seconds === undefined) {
      throw new RangeError(
        `unknown period "${per}", expected one of ${Object.keys(PERIOD_SECONDS).join(', ')}`,
      );
    }
    return seconds;
  }
  let seconds: bigint;
  if (typeof per === 'bigint') seconds = per;
  else if (typeof per === 'number') {
    if (!Number.isSafeInteger(per)) throw new RangeError(`period seconds must be a safe integer, got ${per}`);
    seconds = BigInt(per);
  } else throw new TypeError('period must be a name, a bigint or an integer number of seconds');
  if (seconds <= 0n) throw new RangeError(`period seconds must be > 0, got ${seconds}`);
  return seconds;
}

const DECIMAL_AMOUNT_RE = /^([0-9]+)(?:\.([0-9]+))?$/;

/** Parse a decimal amount string into base units of `decimals`. Rejects more decimals than fit (no silent loss). */
export function parseFixed(amount: string | number | bigint, decimals: number, label = 'amount'): bigint {
  if (typeof amount === 'bigint') {
    if (amount < 0n) throw new RangeError(`${label} must be >= 0, got ${amount}`);
    return amount * 10n ** BigInt(decimals);
  }
  const text = typeof amount === 'number' ? numberToDecimalString(amount, label) : amount.trim();
  const match = DECIMAL_AMOUNT_RE.exec(text);
  if (!match) throw new RangeError(`${label} must be a non-negative decimal string, got "${text}"`);
  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  if (frac.length > decimals) {
    throw new RangeError(`${label} "${text}" has more than ${decimals} decimals`);
  }
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

/** Format base units of `decimals` as a decimal string, trailing zeros trimmed ("1", "0.5", "12.000001"). */
export function formatFixed(value: bigint, decimals: number): string {
  if (value < 0n) return `-${formatFixed(-value, decimals)}`;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}` : whole.toString();
}

function numberToDecimalString(value: number, label: string): string {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite, got ${value}`);
  if (value < 0) throw new RangeError(`${label} must be >= 0, got ${value}`);
  const text = value.toString();
  if (text.includes('e') || text.includes('E')) {
    throw new RangeError(`${label} ${value} is in exponent notation; pass it as a decimal string`);
  }
  return text;
}

/** USDC decimal string -> USDC units (1e-6 USDC). */
export const parseUsdc = (amount: string | number | bigint): bigint =>
  parseFixed(amount, USDC_DECIMALS, 'USDC amount');
/** USDC units -> decimal string. */
export const formatUsdc = (units: bigint): string => formatFixed(units, USDC_DECIMALS);
/** wad -> USDC decimal string (wad is USDC with 18 decimals). */
export const formatWad = (wad: bigint): string => formatFixed(wad, 18);

export interface RateInput {
  /** USDC amount per period, as a decimal string ("1000", "12.5"), a number, or USDC units as a bigint. */
  amount: string | number | bigint;
  /** `"month" | "week" | "day" | ...` or a number of seconds. */
  per: Period;
}

/**
 * "1000 USDC per month" -> `ratePerSecond` in wad/s, floored. The floor means the pool streams marginally less
 * than the nominal amount per period; `fromRatePerSecond` shows exactly how much.
 */
export function toRatePerSecond({ amount, per }: RateInput): bigint {
  const units = parseUsdc(amount);
  const rate = (units * WAD_PER_UNIT) / periodToSeconds(per);
  if (rate > MAX_RATE) throw new RangeError(`ratePerSecond ${rate} exceeds MAX_RATE ${MAX_RATE}`);
  return rate;
}

/** The exact USDC amount a `ratePerSecond` streams over one period, as a decimal string (up to 18 decimals). */
export function fromRatePerSecond(ratePerSecond: bigint, per: Period): string {
  if (ratePerSecond < 0n) throw new RangeError(`ratePerSecond must be >= 0, got ${ratePerSecond}`);
  return formatWad(ratePerSecond * periodToSeconds(per));
}

/** The same amount in whole USDC units, floored: what the pool can actually transfer over one period. */
export function unitsPerPeriod(ratePerSecond: bigint, per: Period): bigint {
  if (ratePerSecond < 0n) throw new RangeError(`ratePerSecond must be >= 0, got ${ratePerSecond}`);
  return (ratePerSecond * periodToSeconds(per)) / WAD_PER_UNIT;
}

/**
 * A member's slice of the pool rate, in wad/s: `ratePerSecond * shares / totalShares`, floored the same way the
 * index does. `0` when the pool has no shares (nothing streams) or the member has none.
 */
export function memberRate(pool: AccrualPool, member: AccrualMember): bigint {
  if (pool.totalShares === 0n || member.shares === 0n) return 0n;
  return (pool.ratePerSecond * member.shares) / pool.totalShares;
}

/** A member's share of the pool as a fraction in [0, 1], for display only (never for an amount). */
export function memberShareFraction(pool: AccrualPool, member: AccrualMember): number {
  if (pool.totalShares === 0n) return 0;
  return Number(member.shares) / Number(pool.totalShares);
}
