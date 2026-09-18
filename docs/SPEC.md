# ArcDrip technical spec

> Implementation spec for the product defined in [`PRD.md`](../PRD.md). The decisions in PRD §3 (D1–D15) are
> final; this document explains how they are built, it does not reopen them.
> Onchain source of truth: [`contracts/src/DripPool.sol`](../contracts/src/DripPool.sol) and
> [`contracts/src/interfaces/IDripPool.sol`](../contracts/src/interfaces/IDripPool.sol). If this file and the
> contract disagree, the contract wins, unless it breaks an explicit PRD §4 rule — that would be a contract
> bug, not a spec change. Divergences known at the time of writing are listed in §11.

## TL;DR

```sh
pnpm install
pnpm test      # forge test + every vitest suite
pnpm check     # build + test + typecheck + lint + forge fmt --check + ABI drift check
```

- One immutable singleton, `DripPool`, holds **many pools**. A pool has one `ratePerSecond`, one `balance`,
  one `owed`, and N members with mutable integer `shares`.
- Accounting is an **accumulated index** (`accIndex`, wad per share × 1e18). Joining, leaving or re-weighting
  is one O(1) write that never touches another member's storage.
- Internal amounts are **wad** = USDC units × 1e12. A rate of 1 USDC/month is 385802469135 wad/s, not 0.
- `_accrue` caps elapsed time at `available / rate`. That cap **is** the freeze: the pool can never owe more
  than it holds, and no `fundedUntil` is stored. Frozen time is never back-paid.
- Every division floors, and **every floor favours the pool**. Members collectively receive at most what was
  streamed; the remainder is dust that stays in `owed` forever.
- Money leaves only through `withdraw` / `withdrawFor` / `withdrawForBatch` (to the member's payout address,
  never to the caller) and through `withdrawUnstreamed` / `cancel` (bounded by `balance − ceil(owed/1e12)`).

## 1. Overview

```
   owner ──createPool(owner, rate, startTime, name)──► poolId
     │
     ├── setRate(rate)            ─┐
     ├── setShares(member, shares) ├─ each calls _accrue() BEFORE touching rate/totalShares/balance/owed
     ├── withdrawUnstreamed(amt)  ─┤
     └── cancel(to)               ─┘        anyone ──deposit(poolId, amount)──► balance += amount
                                                          │
                                   ┌──────────────────────┴──────────────────────┐
                                   │   Pool: rate, totalShares, balance, owed,   │
                                   │         accIndex, lastAccrual, startTime    │
                                   └──────────────────────┬──────────────────────┘
                                                          │ _settle(member)
                                   Member: shares, index, pending, payout
                                                          │
   member ──withdraw()──┐                                 │
   anyone ──withdrawFor(member)──┼──► USDC ──► member.payout (or the member address)
   anyone ──withdrawForBatch([…])┘      (a failing transfer is skipped and restored, never reverts the batch)
```

Repo layout (PRD §11):

```
contracts/    Foundry: src/{DripPool.sol,interfaces/IDripPool.sol},
              test/{unit,fuzz,invariant,fork,mocks,vectors}
packages/sdk/ @arcdrip/sdk: math mirror, rate helpers, viem actions, Zod schemas
apps/web/     Next.js static export, EN/PT-BR ("Collective Payroll")
docs/         SPEC.md (this file), THREATS.md, GAS.md
```

Two properties shape everything below:

1. **`owed` is sacred.** No owner action can reduce a member's `claimable`. `withdrawUnstreamed` and `cancel`
   are bounded by `balance − ceilDiv(owed, 1e12)`; `setRate` and `setShares` accrue first, so they only ever
   change the *future*.
2. **Insolvency is impossible by construction (D3).** There is no liquidation, no keeper, no solvency check
   at withdrawal time. `_accrue` simply refuses to stream money the pool does not have.

## 2. Constants and units

| Constant | Value | Meaning |
|---|---|---|
| `WAD_PER_UNIT` | `1e12` | 1 USDC unit (1e-6 USDC) expressed in wad. Internal amounts are wad = units × 1e12 |
| `INDEX_SCALE` | `1e18` | fixed-point scale of `Pool.accIndex` (wad per share) |
| `MAX_RATE` | `1e30` | wad/s = 1e12 USDC/s; overflow guard on `rate × dt` and `streamed × 1e18` |
| `MAX_SHARES` | `1e15` | per member |
| `MAX_TOTAL_SHARES` | `1e18` | pool-wide; keeps per-accrual index dust below 1 wad |
| `MAX_BATCH` | `100` | entries per `setSharesBatch` / `withdrawForBatch` |
| `usdc` | immutable ctor arg | Arc: `0x3600000000000000000000000000000000000000`, 6 decimals |

Three units appear in this document. Keep them apart:

- **USDC** — human amount, 6 decimals. Only the UI and docs use it.
- **unit** — the ERC-20's own integer, 1e-6 USDC. Everything transferred on-chain, `balance`, `claimable`,
  `unstreamed`, and every `amount` in an event or a function argument is in units.
- **wad** — unit × 1e12, an 18-decimal internal amount. `ratePerSecond`, `owed`, `Member.pending` and the
  numerator of `accIndex` are in wad. Wad never crosses the ERC-20 boundary.

Why wad (D9): 1 USDC/month = 1e6 units / 2,592,000 s = 0 units/s in integer arithmetic. In wad it is
`1e18 / 2_592_000 = 385_802_469_135` wad/s, which loses 0.0000001% per second instead of everything.

Rate conversion, as implemented by the SDK's `toRatePerSecond` (`packages/sdk/src/rate.ts`):

```
ratePerSecond = floor(amountUsdcUnits * 1e12 / periodSeconds)     // month = 30 days = 2_592_000 s
```

## 3. State

```solidity
struct Pool {
  address owner;          // may pause, re-weight, sweep unstreamed funds, cancel; never touches `owed`
  address pendingOwner;   // two-step transfer
  uint64  startTime;      // accrual never starts before this; 0 at creation means "now"
  uint64  lastAccrual;    // timestamp of the last _accrue
  bool    cancelled;      // terminal: no deposits, no owner writes; members withdraw forever
  uint128 ratePerSecond;  // wad/s for the whole pool; 0 = paused
  uint128 totalShares;    // Σ member shares; 0 = nothing streams and nothing is consumed
  uint256 balance;        // USDC units held for this pool
  uint256 owed;           // wad streamed to members and not yet withdrawn (includes dust)
  uint256 accIndex;       // wad per share, scaled by INDEX_SCALE
}
struct Member { uint128 shares; address payout; uint256 index; uint256 pending; } // pending in wad

mapping(uint256 => Pool) pools;
mapping(uint256 => mapping(address => Member)) members;
uint256 nextPoolId = 1;                      // pool ids start at 1
```

`name` is emitted in `PoolCreated` and never stored. There is **no onchain member enumeration** (D7): the SDK
rebuilds the member set from `SharesSet` logs (`packages/sdk/src/members.ts`). A pool id that was never created
is detected by `owner == address(0)` and reverts `PoolNotFound`; `owner` can never be set back to zero, so the
check cannot produce a false negative.

Pools are fully isolated: no field of pool *i* is read or written while operating on pool *j*
(`DripPoolCreateTest.test_Pools_AreIsolated`).

## 4. The accrual block

This is the entire time model. It is the only place `block.timestamp` enters the accounting.

```
_accrue(p):
  from = max(p.lastAccrual, p.startTime)
  if (now > from && p.ratePerSecond > 0 && p.totalShares > 0):
      available = p.balance * WAD_PER_UNIT − p.owed      // wad not yet streamed; never negative (I2)
      dt        = min(now − from, available / p.ratePerSecond)   // floor; THIS is the freeze
      if (dt > 0):
          streamed    = p.ratePerSecond * dt
          p.accIndex += streamed * INDEX_SCALE / p.totalShares   // floor, favours the pool
          p.owed     += streamed
  p.lastAccrual = now

_settle(p, m):                                            // always immediately after _accrue
  m.pending += m.shares * (p.accIndex − m.index) / INDEX_SCALE   // floor, favours the pool
  m.index    = p.accIndex
```

`_accrueMath` is a `pure` function shared by `_accrue` (writes) and `_simulate` (views), so `claimable`,
`fundedUntil` and `unstreamed` can never drift from what the next transaction will actually do.

### 4.1 Rules that follow

- **R1 — accrue before anything.** Every state-changing function calls `_accrue` *before* changing `rate`,
  `totalShares`, `balance` or `owed`. Since those parameters are constant between two accruals, capping `dt`
  is exactly equivalent to "streaming stopped at the second the money ran out". No `fundedUntil` is stored.
- **R2 — frozen time is not owed later.** After a freeze, a deposit resumes streaming from the deposit's own
  timestamp. The frozen interval is gone, not deferred. (`deposit` runs `_accrue` first, and that accrual
  moves `lastAccrual` to now while streaming `dt = 0`.)
- **R3 — `totalShares == 0` consumes nothing.** With no members, nothing streams and no funds leave
  `unstreamed`. Money never streams into the void, and a pool created before its members are set loses nothing.
- **R4 — a pause is not a freeze.** `setRate(0)` (D8) stops accrual with funds still available;
  `fundedUntil` then reports `type(uint64).max` because nothing is being consumed. A freeze is
  `available == 0` with a non-zero rate. The UI distinguishes them (`poolStatus` in the SDK).
- **R5 — every floor favours the pool.** `owed` grows by the full `streamed`, while members collectively
  receive `≤ streamed` (two floors: the index, then each `_settle`). The difference is **dust** that stays in
  `owed` forever. It is bounded: `MAX_TOTAL_SHARES = 1e18` keeps the index truncation below 1 wad
  (1e-18 USDC) per accrual, and each `_settle` loses under 1 wad.
- **R6 — withdrawals move whole units only.** `units = pending / WAD_PER_UNIT`; the sub-unit remainder stays
  in `pending` *and* in `owed`, so it is still the member's and still reserved against the owner.
- **R7 — `lastAccrual` always advances**, including when `dt` was capped to 0. Accrual is never replayed.
- **R8 — `_settle` is idempotent.** Calling it twice at the same `accIndex` credits nothing the second time.
  This is what makes `withdrawForBatch` safe against duplicate entries.

### 4.2 `fundedUntil`

```
fundedUntil(poolId):
  if rate == 0 || totalShares == 0: return type(uint64).max         // nothing is being consumed
  (_, owed) = simulate to now
  from      = max(now, startTime)                                   // after the simulated accrual
  return min(from + (balance * 1e12 − owed) / rate, type(uint64).max)
```

A frozen pool returns exactly `now` (`DripPoolViewsTest.test_FundedUntil_IsNowWhenFrozen`), which is what the
web app renders as "frozen". `runwaySeconds = fundedUntil − now`, saturating at 0.

## 5. Worked example

One pool, three members, a re-weight, a freeze, a batch payout and a resume. Every number below is exact
integer arithmetic; it was produced by running the block in §4 and matches the contract.

Setup at `t0`:

- `ratePerSecond = 1e15` wad/s = 0.001 USDC/s = **86.4 USDC/day** (2592 USDC per 30-day month).
- `setSharesBatch([A, B, C], [1, 1, 2])` → `totalShares = 4`.
- `deposit(10 USDC)` → `balance = 10_000_000` units = `1e19` wad.
- Runway: `1e19 / 1e15 = 10_000 s` → `fundedUntil = t0 + 10000` (2 h 46 min 40 s).

**`t0 + 3600` — the owner re-weights C from 2 to 5 shares.** `setShares` accrues first:

| | wad | USDC |
|---|---|---|
| `dt` | `min(3600, 1e19/1e15 = 10000) = 3600` | |
| `streamed` | `1e15 × 3600 = 3.6e18` | 3.6 |
| `accIndex` | `+ 3.6e18 × 1e18 / 4 = 9e35` | |
| `owed` | `3.6e18` | 3.6 |

Then `_settle(C)` moves `2 × 9e35 / 1e18 = 1.8e18` wad into `C.pending` and sets `C.index = 9e35`; only then
does `C.shares` become 5 and `totalShares` become 7. A and B are untouched — their entitlement is still read
off the same `accIndex` they never wrote to.

| member | shares | index | pending (wad) | entitlement (wad) | claimable (units) |
|---|---|---|---|---|---|
| A | 1 | 0 | 0 | 9.0e17 | 900_000 (0.90 USDC) |
| B | 1 | 0 | 0 | 9.0e17 | 900_000 (0.90 USDC) |
| C | 5 | 9e35 | 1.8e18 | 1.8e18 | 1_800_000 (1.80 USDC) |

C's re-weight did **not** back-pay: the 3600 s before it were priced at 2/4, the seconds after it at 5/7.

**`t0 + 10000` — the pool freezes.** Nothing is called; the freeze is implicit. Anyone reading at
`t0 + 20000` gets the same answer as at `t0 + 10000`:

```
available = 1e19 − 3.6e18 = 6.4e18 ;  dt = min(16400, 6400) = 6400   // capped: the freeze
streamed  = 6.4e18 ;  accIndex += 6.4e18 × 1e18 / 7
accIndex  = 1_814_285_714_285_714_285_714_285_714_285_714_285 ;  owed = 1e19 = balance × 1e12
```

`owed == balance × 1e12` exactly: invariant I2 is tight, the pool owes every unit it holds and not one more.

| member | entitlement (wad) | claimable (units) |
|---|---|---|
| A | 1_814_285_714_285_714_285 | 1_814_285 (1.814285 USDC) |
| B | 1_814_285_714_285_714_285 | 1_814_285 |
| C | 6_371_428_571_428_571_428 | 6_371_428 (6.371428 USDC) |
| **Σ** | **9_999_999_999_999_999_998** | 9_999_998 |

`owed − Σ entitlement = 2 wad = 2e-18 USDC`. That is the whole dust after two accruals and three settles —
well inside the R5 bound — and it is stuck in `owed` forever (I1).

**`t0 + 20000` — `withdrawForBatch([A, B, C])`.** One `_accrue` (streams nothing, the pool is frozen), then
three payouts of the floored units above: 1_814_285 + 1_814_285 + 6_371_428 = **9_999_998 units**.
Afterwards `balance = 2` units and `owed = 2e12` wad: the three sub-unit remainders
(714285714285 + 714285714285 + 571428571428 wad) plus the 2 wad of dust. Still exactly backed.

**`t0 + 30000` — `deposit(5 USDC)` resumes the stream.** The 20 000 frozen seconds are **not** back-paid (R2):
`_accrue` at the deposit runs with `available == 0`, streams `dt = 0`, and only moves `lastAccrual` to
`t0 + 30000`. Then `balance = 5_000_002` units and the new runway is
`(5_000_002e12 − 2e12) / 1e15 = 5000 s` → `fundedUntil = t0 + 35000`.

**`t0 + 33600` — one hour later.** `streamed = 3.6e18` again, split 1 : 1 : 5:

| member | pending (wad) | entitlement (wad) | claimable (units) |
|---|---|---|---|
| A | 714_285_714_285 | 514_286_428_571_428_570 | 514_286 (0.514286 USDC) |
| B | 714_285_714_285 | 514_286_428_571_428_570 | 514_286 |
| C | 571_428_571_428 | 2_571_429_142_857_142_856 | 2_571_429 |

`owed = 3_600_002_000_000_000_000`, Σ entitlement = `3_600_001_999_999_999_996`, dust = **4 wad**.
`unstreamed = balance − ceil(owed/1e12) = 5_000_002 − 3_600_002 = 1_400_000` units — exactly what the owner
could sweep or would be refunded by `cancel`, and not a unit more.

Note the sub-unit remainders survived the withdrawal and were carried forward: nothing was rounded away from
a member, it was only rounded *down* at the moment of transfer.

## 6. Functions

`nonReentrant` is applied to every function that moves tokens: `deposit`, `withdraw`, `withdrawFor`,
`withdrawForBatch`, `withdrawUnstreamed`, `cancel`. Transfers use OZ `SafeERC20`, and the batch uses
`SafeERC20.trySafeTransfer`, the non-reverting variant with the same acceptance rule (success, and either
empty return data or `true`), reported as a bool. All of them follow CEI: state is written, the event is
emitted, and the transfer is the last statement.

| Function | Caller | Behaviour | Errors |
|---|---|---|---|
| `createPool(owner, ratePerSecond, startTime, name) → poolId` | anyone | `owner != 0`, `rate ≤ MAX_RATE`, `startTime == 0` means now, otherwise `≥ now`. `lastAccrual = now`. `name` only emitted | `ZeroAddress`, `BadRate`, `BadStartTime` |
| `deposit(poolId, amount)` | anyone | live pool, `amount > 0`; `_accrue`; `balance += amount`; `safeTransferFrom` | `PoolNotFound`, `PoolCancelled`, `ZeroAmount` |
| `setRate(poolId, rate)` | owner | live pool, `rate ≤ MAX_RATE`; `_accrue` at the **old** rate; set. `0` = pause | `PoolNotFound`, `NotOwner`, `PoolCancelled`, `BadRate` |
| `setShares(poolId, member, shares)` | owner | live pool, `member != 0`, `member != address(this)`, `shares ≤ MAX_SHARES`, value must differ; `_accrue`, `_settle(member)`, update `totalShares` (`≤ MAX_TOTAL_SHARES`) | + `ZeroAddress`, `BadPayout`, `BadShares`, `NoOp` |
| `setSharesBatch(poolId, members[], shares[])` | owner | same checks per entry, `n ≤ MAX_BATCH`, equal lengths, **one** `_accrue`; duplicates allowed (last wins); an entry equal to the current value is skipped silently instead of reverting `NoOp` | + `ZeroAddress`, `BadPayout`, `BadShares`, `LengthMismatch`, `TooManyItems` |
| `setPayoutAddress(poolId, to)` | any address | pool must exist (cancelled is fine); `to != address(this)`; `0` resets to self. Stored even for an address with no shares | `PoolNotFound`, `BadPayout` |
| `withdraw(poolId) → units` | member | `_accrue`, `_settle`; `units = pending / 1e12`; `pending −= units×1e12`; `owed −= units×1e12`; `balance −= units`; transfer to payout-or-self | `PoolNotFound`, `NothingToWithdraw` |
| `withdrawFor(poolId, member) → units` | anyone | identical; funds go to the member's payout address, **never** to the caller | same |
| `withdrawForBatch(poolId, members[]) → total` | anyone | `n ≤ MAX_BATCH`, one `_accrue`; per member: floor the (unsettled) entitlement to units, `0 → skip **before** `_settle`, so a poke that pays nothing writes nothing`; else `_settle`; else write state and `trySafeTransfer`; on failure restore `pending` / `owed` / `balance` and emit `WithdrawSkipped`. Never reverts because of one member. Works on frozen and cancelled pools | `PoolNotFound`, `TooManyItems` |
| `withdrawUnstreamed(poolId, amount, to)` | owner | live pool, `to != 0`, `to != address(this)`, `amount > 0`; `_accrue`; `amount ≤ balance − ceilDiv(owed, 1e12)`; `balance −= amount`; transfer | + `ZeroAddress`, `BadPayout`, `ZeroAmount`, `InsufficientUnstreamed` |
| `cancel(poolId, to) → refund` | owner | live pool, `to != 0`, `to != address(this)`; `_accrue`; `rate = 0`; `cancelled = true`; refund `balance − ceilDiv(owed, 1e12)` (may be 0, then no transfer). Terminal: a second `cancel` reverts `PoolCancelled` | + `ZeroAddress`, `BadPayout` |
| `transferPoolOwnership(poolId, newOwner)` | owner | `newOwner != 0`; sets `pendingOwner` (overwritable). Allowed on cancelled pools | `PoolNotFound`, `NotOwner`, `ZeroAddress` |
| `acceptPoolOwnership(poolId)` | pendingOwner | promotes the caller, clears `pendingOwner` | `PoolNotFound`, `NotPendingOwner` |

Views — all revert `PoolNotFound` for an unknown pool, none mutate state:

| View | Returns |
|---|---|
| `getPool(poolId)` | the stored `Pool` (values as of the last accrual, **not** simulated to now) |
| `getMember(poolId, member)` | the stored `Member`; an unknown address reads back as all-zero |
| `claimable(poolId, member)` | USDC **units** withdrawable right now: simulated accrue + settle, floored |
| `fundedUntil(poolId)` | timestamp of the freeze; `type(uint64).max` when nothing is being consumed |
| `unstreamed(poolId)` | USDC units the owner may sweep: `balance − ceilDiv(simulated owed, 1e12)`, floored at 0 |

`getPool` returns raw storage on purpose: the SDK's `math.ts` replays §4 offchain from exactly those fields,
which is what lets the UI tick per second with no RPC call. `claimable` exists for callers that want the
chain's own answer; the two are asserted bit-identical over ≥ 30 vectors (§8).

### 6.1 What the owner can and cannot do

| Owner action | Effect on a member's already-accrued amount | Effect on the future |
|---|---|---|
| `setRate(0)` (pause) | none — accrual happens first | stream stops until `setRate` is called again |
| `setShares(other, x)` | none | re-prices every member from that second on |
| `setShares(member, 0)` (remove) | none: `pending` stays withdrawable forever, on a cancelled pool too | that member stops accruing |
| `withdrawUnstreamed` | none — bounded by `balance − ceil(owed/1e12)` | shortens the runway |
| `cancel` | none — members withdraw forever after | stream ends permanently |
| ownership transfer | none | new owner gets the same powers |

This is the whole of D8: **the owner controls the future, never the past.** Invariant I4 tests exactly that.

### 6.2 The exact reading of I4

I4 in PRD §4.5 is written as "no owner action ever decreases any member's `claimable`". Taken to the wad,
that is one wad stronger than the contract, and PRD §4.5 **I1** already says so: I1 budgets a gap of
`accrualCount × 1 wad + memberSettleCount × 1 wad`. Both floors are real and they interact with I4:

- **The settle floor.** `pending += shares × (accIndex − index) / 1e18` floors. A sum of two floors can be
  strictly smaller than the floor of the sum, so an *extra* settle costs the member up to 1 wad
  (1e-18 USDC), which stays in `owed` as dust nobody can reach. `setShares` on *another* member settles
  everyone it touches, so the owner has this lever.
- **The accrual floor.** `accIndex += streamed × 1e18 / totalShares` floors. An *extra* accrual costs the
  pool up to 1 wad in the same way. Every state-changing function accrues, including permissionless ones
  (`deposit`, `withdrawFor`, `withdrawForBatch`), so this one is not an owner power at all — it is the
  ordinary cost of the pool being used, and it is exactly I1's `accrualCount` term.

What this is worth: at a whole-unit boundary a lost wad can move `claimable` down by one USDC unit
(1e-6 USDC), and it takes about 1e12 forced events to destroy 1e-6 USDC. Nobody gains from it — the wad is
destroyed inside `owed`, not transferred — so it is griefing that costs the griefer gas and pays them
nothing. What I4 protects absolutely, and what the tests assert, is the part that matters: **earned funds
are never moved to another address, and the owner's sweeps are bounded by `ceilDiv(owed, 1e12)`.**

One lever was gratuitous and is closed: `withdrawForBatch` is permissionless and, by D15, does not revert on
a member with nothing to pay. It used to `_settle` that member anyway. It now computes the payable units
from the unsettled state and `continue`s before writing, so a third party can no longer force the settle
floor onto an arbitrary address — and the skipped member costs the batch no `SSTORE`.
Regression: `contracts/test/unit/DripPoolGriefing.t.sol`.

## 7. Events and errors

```solidity
event PoolCreated(uint256 indexed poolId, address indexed owner, uint256 ratePerSecond, uint64 startTime, string name);
event Deposited(uint256 indexed poolId, address indexed from, uint256 amount);
event RateSet(uint256 indexed poolId, uint256 oldRate, uint256 newRate);
event SharesSet(uint256 indexed poolId, address indexed member, uint256 oldShares, uint256 newShares, uint256 totalShares);
event PayoutAddressSet(uint256 indexed poolId, address indexed member, address to);
event Withdrawn(uint256 indexed poolId, address indexed member, address indexed to, uint256 amount, address caller);
event WithdrawSkipped(uint256 indexed poolId, address indexed member, uint256 amount);
event UnstreamedWithdrawn(uint256 indexed poolId, address indexed to, uint256 amount);
event Cancelled(uint256 indexed poolId, address indexed to, uint256 refund);
event OwnershipTransferStarted(uint256 indexed poolId, address indexed owner, address indexed pendingOwner);
event OwnershipTransferred(uint256 indexed poolId, address indexed oldOwner, address indexed newOwner);
```

Every input to the accrual block has an event, so an indexer can rebuild any pool's exact state by replaying
`PoolCreated` (rate, startTime), `Deposited` (balance), `RateSet` (rate), `SharesSet` (shares, totalShares),
`Withdrawn` / `UnstreamedWithdrawn` / `Cancelled` (balance) and feeding them to the SDK's `math.ts`.
`cancel` zeroes the rate, so it emits `RateSet(poolId, oldRate, 0)` immediately before `Cancelled` (skipped
when the pool was already paused and the rate was already 0) — an indexer needs no special case for it. One
reading rule remains: `WithdrawSkipped` means *nothing moved* — the member's balance is unchanged, not paid.

All amounts in events are USDC units except `RateSet` / `PoolCreated`, which carry wad/s.

| Error | Raised when |
|---|---|
| `PoolNotFound` | `pools[poolId].owner == 0` (never created) |
| `NotOwner` / `NotPendingOwner` | wrong caller on an owner / pending-owner function |
| `PoolCancelled` | any owner write or a `deposit` on a cancelled pool |
| `ZeroAddress` | zero `owner`, `member`, `to` (also a zero USDC address in the constructor) |
| `ZeroAmount` | `deposit(0)`, `withdrawUnstreamed(0)` |
| `BadRate` | `ratePerSecond > MAX_RATE` |
| `BadShares` | `shares > MAX_SHARES`, or the resulting `totalShares > MAX_TOTAL_SHARES` |
| `BadStartTime` | `startTime != 0 && startTime < block.timestamp` |
| `BadPayout` | any payout destination equal to `address(this)`: `setPayoutAddress`, `setShares` / `setSharesBatch` (the singleton may not be enrolled as a member), `withdrawUnstreamed(…, to)`, `cancel(…, to)`. Paying the singleton is a no-op self-transfer that would debit `balance` and destroy the units |
| `NoOp` | `setShares` to the value already stored (batch skips instead) |
| `NothingToWithdraw` | `withdraw` / `withdrawFor` with less than one whole unit accrued |
| `InsufficientUnstreamed` | `withdrawUnstreamed` above `balance − ceilDiv(owed, 1e12)` |
| `LengthMismatch` | `setSharesBatch` arrays of different lengths |
| `TooManyItems` | batch longer than `MAX_BATCH` |

## 8. Invariants

Checked by the Foundry invariant suite (handler with ≥ 5 actors and ≥ 3 pools) and, where noted, by the fuzz
suite against an exact-rational reference model. Target: ≥ 256 runs × depth 100.

| # | Statement | Why it holds | Where it is proved |
|---|---|---|---|
| **I1** | For every pool, `Σ_m (pending_m + shares_m × (accIndex − index_m) / 1e18) ≤ owed`, and the gap is `≤ accrualCount + memberSettleCount` wad | two floors per accrual path (R5); `MAX_TOTAL_SHARES` bounds the index truncation to < 1 wad | `DripPoolInvariantTest.invariant_I1_owedCoversEveryMember` (handler ghosts `ghostAccruals` / `ghostSettles`); §5 shows 2 wad after 2 accruals + 3 settles |
| **I2** | For every pool, `owed ≤ balance × 1e12` | `dt` is capped at `available / rate` with `available = balance×1e12 − owed`; every withdrawal decrements `owed` and `balance` by the same wad amount | `DripPoolInvariantTest.invariant_I2_owedWithinBalance`; `DripPoolViewsTest.test_Claimable_StopsGrowingAtTheFreeze` |
| **I3** | `Σ pools[i].balance ≤ usdc.balanceOf(DripPool)` | balance only grows by a completed `transferFrom` and only shrinks with an outgoing transfer of the same size. Direct donations make it strictly `<` | `DripPoolInvariantTest.invariant_I3_backedByTokens`; `DripPoolDepositTest.test_Deposit_DirectTransfersAreIgnored` |
| **I4** | No action, by the owner or anyone else, ever moves a member's earned funds to another address, and no action decreases a member's `claimable` by more than the I1 dust it triggers (< 1 wad = 1e-18 USDC per accrual and per settle) | every owner write runs `_accrue` (and `_settle` for the member it touches) before mutating; sweeps are bounded by `ceilDiv(owed)`; `withdrawForBatch` skips a member with nothing payable *before* settling, so a permissionless poke cannot force the settle floor on anyone (see §6.2) | `DripPoolInvariantTest.invariant_I4_ownerNeverReducesClaimable`; `DripPoolOwnerFundsTest.test_WithdrawUnstreamed_LeavesEveryMemberWhole`, `test_Cancel_MembersKeepWithdrawingForever`, `DripPoolSharesTest.test_SetShares_DoesNotTouchOtherMembersStorage`, `DripPoolOwnershipTest.test_Transfer_DoesNotChangeClaimable` |
| **I5** | Total paid to a member over any history is `≤ Σ_intervals rate × dt × shares/totalShares` in exact rational arithmetic | every rounding step floors | `DripPoolFuzzTest.testFuzz_OpSequenceNeverOverPays` vs `contracts/test/fuzz/RationalAcc.sol` |

I1–I5 are the acceptance gate in PRD §10.1. They live in `contracts/test/invariant/DripPool.invariant.t.sol`
(with the handler and its ghost counters in `DripPoolHandler.sol`) and `contracts/test/fuzz/DripPoolFuzz.t.sol`
(with the exact-rational reference model in `RationalAcc.sol`). The unit tests listed alongside them cover the
same statements case by case.

## 9. SDK mirror (`@arcdrip/sdk`)

`packages/sdk/src/math.ts` is an independent bigint implementation of §4, written from this spec rather than
from the contract (PRD §12, phase 1). Contract and mirror are cross-checked by
`contracts/test/vectors/AccrualVectors.t.sol`, which exports ≥ 30 states to
`contracts/test/vectors/accrual.json`; `packages/sdk/test/vectors.test.ts` asserts each one bit-identically
(`claimable`, `fundedUntil`, `unstreamed`). A mismatch is resolved against §4, never by copying either side.

Surface: `accrue`, `settle`, `accrueAndSettle`, `claimable`, `fundedUntil`, `runwaySeconds`, `unstreamed`,
`previewWithdraw`, `previewDeposit`, `poolStatus` (`scheduled | streaming | paused | frozen | cancelled`),
plus `rate.ts` (`toRatePerSecond`, `fromRatePerSecond`, `memberRate`, `parseUsdc`, `formatUsdc`) and Zod
schemas that parse decimal strings into bigints. The mirror functions never mutate their inputs, so the UI can
call them once per animation frame on the last state read from the chain.

Around the mirror the package ships `actions.ts` (viem reads and writes, simulating first and decoding the
custom errors of §7 into typed results), `members.ts` (member discovery from `SharesSet` logs, chunked at
10 000 blocks for Arc's public RPC cap), `erc20.ts`, `errors.ts`, `logger.ts` (pino with an optional
`correlationId`) and the ABI generated from the Foundry output and checked for drift in CI.

## 10. Deployment

One immutable singleton per chain, constructor arg `usdc`. CREATE2 salt `keccak256("arcdrip.v1")`, recorded in
`deployments/arc-{mainnet,testnet}.json`, verified on Sourcify (exact match). No admin key, no proxy, no
`receive()` — the contract cannot hold native value and has no upgrade path. See [`../DEPLOY.md`](../DEPLOY.md)
and [`../CHECKLIST.md`](../CHECKLIST.md).

## 11. Known divergences from the PRD

Recorded rather than papered over. None of them changes behaviour that PRD §4 pins down.

1. **Batch transfer helper.** PRD §4.3 says the batch uses "a raw call through an internal helper that returns
   success". The contract uses OZ `SafeERC20.trySafeTransfer`, which applies the same acceptance rule as
   `safeTransfer` and returns a bool. Same semantics, less hand-written assembly.
2. **Guards the PRD table omits but the error list implies.** `withdrawUnstreamed` rejects `amount == 0` and
   `to == 0`; `cancel` rejects `to == 0`; `createPool` rejects a zero USDC address in the constructor. These
   use `ZeroAmount` / `ZeroAddress` from §4.4.
3. **`fundedUntil` saturation.** PRD §4.2 does not say what happens when `from + available/rate` overflows
   `uint64`; the contract saturates at `type(uint64).max` rather than reverting
   (`DripPoolViewsTest.test_FundedUntil_SaturatesAtUint64Max`).
4. **`setPayoutAddress` on a cancelled pool** is allowed (PRD §4.3 is silent). It has to be: a blocklisted
   member must be able to redirect a payout after a cancel, and D8 says accrued funds stay withdrawable
   forever.
5. **Three gas targets in PRD §4.6 are missed**, by 3–12k gas on `deposit`, `setShares` (new member) and
   `withdraw` / `withdrawFor`; `createPool` and `withdrawForBatch` per member are inside. Each miss is traced
   to a specific storage write in [`GAS.md`](./GAS.md), which is the published measurement. A `withdraw`
   costs ≈ 0.00215 USDC at 20 gwei against the PRD's "≈ 0.002".
6. **The fork suite does not exercise `deposit` / `withdraw`.** `contracts/test/fork/ArcUsdc.fork.t.sol`
   exists and runs against Arc state when `ARC_TESTNET_RPC` is set (it is skipped otherwise, which is why
   `forge test` reports 4 skipped tests locally), but Arc's USDC delegates `transfer` / `transferFrom` to a
   node-side precompile at `0x1800…0000` that a local fork cannot execute, so the token-moving part of the
   test is guarded and logs `SKIPPED`. This settles PRD §14's third open question as **mock-only** for now
   (see [`THREATS.md`](./THREATS.md) §22).
7. **`contracts/test/gas/`** is an extra directory next to the `test/{unit,fuzz,invariant,fork,mocks,vectors}`
   layout of PRD §11; it holds the measurements behind `GAS.md`.
