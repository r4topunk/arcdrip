import { UNBOUNDED_RUNWAY } from '@sharedarc/sdk';
import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatInt,
  formatPercent,
  formatUsdc,
  formatUsdcShort,
  nativeFeeToUsdcUnits,
  parseShares,
  parseUsdc,
  RUNWAY_DANGER_SECONDS,
  runwayView,
  shortAddress,
} from '@/lib/format';

describe('USDC amounts', () => {
  it('always shows six decimals, with thousands separators', () => {
    expect(formatUsdc(0n)).toBe('0.000000');
    expect(formatUsdc(1n)).toBe('0.000001');
    expect(formatUsdc(1_234_500_000n)).toBe('1,234.500000');
    expect(formatUsdc(-2_000_000n)).toBe('-2.000000');
  });

  it('trims trailing zeros only in the short form used in prose', () => {
    expect(formatUsdcShort(1_500_000n)).toBe('1.5');
    expect(formatUsdcShort(3_000_000n)).toBe('3');
    expect(formatUsdcShort(0n)).toBe('0');
  });

  it('parses a typed amount and names every way it can be wrong', () => {
    expect(parseUsdc('12.5')).toEqual({ ok: true, value: 12_500_000n });
    expect(parseUsdc(' 1 ')).toEqual({ ok: true, value: 1_000_000n });
    expect(parseUsdc('')).toEqual({ ok: false, error: 'empty' });
    expect(parseUsdc('1,5')).toEqual({ ok: false, error: 'comma' });
    expect(parseUsdc('1.2345678')).toEqual({ ok: false, error: 'decimals' });
    expect(parseUsdc('-1')).toEqual({ ok: false, error: 'format' });
    expect(parseUsdc('0')).toEqual({ ok: false, error: 'zero' });
    expect(parseUsdc('0', { allowZero: true })).toEqual({ ok: true, value: 0n });
  });

  it('rounds a native gas fee up into whole USDC units', () => {
    expect(nativeFeeToUsdcUnits(0n)).toBe(0n);
    expect(nativeFeeToUsdcUnits(1n)).toBe(1n);
    expect(nativeFeeToUsdcUnits(2_000_000_000_000n)).toBe(2n);
  });
});

describe('shares and percentages', () => {
  it('refuses anything that is not a whole number', () => {
    expect(parseShares('3')).toEqual({ ok: true, value: 3n });
    expect(parseShares('0')).toBeNull();
    expect(parseShares('0', { allowZero: true })).toEqual({ ok: true, value: 0n });
    expect(parseShares('1.5')).toBeNull();
    expect(parseShares('-1')).toBeNull();
  });

  it('formats integers and share percentages', () => {
    expect(formatInt(1_234_567n)).toBe('1,234,567');
    expect(formatPercent(0.3333)).toBe('33.33%');
    expect(formatPercent(1)).toBe('100.00%');
    expect(formatPercent(Number.NaN)).toBe('0.00%');
  });

  it('shortens addresses without mangling short strings', () => {
    expect(shortAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234…5678');
    expect(shortAddress('0xabc')).toBe('0xabc');
  });
});

describe('runway', () => {
  it('shows at most two units, largest first', () => {
    expect(formatDuration(23n * 86_400n + 4n * 3_600n)).toBe('23 d 04 h');
    expect(formatDuration(5n * 3_600n + 7n * 60n)).toBe('5 h 07 m');
    expect(formatDuration(3n * 60n + 9n)).toBe('3 m 09 s');
    expect(formatDuration(42n)).toBe('42 s');
  });

  it('is frozen at zero and unbounded at the uint64 sentinel', () => {
    expect(runwayView(0n)).toEqual({ kind: 'frozen' });
    expect(runwayView(UNBOUNDED_RUNWAY)).toEqual({ kind: 'unbounded' });
  });

  it('turns red strictly under three days (PRD 6)', () => {
    expect(runwayView(RUNWAY_DANGER_SECONDS)).toMatchObject({ kind: 'duration', danger: false });
    expect(runwayView(RUNWAY_DANGER_SECONDS - 1n)).toMatchObject({ kind: 'duration', danger: true });
  });
});
