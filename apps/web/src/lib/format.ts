// Every number the app shows goes through here. Amounts are USDC units (1e-6 USDC) and durations are seconds,
// both as bigint, because that is what the SDK's accrual mirror works in: nothing is ever rounded through a float.
import { UNBOUNDED_RUNWAY } from '@arcdrip/sdk';
import type { Locale } from './i18n';

/** Decimals of the USDC ERC-20 view on Arc. Gas is paid in the same asset, in an 18-decimal native view. */
export const USDC_DECIMALS = 6;
const UNIT = 10n ** BigInt(USDC_DECIMALS);
/** 18-decimal native units per 6-decimal USDC unit. */
const NATIVE_PER_USDC_UNIT = 10n ** 12n;

const withThousands = (s: string) => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** USDC units to a string with exactly 6 decimals: 1234500000n -> "1,234.500000" (PRD 6: 6 decimals max). */
export function formatUsdc(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const int = withThousands((abs / UNIT).toString());
  const frac = (abs % UNIT).toString().padStart(USDC_DECIMALS, '0');
  return `${negative ? '-' : ''}${int}.${frac}`;
}

/** The same amount with trailing zeros trimmed, for prose ("1.5 USDC / month" rather than "1.500000"). */
export function formatUsdcShort(units: bigint): string {
  const full = formatUsdc(units);
  const trimmed = full.replace(/\.?0+$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

export type UsdcParseError = 'empty' | 'format' | 'comma' | 'decimals' | 'tooLarge' | 'zero';
export type UsdcParseResult = { ok: true; value: bigint } | { ok: false; error: UsdcParseError };

/**
 * Parses a typed USDC amount into 6-decimal units. A dot is the only decimal separator (no locale guessing),
 * more than 6 decimals is an error rather than a silent truncation, and negative input is refused.
 */
export function parseUsdc(input: string, { allowZero = false } = {}): UsdcParseResult {
  const s = input.trim();
  if (s === '') return { ok: false, error: 'empty' };
  if (s.includes(',')) return { ok: false, error: 'comma' };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return { ok: false, error: 'format' };
  const int = m[1] || '0';
  const frac = m[2] ?? '';
  if (frac.length > USDC_DECIMALS) return { ok: false, error: 'decimals' };
  if (int.replace(/^0+/, '').length > 15) return { ok: false, error: 'tooLarge' };
  const value = BigInt(int) * UNIT + BigInt(frac.padEnd(USDC_DECIMALS, '0'));
  if (value === 0n && !allowZero) return { ok: false, error: 'zero' };
  return { ok: true, value };
}

/** Positive integer (shares, member counts). `allowZero` accepts 0, which is how a member is removed. */
export function parseShares(input: string, { allowZero = false } = {}): { ok: true; value: bigint } | null {
  const s = input.trim();
  if (!/^\d+$/.test(s)) return null;
  const value = BigInt(s);
  if (value === 0n && !allowZero) return null;
  return { ok: true, value };
}

/** A network fee in native units (gas x gasPrice, 18 decimals on Arc) as USDC units, rounded up. */
export function nativeFeeToUsdcUnits(feeWei: bigint): bigint {
  return (feeWei + NATIVE_PER_USDC_UNIT - 1n) / NATIVE_PER_USDC_UNIT;
}

/** Integer with comma thousands separators (shares, block numbers). */
export function formatInt(n: bigint | number): string {
  return withThousands(n.toString());
}

/** A share of the pool as a percentage with two decimals: 0.3333 -> "33.33%". Display only, never an amount. */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0.00%';
  return `${(fraction * 100).toFixed(2)}%`;
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function shortHash(h: string): string {
  return h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}

/** Runway under this many seconds is shown in red (PRD 6: "red under 3 days"). */
export const RUNWAY_DANGER_SECONDS = 3n * 86_400n;

export type RunwayView =
  | { kind: 'frozen' }
  | { kind: 'unbounded' }
  | { kind: 'duration'; text: string; danger: boolean };

/**
 * Runway as the pool header shows it: "23 d 4 h", "5 h 07 m", "42 s". Zero seconds is `frozen` (the pool ran dry
 * or has not started with no funds); `UNBOUNDED_RUNWAY` is `unbounded` (rate 0, no shares, or cancelled — nothing
 * is being consumed, so there is nothing to run out).
 */
export function runwayView(seconds: bigint): RunwayView {
  if (seconds >= UNBOUNDED_RUNWAY) return { kind: 'unbounded' };
  if (seconds <= 0n) return { kind: 'frozen' };
  const danger = seconds < RUNWAY_DANGER_SECONDS;
  return { kind: 'duration', text: formatDuration(seconds), danger };
}

const two = (n: bigint) => n.toString().padStart(2, '0');

/** A duration in seconds as at most two units: "23 d 04 h", "5 h 07 m", "3 m 09 s", "42 s". */
export function formatDuration(seconds: bigint): string {
  if (seconds <= 0n) return '0 s';
  const days = seconds / 86_400n;
  const hours = (seconds % 86_400n) / 3_600n;
  const minutes = (seconds % 3_600n) / 60n;
  const secs = seconds % 60n;
  if (days > 0n) return `${formatInt(days)} d ${two(hours)} h`;
  if (hours > 0n) return `${hours} h ${two(minutes)} m`;
  if (minutes > 0n) return `${minutes} m ${two(secs)} s`;
  return `${secs} s`;
}

const INTL_LOCALE: Record<Locale, string> = { en: 'en-US', 'pt-BR': 'pt-BR' };

/** Unix seconds to a local wall-clock date and time. */
export function formatDateTime(unixSeconds: number | bigint, locale: Locale, timeZone?: string): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleString(INTL_LOCALE[locale], {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  });
}

/** Stable JSON for query keys and comparisons: bigints become decimal strings. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}
