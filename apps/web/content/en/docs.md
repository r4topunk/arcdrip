# How SharedArc works

SharedArc is one shared USDC stream for a collective: **one rate, N shares, one live runway**. A pre-funded pool
streams `ratePerSecond` USDC, split among members by mutable integer shares. Joining, leaving or re-weighting
mid-stream is one O(1) write that touches nobody else's storage.

Everything on this page is what the `DripPool` contract actually does. The numbers ticking in the app come from
the same arithmetic, mirrored in `@sharedarc/sdk`, so a member watching their balance fill is watching the chain,
not an estimate.

## The accrual, in full

Time enters the contract in exactly one place. Every state-changing function calls `_accrue` before it touches
the rate, the shares, the balance or what is owed.

```
_accrue(p):
  from = max(p.lastAccrual, p.startTime)
  if (now > from && p.ratePerSecond > 0 && p.totalShares > 0):
      available = p.balance * WAD_PER_UNIT - p.owed          // wad not yet streamed
      dt        = min(now - from, available / p.ratePerSecond) // floor: this is the freeze
      streamed  = p.ratePerSecond * dt
      p.accIndex += streamed * INDEX_SCALE / p.totalShares     // floor
      p.owed     += streamed
  p.lastAccrual = now

_settle(p, m):  // always right after _accrue
  m.pending += m.shares * (p.accIndex - m.index) / INDEX_SCALE // floor
  m.index    = p.accIndex
```

`accIndex` is the whole trick. It counts how much one share has earned since the pool was created. A member's
own `index` records where that counter stood the last time they were settled, so the difference times their
shares is what they have earned, whatever happened to anyone else in between. Adding a member is one storage
write. Re-weighting a member re-prices the whole pool from that second on, and costs the same one write.

Amounts are kept in **wad** (USDC units × 1e12, i.e. 18 decimals) so that a small rate like 1 USDC per month —
about 3.9e-7 USDC per second — does not round to zero. Transfers are still whole USDC units: the sub-unit
remainder stays in `pending` and comes out with the next withdrawal.

### A worked example

A pool streams 3 USDC/day. Members are A with 1 share, B with 1 and C with 2. Somebody deposits 1 USDC.

| Moment | What happens |
|---|---|
| t = 0 | 1 USDC funds 8 hours at 3 USDC/day. Runway reads "8 h 00 m". |
| t = 4 h | 0.5 USDC has streamed: A 0.125, B 0.125, C 0.25. |
| t = 4 h | The owner adds D with 1 share. A, B and C are settled first, so their 0.5 USDC is untouched. From here the split is 1/1/2/1. |
| t = 8 h | The pool is empty. `dt` is capped at the funded time, so accrual stops by itself: **frozen**. Claimable stops growing, and nobody is owed more than the pool holds. |
| t = 20 h | Somebody deposits 5 USDC. Streaming resumes **from the deposit's own timestamp**. The 12 frozen hours are not paid back. |

## What is guaranteed

| Guarantee | How it holds |
|---|---|
| A pool can never owe more than it holds | `dt` is capped by `available / ratePerSecond`, so accrual stops at the exact second the funds run out. Invariant I2: `owed ≤ balance × 1e12`. |
| The owner can never touch earned funds | `withdrawUnstreamed` and `cancel` are both bounded by `balance − ceilDiv(owed, 1e12)`. Invariant I4: no owner action ever lowers any member's claimable. |
| Leaving does not forfeit anything | `setShares(member, 0)` settles first. What is already accrued stays withdrawable forever, including after the pool is cancelled. |
| Rounding never over-pays | Every division floors, and every floor favours the pool. The difference is dust that stays in `owed`, bounded below 1 wad per accrual. |
| A member with no gas still gets paid | `withdrawFor(poolId, member)` is permissionless and always sends to the member's own payout address. The caller pays the gas and receives nothing. |
| One blocked member cannot stall the others | `withdrawForBatch` wraps each transfer in a `try`. A failed transfer is rolled back for that member alone and reported as `WithdrawSkipped`; the batch never reverts. |

What is **not** guaranteed, and is said plainly: this is a payroll, so the owner can pause (`setRate(0)`),
re-weight or cancel at any time. Members are protected for the past, never for the future.

## Statuses

| Status | Meaning |
|---|---|
| Scheduled | `startTime` is in the future. Nothing accrues yet and no funds are consumed. |
| Streaming | Funds are flowing to members every second. |
| Paused | The rate is zero, or the pool has no shares. Nothing accrues, nothing is consumed. |
| Frozen | The pool ran out of funds. It resumes on the next deposit, with no back-pay. |
| Cancelled | Stopped for good. Members keep withdrawing what they earned, forever. |

## Plug a Safe, or any DAO, as owner

The pool owner is a plain `address`. It can be an EOA, a Safe, a governance contract or an agent's wallet — the
contract has no built-in governance, no roles and no admin key of its own. Whatever can send a transaction can
own a pool.

Ownership moves in two steps: the current owner calls `transferPoolOwnership`, the new owner calls
`acceptPoolOwnership`. Nothing changes until that second call, so a typo cannot lose a pool. The pair keeps
working on a cancelled pool.

## How it compares

| | SharedArc | Sablier-style streams | 0xSplits-style splitters | Arc Studio Revenue Router |
|---|---|---|---|---|
| Time-based | yes | yes | no (splits on arrival) | no |
| Mutable weights | yes, O(1) per change | cancel and recreate N streams | yes | fixed at deploy |
| One runway number | yes, per pool | spread over N balances | n/a | n/a |
| Adding a member | one storage write | a new stream to fund | one write | redeploy |
| Insolvency | impossible: the stream freezes | per-stream deposits | n/a | n/a |
| On Arc | yes | not deployed | not deployed | tutorial sample |

## FAQ

**Where does the money live?** In the `DripPool` singleton, accounted per pool. Direct USDC transfers to the
contract are ignored by the accounting and cannot be recovered — always use `deposit`.

**What does a withdrawal cost?** About 0.002 USDC at Arc's 20 gwei floor. Gas is paid in USDC, so a member
holding nothing but their payroll can withdraw without acquiring any other asset.

**Why do I sometimes see "nothing to withdraw"?** Withdrawals move whole USDC units. Below 0.000001 USDC there
is nothing to transfer yet; the amount is not lost, it keeps accruing.

**Can the pool pay me somewhere else?** Yes: `setPayoutAddress`. It works even with zero shares, which is how a
member blocked by the USDC issuer can still receive what the pool owes them.

**Is there a token, a fee or an upgrade path?** No, no and no. One immutable contract, no admin key over it, no
fees, no yield.
