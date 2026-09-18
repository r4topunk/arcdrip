// Pure pool logic the UI needs on top of the SDK: the tone of each status, the "Pay everyone" plan, and the
// validation of the two forms that build a `ratePerSecond`. Kept out of the components so it is unit-tested.
import {
  type AccrualPool,
  chunkMembers,
  MAX_BATCH,
  MAX_RATE,
  MAX_SHARES,
  MAX_TOTAL_SHARES,
  type MemberRow,
  type PeriodName,
  type PoolStatus,
  toRatePerSecond,
} from '@sharedarc/sdk';
import type { Address } from 'viem';
import { parseShares, parseUsdc } from './format';

export type Tone = 'accent' | 'info' | 'ok' | 'warn' | 'danger' | 'muted';

/** One tone per derived status (PRD 6). `frozen` is a warning, not an error: a deposit resumes the stream. */
export const STATUS_TONE: Record<PoolStatus, Tone> = {
  streaming: 'ok',
  scheduled: 'info',
  paused: 'muted',
  frozen: 'warn',
  cancelled: 'danger',
};

/** Periods the rate builder offers, in the order the selector shows them. `month` is 30 days by SDK convention. */
export const RATE_PERIODS = ['day', 'week', 'month'] as const satisfies readonly PeriodName[];
export type RatePeriod = (typeof RATE_PERIODS)[number];

export function isRatePeriod(value: string): value is RatePeriod {
  return (RATE_PERIODS as readonly string[]).includes(value);
}

export type RateError = 'amount' | 'decimals' | 'tooLarge';
export type RateResult = { ok: true; ratePerSecond: bigint } | { ok: false; error: RateError };

/**
 * "1000 USDC per month" -> wad/s. A rate that floors to zero is refused rather than silently creating a pool
 * that never pays anyone; the amount is otherwise only bounded by MAX_RATE.
 */
export function buildRate(amount: string, per: RatePeriod): RateResult {
  const parsed = parseUsdc(amount);
  if (!parsed.ok) return { ok: false, error: parsed.error === 'decimals' ? 'decimals' : 'amount' };
  // The decimal string, not `parsed.value`: the SDK reads a bigint as *whole* USDC, a string as a USDC amount.
  // `parseUsdc` above is only there to classify the mistake before the SDK throws.
  const ratePerSecond = toRatePerSecond({ amount: amount.trim(), per });
  if (ratePerSecond === 0n) return { ok: false, error: 'amount' };
  if (ratePerSecond > MAX_RATE) return { ok: false, error: 'tooLarge' };
  return { ok: true, ratePerSecond };
}

export type SharesError = 'format' | 'tooLarge' | 'poolTooLarge';
export type SharesResult = { ok: true; shares: bigint } | { ok: false; error: SharesError };

/**
 * A shares value for `setShares`. `current` is what this member already has, so the pool-wide cap is checked on
 * the total the write would produce, which is exactly what the contract does.
 */
export function buildShares(
  input: string,
  { current = 0n, totalShares = 0n }: { current?: bigint; totalShares?: bigint } = {},
): SharesResult {
  const parsed = parseShares(input, { allowZero: true });
  if (!parsed) return { ok: false, error: 'format' };
  if (parsed.value > MAX_SHARES) return { ok: false, error: 'tooLarge' };
  if (totalShares - current + parsed.value > MAX_TOTAL_SHARES) return { ok: false, error: 'poolTooLarge' };
  return { ok: true, shares: parsed.value };
}

export interface BatchPlan {
  /** Members with at least one whole USDC unit to withdraw, in table order. */
  payable: Address[];
  /** `payable` split into `withdrawForBatch` calls of at most MAX_BATCH addresses. */
  chunks: Address[][];
  /** Units the batch would move, from the offchain mirror (the chain decides the real amount). */
  total: bigint;
}

/**
 * The plan behind the "Pay everyone" button: skip anyone with nothing to withdraw (the contract would skip them
 * anyway, and they would only cost gas), then chunk at 100, which is the contract's MAX_BATCH.
 */
export function planBatch(rows: readonly MemberRow[], size: number = MAX_BATCH): BatchPlan {
  const payable = rows.filter((r) => r.claimable > 0n);
  return {
    payable: payable.map((r) => r.address),
    chunks: chunkMembers(
      payable.map((r) => r.address),
      size,
    ),
    total: payable.reduce((sum, r) => sum + r.claimable, 0n),
  };
}

/** True when `account` owns the pool (the owner panel's gate). Case-insensitive, as addresses are. */
export function isOwner(pool: { owner: Address } | undefined, account: Address | undefined): boolean {
  return !!pool && !!account && pool.owner.toLowerCase() === account.toLowerCase();
}

/** True when `account` is the pending owner and can accept the transfer. */
export function isPendingOwner(
  pool: { pendingOwner: Address } | undefined,
  account: Address | undefined,
): boolean {
  return (
    !!pool &&
    !!account &&
    pool.pendingOwner !== '0x0000000000000000000000000000000000000000' &&
    pool.pendingOwner.toLowerCase() === account.toLowerCase()
  );
}

/** The connected wallet's row, if it is (or was) a member. Drives the member panel and the Withdraw button. */
export function ownRow(rows: readonly MemberRow[], account: Address | undefined): MemberRow | undefined {
  if (!account) return undefined;
  const lower = account.toLowerCase();
  return rows.find((r) => r.address.toLowerCase() === lower);
}

/** Owner actions the contract refuses on a cancelled pool: everything but the ownership transfer pair (PRD 4.3). */
export function ownerActionsDisabled(pool: Pick<AccrualPool, 'cancelled'> | undefined): boolean {
  return !!pool?.cancelled;
}
