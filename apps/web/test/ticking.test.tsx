import { type AccrualPool, claimable, type PoolMember, toMemberRows, toRatePerSecond } from '@sharedarc/sdk';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemberTable } from '@/components/pool/member-table';
import { formatUsdc } from '@/lib/format';
import { useNow } from '@/lib/hooks';

const A = '0x1111111111111111111111111111111111111111' as const;
const B = '0x2222222222222222222222222222222222222222' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;

const START = 1_000_000n;

/** 86,400 USDC/day = exactly 1 USDC per second, so one tick moves a visible amount. */
const pool: AccrualPool = {
  startTime: START,
  lastAccrual: START,
  cancelled: false,
  ratePerSecond: toRatePerSecond({ amount: '86400', per: 'day' }),
  totalShares: 4n,
  balance: 1_000_000_000_000n,
  owed: 0n,
  accIndex: 0n,
};

const members: PoolMember[] = [
  { address: A, shares: 1n, index: 0n, pending: 0n, payout: ZERO, formerMember: false },
  { address: B, shares: 3n, index: 0n, pending: 0n, payout: ZERO, formerMember: false },
];

/** The page in miniature: one clock, rows derived from it, exactly as PoolDetail does. */
function TickingTable() {
  const now = useNow();
  if (now === null) return <p>loading</p>;
  return <MemberTable pool={pool} rows={toMemberRows(pool, members, now)} />;
}

const cell = (address: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-claimable="${address}"]`);
  if (!el) throw new Error(`no claimable cell for ${address}`);
  return el;
};

describe('the member table ticks at 1 Hz from math.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Number(START + 10n) * 1000);
  });
  afterEach(() => vi.useRealTimers());

  it('shows exactly what claimable() returns at the current second', () => {
    render(<TickingTable />);
    const now = START + 10n;
    expect(cell(A)).toHaveTextContent(formatUsdc(claimable(pool, members[0]!, now)));
    expect(cell(B)).toHaveTextContent(formatUsdc(claimable(pool, members[1]!, now)));
  });

  it('advances by one second of accrual per second, and stays equal to math.ts', () => {
    render(<TickingTable />);
    const before = cell(A).textContent;
    act(() => void vi.advanceTimersByTime(1_000));
    const now = START + 11n;
    expect(cell(A).textContent).not.toBe(before);
    expect(cell(A)).toHaveTextContent(formatUsdc(claimable(pool, members[0]!, now)));
    expect(cell(B)).toHaveTextContent(formatUsdc(claimable(pool, members[1]!, now)));
  });

  it('does not move within the same second, however many frames are drawn', () => {
    render(<TickingTable />);
    const before = cell(A).textContent;
    act(() => void vi.advanceTimersByTime(300));
    act(() => void vi.advanceTimersByTime(300));
    expect(cell(A).textContent).toBe(before);
  });

  it('keeps the share weighting: three shares accrue three times one share', () => {
    render(<TickingTable />);
    act(() => void vi.advanceTimersByTime(4_000));
    const now = START + 14n;
    const one = claimable(pool, members[0]!, now);
    const three = claimable(pool, members[1]!, now);
    expect(three).toBe(one * 3n);
    expect(cell(B)).toHaveTextContent(formatUsdc(three));
  });

  it('stops ticking once the pool is frozen, because math.ts caps accrual at the funded time', () => {
    // 10 USDC at 1 USDC/s funds ten seconds; by t+30 the pool has been dry for twenty.
    const dry: AccrualPool = { ...pool, balance: 10_000_000n };
    const frozen = () => toMemberRows(dry, members, START + 30n)[0]!.claimable;
    expect(frozen()).toBe(claimable(dry, members[0]!, START + 300n));
    expect(frozen()).toBe(2_500_000n); // a quarter of the 10 USDC the pool actually held
  });
});
