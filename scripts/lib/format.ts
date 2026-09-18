// Output helpers. USDC amounts are always shown in the 6-decimal ERC-20 view (PRD 6 UX rules).
import { formatUnits } from 'viem';
import { USDC_DECIMALS } from './config.js';

/** 1_000_000n -> "1.000000 USDC". */
export function formatUsdc(baseUnits: bigint): string {
  const [whole, frac = ''] = formatUnits(baseUnits, USDC_DECIMALS).split('.');
  return `${whole}.${frac.padEnd(USDC_DECIMALS, '0')} USDC`;
}

/**
 * Transaction fee in USDC base units (6 decimals): gasUsed x effectiveGasPrice is in the 18-decimal native view of
 * the same USDC, so divide by 10^12. Rounded down; only meaningful on Arc, where gas is paid in USDC.
 */
export function feeInUsdcBaseUnits(gasUsed: bigint, effectiveGasPrice: bigint): bigint {
  return (gasUsed * effectiveGasPrice) / 10n ** 12n;
}

/** Right-pads `s` to `width` characters. */
export function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** 1234567n -> "1,234,567". */
export function formatInt(n: bigint | number): string {
  return BigInt(n).toLocaleString('en-US');
}

/** 3725 -> "1 h 2 min 5 s"; 0 -> "0 s". Used for waits and runway. */
export function formatDuration(seconds: number | bigint): string {
  let s = Number(seconds);
  if (!Number.isFinite(s)) return 'forever';
  if (s <= 0) return '0 s';
  const parts: string[] = [];
  const days = Math.floor(s / 86_400);
  if (days) parts.push(`${days} d`);
  s -= days * 86_400;
  const hours = Math.floor(s / 3_600);
  if (hours) parts.push(`${hours} h`);
  s -= hours * 3_600;
  const minutes = Math.floor(s / 60);
  if (minutes) parts.push(`${minutes} min`);
  s -= minutes * 60;
  if (s || parts.length === 0) parts.push(`${Math.floor(s)} s`);
  return parts.join(' ');
}

/** Unix seconds -> ISO-8601 without milliseconds. */
export function formatTime(unixSeconds: number | bigint): string {
  return new Date(Number(unixSeconds) * 1_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
