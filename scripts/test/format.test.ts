import { describe, expect, it } from 'vitest';
import { feeInUsdcBaseUnits, formatDuration, formatInt, formatTime, formatUsdc, pad } from '../lib/format.js';

describe('formatUsdc', () => {
  it('always shows the six decimals of the ERC-20 view', () => {
    expect(formatUsdc(0n)).toBe('0.000000 USDC');
    expect(formatUsdc(1n)).toBe('0.000001 USDC');
    expect(formatUsdc(1_000_000n)).toBe('1.000000 USDC');
    expect(formatUsdc(1_234_567_890n)).toBe('1234.567890 USDC');
  });
});

describe('feeInUsdcBaseUnits', () => {
  it('converts the 18-decimal native fee into USDC units (gas is USDC on Arc)', () => {
    // 100,000 gas at the 20 gwei floor = 2e15 wei = 0.002 USDC
    expect(feeInUsdcBaseUnits(100_000n, 20_000_000_000n)).toBe(2_000n);
    expect(formatUsdc(feeInUsdcBaseUnits(100_000n, 20_000_000_000n))).toBe('0.002000 USDC');
  });

  it('rounds down and never divides by zero', () => {
    expect(feeInUsdcBaseUnits(1n, 1n)).toBe(0n);
    expect(feeInUsdcBaseUnits(0n, 0n)).toBe(0n);
  });
});

describe('formatDuration', () => {
  it('reads like the runway line of the app', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(3_725)).toBe('1 h 2 min 5 s');
    expect(formatDuration(2 * 86_400 + 3_600)).toBe('2 d 1 h');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('forever');
  });
});

describe('formatTime / formatInt / pad', () => {
  it('formats timestamps, integers and columns', () => {
    expect(formatTime(0)).toBe('1970-01-01T00:00:00Z');
    expect(formatInt(1_234_567n)).toBe('1,234,567');
    expect(pad('abc', 5)).toBe('abc  ');
    expect(pad('abcdef', 3)).toBe('abcdef');
  });
});
