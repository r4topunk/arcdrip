// The offchain accrual mirror. Written from the specification (PRD 4.2/4.3) and cross-checked against the
// contract's exported vectors (`contracts/test/vectors/accrual.json`) rather than against its source: two
// independent implementations of the same spec are the test.
//
// Rules this file must keep, because the contract keeps them:
//   - pure bigint, no Number anywhere in an amount path;
//   - every division is a floor (bigint `/` truncates and every operand here is non-negative);
//   - every floor favours the pool: `owed` grows by the full `streamed`, members collectively receive <= it,
//     and the difference is dust that stays in `owed` forever;
//   - accrual is capped by funded time (`dt`), which is what makes the stream freeze instead of going insolvent;
//   - frozen time is never owed later: a deposit resumes streaming from the deposit's own timestamp;
//   - with `totalShares == 0` nothing streams and no funds are consumed.
//
// Every function is pure: inputs are never mutated, new objects come back.
import { INDEX_SCALE, MAX_UINT64, UNBOUNDED_RUNWAY, WAD_PER_UNIT } from './constants.js';
import type { AccrualMember, AccrualPool } from './schemas.js';

/** Unix seconds, as bigint or a safe integer number. */
export type Timestamp = bigint | number;

function toTimestamp(value: Timestamp, label = 'now'): bigint {
  let n: bigint;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be a safe integer, got ${value}`);
    n = BigInt(value);
  } else throw new TypeError(`${label} must be a bigint or an integer number`);
  if (n < 0n) throw new RangeError(`${label} must be >= 0, got ${n}`);
  if (n > MAX_UINT64) throw new RangeError(`${label} ${n} does not fit in uint64`);
  return n;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** `ceil(a / b)` for non-negative integers. Used wherever the contract rounds `owed` up into whole USDC units. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('ceilDiv: divisor must be > 0');
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

/** wad not yet streamed to members: `balance * 1e12 - owed`. Non-negative by invariant I2; clamped anyway. */
export function available(pool: AccrualPool): bigint {
  const value = pool.balance * WAD_PER_UNIT - pool.owed;
  return value > 0n ? value : 0n;
}

/**
 * `_accrue(p)` from PRD 4.2: advance the pool to `now`.
 *
 * `from = max(lastAccrual, startTime)` means a future `startTime` simply holds accrual back; `dt` is capped by
 * `available / ratePerSecond`, which is exactly "streaming stopped at the moment funds ran out" because the
 * parameters cannot change between two accruals (every state-changing function accrues first).
 */
export function accrue(pool: AccrualPool, now: Timestamp): AccrualPool {
  const t = toTimestamp(now);
  const from = max(pool.lastAccrual, pool.startTime);
  if (t > from && pool.ratePerSecond > 0n && pool.totalShares > 0n) {
    const avail = available(pool);
    const dt = min(t - from, avail / pool.ratePerSecond);
    const streamed = pool.ratePerSecond * dt;
    return {
      ...pool,
      accIndex: pool.accIndex + (streamed * INDEX_SCALE) / pool.totalShares,
      owed: pool.owed + streamed,
      lastAccrual: t,
    };
  }
  return { ...pool, lastAccrual: t };
}

/**
 * `_settle(p, m)` from PRD 4.2: move what the index owes this member into their `pending`. Always called on a
 * pool that has already been accrued to the same instant.
 */
export function settle(pool: AccrualPool, member: AccrualMember): AccrualMember {
  return {
    ...member,
    pending: member.pending + (member.shares * (pool.accIndex - member.index)) / INDEX_SCALE,
    index: pool.accIndex,
  };
}

/** Accrue and settle in one step, as every state-changing member function does. */
export function accrueAndSettle(
  pool: AccrualPool,
  member: AccrualMember,
  now: Timestamp,
): { pool: AccrualPool; member: AccrualMember } {
  const nextPool = accrue(pool, now);
  return { pool: nextPool, member: settle(nextPool, member) };
}

/** What a member could withdraw right now, in USDC units (wad pending floored to units, as `withdraw` does). */
export function claimable(pool: AccrualPool, member: AccrualMember, now: Timestamp): bigint {
  return claimableWad(pool, member, now) / WAD_PER_UNIT;
}

/** What a member has accrued right now, in wad (including the sub-unit remainder `withdraw` leaves behind). */
export function claimableWad(pool: AccrualPool, member: AccrualMember, now: Timestamp): bigint {
  return accrueAndSettle(pool, member, now).member.pending;
}

/**
 * The instant the pool runs dry, in unix seconds, computed on the state simulated forward to `now`.
 * `type(uint64).max` when nothing is being consumed (rate 0 — including a cancelled pool — or no shares).
 *
 * The result is a timestamp, so it lives in the uint64 domain the contract's `fundedUntil(uint256)` returns
 * (PRD 4.2). A pool funded past that horizon saturates at `type(uint64).max` — the same sentinel as "nothing
 * is being consumed", which is the truthful reading: it will not run dry within any representable time.
 */
export function fundedUntil(pool: AccrualPool, now: Timestamp): bigint {
  const p = accrue(pool, now);
  if (p.ratePerSecond === 0n || p.totalShares === 0n) return MAX_UINT64;
  const end = max(p.lastAccrual, p.startTime) + available(p) / p.ratePerSecond;
  return end > MAX_UINT64 ? MAX_UINT64 : end;
}

/**
 * Seconds of stream left from `now`. `0` means frozen (or waiting on a future `startTime` with no funds);
 * `UNBOUNDED_RUNWAY` (`type(uint64).max`) means nothing is being consumed, so there is nothing to run out.
 */
export function runwaySeconds(pool: AccrualPool, now: Timestamp): bigint {
  const until = fundedUntil(pool, now);
  if (until === MAX_UINT64) return UNBOUNDED_RUNWAY;
  const t = toTimestamp(now);
  return until > t ? until - t : 0n;
}

/**
 * USDC units the owner may still pull out with `withdrawUnstreamed` or get refunded by `cancel`:
 * `balance - ceilDiv(owed, 1e12)` on the state simulated forward to `now`. Never touches earned funds.
 */
export function unstreamed(pool: AccrualPool, now: Timestamp): bigint {
  const p = accrue(pool, now);
  const reserved = ceilDiv(p.owed, WAD_PER_UNIT);
  return p.balance > reserved ? p.balance - reserved : 0n;
}

/**
 * Simulate `withdraw` / `withdrawFor`: the units that would be transferred and the state afterwards. `units` is
 * 0 exactly when the call would revert `NothingToWithdraw`. The sub-unit remainder stays in `pending` and `owed`.
 */
export function previewWithdraw(
  pool: AccrualPool,
  member: AccrualMember,
  now: Timestamp,
): { units: bigint; pool: AccrualPool; member: AccrualMember } {
  const settled = accrueAndSettle(pool, member, now);
  const units = settled.member.pending / WAD_PER_UNIT;
  if (units === 0n) return { units: 0n, pool: settled.pool, member: settled.member };
  const wad = units * WAD_PER_UNIT;
  return {
    units,
    pool: { ...settled.pool, owed: settled.pool.owed - wad, balance: settled.pool.balance - units },
    member: { ...settled.member, pending: settled.member.pending - wad },
  };
}

/** Simulate `deposit`: accrue first (so frozen time is not back-paid), then credit the units. */
export function previewDeposit(pool: AccrualPool, amount: bigint, now: Timestamp): AccrualPool {
  if (amount <= 0n) throw new RangeError('deposit amount must be > 0');
  const p = accrue(pool, now);
  return { ...p, balance: p.balance + amount };
}

/** Pool status as the UI shows it (PRD 6). `now` decides between scheduled, streaming, frozen and paused. */
export type PoolStatus = 'cancelled' | 'scheduled' | 'paused' | 'frozen' | 'streaming';

export function poolStatus(pool: AccrualPool, now: Timestamp): PoolStatus {
  const t = toTimestamp(now);
  if (pool.cancelled) return 'cancelled';
  if (pool.ratePerSecond === 0n) return 'paused';
  if (pool.startTime > t) return 'scheduled';
  if (pool.totalShares === 0n) return 'paused';
  return available(accrue(pool, t)) >= pool.ratePerSecond ? 'streaming' : 'frozen';
}
