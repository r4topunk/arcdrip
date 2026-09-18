# SharedArc threat model

> Every row of [`PRD.md`](../PRD.md) §7, in the same order (§1–§14), then threats found during the build that
> §7 does not list (§15–§19), then what SharedArc explicitly does **not** protect against (§21).
> "Test" names real tests: Foundry as `Contract.function` under `contracts/test/…`, Vitest by file and test
> title. Where a test does not exist yet, the row says so instead of implying coverage.
> Mechanics referenced here are specified in [`SPEC.md`](./SPEC.md).

Standing assumptions: `usdc` is the Arc USDC at `0x3600…0000` (6 decimals, FiatTokenV2_2-like, blocklist, no
transfer hooks), fixed at deploy in an `immutable`; the contract is immutable, has no admin key, no proxy and
no `receive()`; a pool owner may be an EOA, a Safe or a DAO and is trusted with *future* funds only.

## 1. Owner rug of earned funds

| | |
|---|---|
| **Threat** | The pool owner drains USDC that members have already streamed, by sweeping, cancelling, re-weighting to zero, or transferring ownership to themselves twice. |
| **Why it matters** | This is the only way SharedArc could lose a contributor real money. Everything else is an availability problem. If the owner can take back earned pay, the product has no reason to exist. |
| **Handling** | `owed` is the reserve and nothing may cross it. `withdrawUnstreamed` and `cancel` both compute the payable amount as `balance − ceilDiv(owed, 1e12)` (`DripPool._unstreamed`) — a **ceiling**, so a fraction of a unit that is still owed is never handed to the owner. Both call `_accrue` first, so the reserve already includes everything streamed up to that block. `setShares(m, 0)` settles `m` before zeroing (`_setShares` → `_settle`), leaving `pending` intact and withdrawable forever, on a cancelled pool too. `setRate(0)` accrues at the old rate first. A member's `pending` can only ever decrease inside `_withdraw` / `withdrawForBatch`, which pay that member's own payout address. Invariant **I4** states it as a property: no owner action decreases any member's `claimable`. |
| **Residual risk** | None on the past. The owner keeps full control of the future (§2). Dust below 1 unit cannot be withdrawn by the member either — it sits in `owed` and is unreachable by both sides. |
| **Enforced in** | `DripPool._unstreamed`, `withdrawUnstreamed`, `cancel`, `_setShares`, `setRate`, `_accrue` ordering (SPEC §4.1 R1) |
| **Test** | `contracts/test/unit/DripPoolOwnerFunds.t.sol`: `DripPoolOwnerFundsTest.test_WithdrawUnstreamed_LeavesEveryMemberWhole`, `test_WithdrawUnstreamed_AtTheExactBound`, `test_WithdrawUnstreamed_CeilDivProtectsAFractionOfAUnit`, `test_WithdrawUnstreamed_RevertsAboveBound`, `test_WithdrawUnstreamed_AccruesFirst`, `test_Cancel_RefundsTheUnstreamedPart`, `test_Cancel_MembersKeepWithdrawingForever`, `test_Cancel_WithNothingOwed`; `contracts/test/unit/DripPoolShares.t.sol`: `DripPoolSharesTest.test_SetShares_LeaveMidStreamKeepsAccrued`; `contracts/test/unit/DripPoolDeposit.t.sol`: `DripPoolDepositTest.test_SetRate_ZeroPausesAndPreservesAccrued`; `contracts/test/unit/DripPoolScenarios.t.sol`: `DripPoolScenariosTest.test_Scenario_WithdrawAfterCancel`. `contracts/test/invariant/DripPool.invariant.t.sol`: `DripPoolInvariantTest.invariant_I4_ownerNeverReducesClaimable` (I4). |

## 2. Owner rug of future funds

| | |
|---|---|
| **Threat** | The owner pauses, re-weights a contributor down to zero, sweeps the unstreamed balance or cancels the pool, so a member who expected N more months of pay gets nothing. |
| **Why it matters** | A reviewer will ask "so the owner can just stop paying me?". The honest answer is yes, and pretending otherwise would be the real vulnerability. |
| **Handling** | **Accepted and documented, by design (D8).** SharedArc is payroll, not an escrow or a vesting contract: an employer can stop paying. Members are protected for the past, never for the future. There is no cliff, no minimum duration, no timelock on `setRate` / `setShares` / `cancel`. What the protocol does guarantee is transparency: every change emits an event (`RateSet`, `SharesSet`, `UnstreamedWithdrawn`, `Cancelled`), the runway is a public view (`fundedUntil`), and the app shows it. A collective that wants stronger guarantees puts a Safe with a timelock, or a DAO, in the `owner` slot (D4) — the contract treats any address the same. |
| **Residual risk** | Full. A malicious owner can reduce the future stream to zero in one transaction. Mitigation is social/organisational (who holds the owner key), not cryptographic. |
| **Enforced in** | Not a code path; an explicit non-guarantee. Events + `fundedUntil` make it observable. |
| **Test** | `contracts/test/unit/DripPoolOwnerFunds.t.sol`: `DripPoolOwnerFundsTest.test_Cancel_StopsAccrual`, `test_WithdrawUnstreamed_SweepsFreeFunds`; `contracts/test/unit/DripPoolDeposit.t.sol`: `DripPoolDepositTest.test_SetRate_ZeroPausesAndPreservesAccrued` (shows the future stops, the past does not). |

## 3. Insolvency — the last withdrawer finds an empty pool

| | |
|---|---|
| **Threat** | The pool streams more than it holds; members withdraw first-come-first-served and the last one reverts, or the contract's USDC balance goes negative against another pool's funds. |
| **Why it matters** | This is the classic streaming-protocol failure (Sablier/LlamaPay need cancel-on-insolvency or liquidation bots). A shared pool with one balance would be the obvious place to reproduce it. |
| **Handling** | Made impossible in `_accrueMath`: `dt = min(now − from, available / rate)` where `available = balance × 1e12 − owed`. Because `rate` and `totalShares` are constant between two accruals (R1: every writer accrues before mutating), that cap is exactly "streaming stopped the second the money ran out", so `owed ≤ balance × 1e12` always — invariant **I2**. The pool **freezes** by itself and resumes on the next deposit from the deposit's own timestamp (R2, no back-pay). Withdrawals decrement `owed` and `balance` by the same amount, so the inequality is preserved. No keeper, no liquidation, no solvency check at withdrawal time. Per-pool isolation plus I3 means one pool can never spend another's balance. |
| **Residual risk** | Members are paid only for funded time; a pool that is empty for a month pays nothing for that month (that is the intended semantics, not a loss). |
| **Enforced in** | `DripPool._accrueMath` (the `dt` cap), `_withdraw`, `withdrawForBatch` |
| **Test** | `contracts/test/unit/DripPoolViews.t.sol`: `DripPoolViewsTest.test_Claimable_StopsGrowingAtTheFreeze`, `test_FundedUntil_IsNowWhenFrozen`; `contracts/test/unit/DripPoolScenarios.t.sol`: `DripPoolScenariosTest.test_Scenario_FreezeThenDepositWithoutBackPay`, `test_Scenario_OnePoolPaysFourMembersToTheLastUnit`; `contracts/test/unit/DripPoolDeposit.t.sol`: `DripPoolDepositTest.test_Deposit_ResumesFromDepositTimestamp`; `contracts/test/unit/DripPoolWithdraw.t.sol`: `DripPoolWithdrawTest.test_Withdraw_WorksAfterFreeze`; `contracts/test/unit/DripPoolBatch.t.sol`: `DripPoolBatchTest.test_Batch_WorksWhenFrozen`; `packages/sdk/test/math.test.ts`: "caps dt at available / rate: this is the freeze", "never back-pays frozen time after a deposit". `contracts/test/invariant/DripPool.invariant.t.sol`: `DripPoolInvariantTest.invariant_I2_owedWithinBalance` (I2). |

## 4. Rounding drift pays members more than was streamed

| | |
|---|---|
| **Threat** | Integer division rounds a member's slice *up* somewhere, so `Σ members' claims > owed`, and the surplus is stolen from the pool's unstreamed balance or from another member. |
| **Why it matters** | An index-based split has two divisions per accrual path (index, then per-member settle) plus a third at payout. One misplaced rounding direction silently breaks I2 and re-opens §3. |
| **Handling** | **Every division floors and every floor favours the pool** (R5). `accIndex += streamed × 1e18 / totalShares` floors; `pending += shares × (accIndex − index) / 1e18` floors; `units = pending / 1e12` floors at payout. `owed` is credited the **full** `streamed`, so the truncated remainder stays inside `owed` as dust that nobody can withdraw. `MAX_TOTAL_SHARES = 1e18` keeps the index truncation below 1 wad (1e-18 USDC) per accrual, and each settle loses under 1 wad, which is invariant **I1**'s bound. The one *ceiling* in the contract is deliberately on the other side: `_unstreamed` rounds `owed` up before subtracting, so rounding never favours the owner either. Worked numbers in SPEC §5: 2 wad of dust after two accruals and three settles. |
| **Residual risk** | Dust accumulates in `owed` forever and is unrecoverable by anyone — a deliberate trade (D8/R5). At 1e-18 USDC per accrual it is unreachable as an economic attack even with millions of accruals. It is also the exact sense in which **I4 is a bound rather than an equality**: an extra accrual or an extra settle costs a member under 1 wad, which at a whole-unit boundary can show up as one USDC unit less `claimable`. The wad is destroyed, never transferred, so a griefer pays gas and gains nothing, and ~1e12 forced events are needed to destroy 1e-6 USDC. `withdrawForBatch` no longer settles a member it pays nothing (§20), which removes the only *free* permissionless lever on the settle floor; the accrual floor stays, because every ordinary use of the pool accrues. Full reasoning in docs/SPEC.md §6.2. |
| **Enforced in** | `_accrueMath`, `_settle`, `_withdraw`, `withdrawForBatch`, `_unstreamed` |
| **Test** | `contracts/test/unit/DripPoolBounds.t.sol`: `DripPoolBoundsTest.test_MaxTotalShares_AccrualDustStaysBelowOneWad`, `test_SmallestUsefulRate`, `test_LargeBalanceAndLongHorizon`; `contracts/test/unit/DripPoolScenarios.t.sol`: `DripPoolScenariosTest.test_Scenario_DustStaysInThePoolForever`, `test_Scenario_OneUsdcPerMonthOverAYear`, `test_Scenario_OneUsdcPerMonthClaimedDaily`, `test_Scenario_OnePoolPaysFourMembersToTheLastUnit`; `contracts/test/unit/DripPoolWithdraw.t.sol`: `DripPoolWithdrawTest.test_Withdraw_KeepsSubUnitDust`; `contracts/test/unit/DripPoolViews.t.sol`: `DripPoolViewsTest.test_Claimable_FloorsToWholeUnits`, `test_Claimable_IncludesWithdrawnRemainder`; `packages/sdk/test/math.test.ts`: "floors every member share", "truncates sub-unit pending to zero USDC units". `contracts/test/invariant/DripPool.invariant.t.sol`: `DripPoolInvariantTest.invariant_I1_owedCoversEveryMember` (I1, with the handler's floor counters); `contracts/test/fuzz/DripPoolFuzz.t.sol`: `DripPoolFuzzTest.testFuzz_OpSequenceNeverOverPays` (I5, against the exact-rational `RationalAcc` model). |

## 5. Blocklisted member

| | |
|---|---|
| **Threat** | Circle blocklists a member's address (FiatToken `blacklist`). Any `usdc.transfer` to it reverts. If that transfer sits inside a shared call, one blocked address stalls payroll for the whole collective. |
| **Why it matters** | Arc's USDC is the real FiatTokenV2_2 with a live blocklist, and "Pay everyone" is the product's headline button. A single blocked member must not be able to brick it — deliberately or by accident. |
| **Handling** | Payouts are **pulls, one member at a time** (D5). `withdraw` / `withdrawFor` touch exactly one member, so a blocked member's failure is their own and nobody else's. `withdrawForBatch` wraps each transfer in `SafeERC20.trySafeTransfer`: on a revert or a `false` return it restores that member's `pending` and the pool's `owed` and `balance`, emits `WithdrawSkipped(poolId, member, amount)` and continues (D15). The skipped member loses nothing — their claim is exactly where it was. They can then call `setPayoutAddress(poolId, fresh)` (allowed for any address, with or without shares, live or cancelled) and be paid to the new address, by themselves or by anyone via `withdrawFor`. |
| **Residual risk** | A member blocked *and* unable to move to a fresh address stays unpaid; their funds remain reserved in `owed` indefinitely and are not recoverable by the owner (§1's guarantee cuts both ways). `WithdrawSkipped` is the signal an operator must watch — the batch's return value counts only what actually moved. |
| **Enforced in** | `withdrawForBatch` (try/restore/`WithdrawSkipped`), `setPayoutAddress`, per-member `_withdraw` |
| **Test** | `contracts/test/unit/DripPoolBatch.t.sol`: `DripPoolBatchTest.test_Batch_SkipsBlocklistedMemberAndRestoresState`, `test_Batch_BlocklistedMemberCanBePaidLater`, `test_Batch_SkipsMemberWhoseTokenReturnsFalse`, `test_Batch_RespectsPayoutAddresses`; `contracts/test/unit/DripPoolWithdraw.t.sol`: `DripPoolWithdrawTest.test_WithdrawFor_RevertsWhenPayoutIsBlocklisted`, `test_WithdrawFor_DoesNotStallOtherMembers`, `test_SetPayoutAddress_LetsABlocklistedMemberEscape`, `test_SetPayoutAddress_WorksAfterCancel`. Mock: `contracts/test/mocks/MockUSDC.sol` (`blacklist`, `setReturnsFalse`). **Mock-only**: the fork test exists but cannot move real USDC on a local fork — see §22.1. |

## 6. Malicious payout address (a contract that reverts or reenters)

| | |
|---|---|
| **Threat** | A member sets `payout` to a contract that reverts on receipt, consumes all gas, or reenters `DripPool` during the transfer to withdraw twice or corrupt another pool. |
| **Why it matters** | `withdrawFor` is permissionless, so an attacker can force the call path; and the batch deliberately swallows failures, which is exactly where a reentrancy would be easiest to hide. |
| **Handling** | Four layers. (a) USDC has **no transfer hooks** — `transfer` to a contract does not call it, so there is no callback to reenter from; this is a property of the fixed `usdc` address, not of a generic token. (b) **CEI everywhere**: `pending`, `owed` and `balance` are written and the event emitted *before* the transfer, in `_withdraw` and in the batch's loop body. (c) `nonReentrant` on `deposit`, `withdraw`, `withdrawFor`, `withdrawForBatch`, `withdrawUnstreamed`, `cancel`. (d) `setPayoutAddress` rejects `address(this)`, so a payout can never be the pool contract itself. A reverting payout only fails that member's own withdrawal (and is skipped inside a batch, §5). Gas griefing inside a batch is bounded by the caller's gas limit and by `MAX_BATCH = 100`. |
| **Residual risk** | If a future deployment pointed `usdc` at a hook-bearing token, (a) would be gone and only (b)–(c) would remain; that is why `usdc` is immutable and the contract is documented as USDC-specific (§12). A payout contract that burns all forwarded gas can make a batch entry fail — it fails *closed*, restoring state. |
| **Enforced in** | `ReentrancyGuard` modifiers, CEI ordering in `_withdraw` / `withdrawForBatch`, `setPayoutAddress` (`BadPayout`) |
| **Test** | `contracts/test/unit/DripPoolWithdraw.t.sol`: `DripPoolWithdrawTest.test_SetPayoutAddress_RevertsOnContractItself`, `test_SetPayoutAddress_RedirectsWithdrawals`, `test_SetPayoutAddress_ZeroResetsToSelf`; `contracts/test/unit/DripPoolBatch.t.sol`: `DripPoolBatchTest.test_Batch_SkipsMemberWhoseTokenReturnsFalse`. **Gap:** there is no reentrancy test with a hostile token or payout contract, because `MockUSDC` has no hooks. See §22. |

## 7. Dust griefing via `withdrawFor`

| | |
|---|---|
| **Threat** | An attacker spams `withdrawFor(poolId, victim)` every block, forcing the victim's accrual to be paid out in sub-unit slices so that rounding eats their balance, or simply to make their position unusable. |
| **Why it matters** | `withdrawFor` is permissionless by design (a member with no gas still gets paid), so anybody can trigger a victim's payout path at will. |
| **Handling** | A withdrawal of less than one whole USDC unit reverts `NothingToWithdraw`, so there is no "pay 0 and reset" path to spam. When the amount is ≥ 1 unit the sub-unit remainder is **kept**: `pending −= units × 1e12` and `owed −= units × 1e12`, so the fraction stays the member's and is still reserved (R6). Repeated withdrawals therefore lose the member nothing at all — `test_Claimable_IncludesWithdrawnRemainder` shows the remainder still counted afterwards. The funds always go to the member's payout address, never to the caller, so the attacker gains nothing and pays the gas. Inside a batch a sub-unit member is skipped silently rather than reverting the whole call. |
| **Residual risk** | The victim receives many small transfers, which is a bookkeeping annoyance and log noise, not a loss. Under Arc's 20 gwei floor the attacker pays ~0.002 USDC per attempt. |
| **Enforced in** | `_withdraw` (`NothingToWithdraw`, remainder retention), `withdrawForBatch` (skip on `units == 0`, evaluated *before* `_settle` so the skipped member's storage is not touched at all) |
| **Test** | `contracts/test/unit/DripPoolWithdraw.t.sol`: `DripPoolWithdrawTest.test_Withdraw_RevertsBelowOneUnit`, `test_Withdraw_KeepsSubUnitDust`, `test_Withdraw_TwiceInSameBlockReverts`, `test_WithdrawFor_IsPermissionlessAndPaysTheMember`, `test_WithdrawFor_RevertsWhenNothingAccrued`; `contracts/test/unit/DripPoolBatch.t.sol`: `DripPoolBatchTest.test_Batch_SkipsSubUnitClaimable`, `test_Batch_SkipsZeroClaimableMemberSilently`, `test_Batch_HandlesDuplicates`; `contracts/test/unit/DripPoolViews.t.sol`: `DripPoolViewsTest.test_Claimable_IncludesWithdrawnRemainder`; `contracts/test/unit/DripPoolGriefing.t.sol`: `DripPoolGriefingTest.test_Batch_PokeThatPaysNothingDoesNotSettleTheMember`, `test_Batch_PokeCostsAtMostTheDocumentedAccrualDust`, `test_WithdrawFor_RevertsInsteadOfSettlingAZeroClaimableMember`, `test_SetShares_OwnerTogglesCostAtMostTheDocumentedDust`. |

## 8. Front-running `setShares` with `withdrawFor`

| | |
|---|---|
| **Threat** | A member sees `setShares(me, lower)` in the mempool and front-runs it with `withdrawFor(me)` (or the owner back-runs a withdrawal) to capture a different amount than intended. |
| **Why it matters** | Both calls are permissionless or owner-triggered and touch the same member's accounting in the same block; if the ordering mattered, payroll would become a mempool race. |
| **Handling** | Ordering is irrelevant because **both paths accrue and settle first** (R1). `setShares` runs `_accrue` then `_settle(member)` before writing the new share count, and `_withdraw` runs `_accrue` then `_settle(member)` before paying. At a given timestamp both compute the member's entitlement from the identical `accIndex`, so the accrued amount is bit-identical whichever transaction lands first. `_settle` is idempotent at a fixed index (R8), so running it twice in one block credits nothing extra. The new share count applies strictly from that second onward. |
| **Residual risk** | None for the accrued amount. Ordinary MEV applies to the *timestamp* (see §9): landing a `setShares` one block earlier or later shifts sub-second amounts. |
| **Enforced in** | `_accrue` + `_settle` ordering in `setShares`, `_setShares`, `_withdraw`, `withdrawForBatch` |
| **Test** | `contracts/test/unit/DripPoolWithdraw.t.sol`: `DripPoolWithdrawTest.test_WithdrawFor_FrontRunningSetSharesIsHarmless`; `contracts/test/unit/DripPoolShares.t.sol`: `DripPoolSharesTest.test_SetShares_ReWeightRepricesFromThatSecond`, `test_SetShares_JoinMidStreamDoesNotBackPay`, `test_SetShares_DoesNotTouchOtherMembersStorage`. |

## 9. Timestamp manipulation

| | |
|---|---|
| **Threat** | A validator or sequencer nudges `block.timestamp` to move value between members, or to make a pool appear funded longer than it is. |
| **Why it matters** | `block.timestamp` is the *only* external input to the accounting; there is no oracle to cross-check it. |
| **Handling** | Bounded by construction. A skew of `s` seconds can only move `rate × s` wad — and it moves it **between members of the same pool in proportion to their shares**, or between "now" and "one accrual later". It can never create value: `owed ≤ balance × 1e12` holds at any timestamp (I2), the total streamed over an interval is still `rate × dt`, and moving the clock forward only brings a freeze closer. `startTime` is validated at creation (`≥ now`) and accrual never starts before it; `from = max(lastAccrual, startTime)` means a backwards-moving clock streams nothing rather than reverting or double-counting (`now > from` is required). At Arc's ~0.5 s blocks and a payroll-sized rate, a plausible skew is worth sub-cent amounts. |
| **Residual risk** | Accepted and documented: sub-cent redistribution inside one pool. Not mitigated in code, and no mitigation is worth its complexity here. |
| **Enforced in** | `_accrueMath` (`now > from` guard, `dt` cap), `_from`, `createPool` (`BadStartTime`) |
| **Test** | `contracts/test/unit/DripPoolCreate.t.sol`: `DripPoolCreateTest.test_CreatePool_FutureStartTime`, `test_CreatePool_StartTimeEqualToNowIsAllowed`, `test_CreatePool_RevertsOnPastStartTime`; `contracts/test/unit/DripPoolScenarios.t.sol`: `DripPoolScenariosTest.test_Scenario_FutureStartTime`; `contracts/test/unit/DripPoolViews.t.sol`: `DripPoolViewsTest.test_FundedUntil_RespectsFutureStartTime`; `packages/sdk/test/math.test.ts`: "holds accrual back until startTime and then streams only from startTime", "is a no-op on accrual when now is not past `from`". |

## 10. Overflow

| | |
|---|---|
| **Threat** | `rate × dt`, `streamed × 1e18`, `shares × (accIndex − index)` or `totalShares` overflows `uint256`/`uint128`, or a cast truncates, corrupting the index for a whole pool. |
| **Why it matters** | Solidity 0.8 reverts on overflow, so the realistic outcome is a **permanently bricked pool** (every accrual reverts) rather than silent theft — still a total loss of availability for that pool's funds. |
| **Handling** | Three explicit caps, checked at every entry point: `MAX_RATE = 1e30` wad/s (`createPool`, `setRate` → `BadRate`), `MAX_SHARES = 1e15` per member and `MAX_TOTAL_SHARES = 1e18` pool-wide (`setShares`, `setSharesBatch`, `_setShares` → `BadShares`). With those, `streamed = rate × dt ≤ 1e30 × dt` and `streamed × 1e18` stays far below `2^256 ≈ 1.16e77` for any timestamp that fits in `uint64`; `accIndex` is bounded by `streamed × 1e18 / totalShares` accumulated over the funded life of the pool, and `shares × (accIndex − index)` by `1e15 ×` that. `dt` is additionally capped by `available / rate`, so an unfunded pool at `MAX_RATE` streams nothing. The two `unchecked`-style casts are annotated and provably safe: `uint128(newTotal)` after `newTotal ≤ 1e18`, and `uint64(end)` after an explicit saturation branch. `balance` is `uint256` and bounded by USDC's own supply. |
| **Residual risk** | A pool funded with an implausible balance and run at `MAX_RATE` for an astronomically long horizon is the only region not covered by unit tests; `DripPoolFuzzTest.testFuzz_OpSequenceNeverOverPays` fuzzes rates and share sets but bounds them below `MAX_RATE` so the rational reference model does not overflow, so the extreme corner is argued from the caps rather than fuzzed. |
| **Enforced in** | `createPool`, `setRate`, `setShares`, `setSharesBatch`, `_setShares`, `_accrueMath`, `fundedUntil` saturation |
| **Test** | `contracts/test/unit/DripPoolBounds.t.sol`: `DripPoolBoundsTest.test_MaxRate_StreamsWithoutOverflow`, `test_MaxRate_UnderfundedPoolStreamsNothing`, `test_MaxTotalShares_AcceptedAtTheBound`, `test_MaxTotalShares_RevertsOnePastTheBound`, `test_MaxTotalShares_TwoMembersCannotExceedItAlone`, `test_LargeBalanceAndLongHorizon`, `test_SmallestUsefulRate`; `contracts/test/unit/DripPoolCreate.t.sol`: `DripPoolCreateTest.test_CreatePool_MaxRateIsAllowed`, `test_CreatePool_RevertsOnRateAboveMax`; `contracts/test/unit/DripPoolShares.t.sol`: `DripPoolSharesTest.test_SetShares_MaxSharesAllowed`, `test_SetShares_RevertsAboveMaxShares`, `test_SetSharesBatch_RevertsAboveMaxShares`; `contracts/test/unit/DripPoolViews.t.sol`: `DripPoolViewsTest.test_FundedUntil_SaturatesAtUint64Max`. `contracts/test/fuzz/DripPoolFuzz.t.sol`: `DripPoolFuzzTest.testFuzz_OpSequenceNeverOverPays` (random op sequences at fuzzed rates and share sets). |

## 11. Pool squatting and spam pools

| | |
|---|---|
| **Threat** | Anyone can call `createPool`, so an attacker mints thousands of pools, or creates a pool naming someone else as `owner`, or squats a `name` to impersonate a real collective. |
| **Why it matters** | `createPool` and `deposit` are intentionally permissionless (D13), and the singleton is shared by everyone. |
| **Handling** | Pools are **fully isolated by the accounting**: ids are sequential from 1, every field lives under `pools[poolId]` / `members[poolId][addr]`, and no code path reads another pool's storage — there is no global counter, no shared balance and no per-pool array that a spammer can make expensive for others. A spam pool costs its creator gas and holds no funds (a pool with `balance == 0` streams nothing). Naming a third party as `owner` gives that party control, not a liability; `name` is emitted, never stored, and carries no authority. Discovery is by `PoolCreated` logs, so the app surfaces the pool id, the owner and the deposits, and the docs tell users to verify the id from the collective itself rather than from a name. |
| **Residual risk** | The `/` page's "recent pools" list can be flooded with junk or lookalike names — a UI/social problem. Someone may deposit into the wrong pool id; deposits are irreversible and the owner of that pool can sweep the unstreamed part. |
| **Enforced in** | per-pool storage layout, `_pool` (`PoolNotFound` via `owner == 0`), `name` never stored |
| **Test** | `contracts/test/unit/DripPoolCreate.t.sol`: `DripPoolCreateTest.test_Pools_AreIsolated`, `test_CreatePool_IsPermissionless`, `test_CreatePool_IdsIncrement`, `test_CreatePool_InitialState`, `test_Views_RevertOnUnknownPool`, `test_Writes_RevertOnUnknownPool`; `contracts/test/unit/DripPoolWithdraw.t.sol`: `DripPoolWithdrawTest.test_SetPayoutAddress_IsPerPool`. |

## 12. Fee-on-transfer or rebasing token

| | |
|---|---|
| **Threat** | The streamed token takes a fee on transfer or rebases, so `balance` (credited with the *requested* amount) exceeds what the contract actually received, and the last withdrawals revert. |
| **Why it matters** | `deposit` credits `balance += amount` and then calls `safeTransferFrom` — it does **not** measure the delta. With a fee-on-transfer token that is an accounting hole. |
| **Handling** | Out of scope by construction: `usdc` is `immutable`, set once in the constructor, and this deployment points it at Arc's USDC, which is neither fee-on-transfer nor rebasing. `DripPool` is not a generic-token contract and must not be redeployed against one — there is no token registry, no per-pool token and no way to change it. Pre-deploy checklist item: confirm the constructor argument is `0x3600000000000000000000000000000000000000`, and verify on Sourcify so anyone can check it. |
| **Residual risk** | A third party could deploy this bytecode against a fee-on-transfer token; such a deployment would be broken and is not SharedArc. If Circle ever made Arc USDC fee-bearing, deposits would over-credit and the tail of the withdrawals would revert on the ERC-20's own balance check. |
| **Enforced in** | `immutable usdc`, constructor `ZeroAddress` check, deployment procedure ([`../DEPLOY.md`](../DEPLOY.md)) |
| **Test** | `contracts/test/unit/DripPoolCreate.t.sol`: `DripPoolCreateTest.test_Constructor_SetsUsdc`, `test_Constructor_RevertsOnZeroToken`. Behaviour against a fee-on-transfer token is **not tested** — it is a documented non-support, not a supported path. |

## 13. Direct USDC transfers to the contract

| | |
|---|---|
| **Threat** | Someone sends USDC straight to the `DripPool` address instead of calling `deposit`, expecting it to fund their pool; or an attacker donates to try to shift the accounting. |
| **Why it matters** | The contract holds the USDC of every pool in one ERC-20 balance, so a naive implementation reading `balanceOf(this)` would let a donation move value between pools. |
| **Handling** | The accounting **never reads `usdc.balanceOf(address(this))`**. Funding goes exclusively through `deposit`, which credits the pool's own `balance` field. A donation therefore changes nothing: no pool's runway, claimable or `unstreamed` moves, which is why invariant **I3** is stated as `Σ pools.balance ≤ balanceOf(DripPool)` rather than `=`. There is no `receive()` and no `fallback()`, so native value cannot be sent at all, and no sweep function, so a donation cannot be stolen by the first caller either. |
| **Residual risk** | Donated USDC is **permanently stuck**. This is a deliberate trade: any recovery function would be a privileged path over pooled funds and would need an owner the contract does not have. The README, the app's deposit flow and `DEPLOY.md` say to use `deposit` (approve + deposit), never a raw transfer. |
| **Enforced in** | absence of `balanceOf` reads, absence of `receive` / `fallback` / sweep, `deposit` as the only credit path |
| **Test** | `contracts/test/unit/DripPoolDeposit.t.sol`: `DripPoolDepositTest.test_Deposit_DirectTransfersAreIgnored`, `test_Deposit_CreditsPoolAndMovesTokens`, `test_Deposit_RevertsWithoutAllowance`, `test_Deposit_RevertsOnZeroAmount`. `contracts/test/invariant/DripPool.invariant.t.sol`: `DripPoolInvariantTest.invariant_I3_backedByTokens` (I3, the handler donates USDC directly on purpose). |

## 14. Ownership handed to a wrong address

| | |
|---|---|
| **Threat** | The owner calls `transferPoolOwnership` with a typo, a contract that cannot call the pool, or an address on another chain — and the pool becomes permanently unmanageable (no pause, no re-weight, no cancel, no sweep). |
| **Why it matters** | There is no contract-level admin (D4/D7) and no recovery path. A lost pool owner is lost forever. |
| **Handling** | **Two-step transfer.** `transferPoolOwnership` only records `pendingOwner` and emits `OwnershipTransferStarted`; the current owner keeps every power until the new address itself calls `acceptPoolOwnership`. A mistyped address simply never accepts, and the transfer can be overwritten by pointing `pendingOwner` somewhere else — there is no cancel needed. `newOwner == address(0)` reverts `ZeroAddress`, so ownership cannot be renounced by accident. Ownership transfer is allowed on cancelled pools, so a cancelled pool can still be handed over for bookkeeping. |
| **Residual risk** | If the *accepting* address is itself lost (a contract with no way to call the pool, or a compromised key), the pool is unmanageable; members still withdraw everything accrued, and nothing is streamed once the balance empties. Members' funds are never at risk from this. |
| **Enforced in** | `transferPoolOwnership`, `acceptPoolOwnership` (`NotOwner`, `NotPendingOwner`, `ZeroAddress`) |
| **Test** | `contracts/test/unit/DripPoolOwnership.t.sol`: `DripPoolOwnershipTest.test_Transfer_IsTwoStep`, `test_Transfer_NewOwnerCanAdminister`, `test_Transfer_OldOwnerLosesRights`, `test_Transfer_CanBeReplacedBeforeAcceptance`, `test_Transfer_DoesNotChangeClaimable`, `test_Transfer_RevertsForNonOwner`, `test_Transfer_RevertsOnZeroAddress`, `test_Accept_RevertsWithoutPendingTransfer`, `test_Accept_RevertsForWrongCaller`; `contracts/test/unit/DripPoolOwnerFunds.t.sol`: `DripPoolOwnerFundsTest.test_Cancel_KeepsOwnershipTransferAvailable`. |

---

# Threats found during the build (not in PRD §7)

## 15. Money streamed into the void (`totalShares == 0`)

| | |
|---|---|
| **Threat** | A pool is created and funded before any member is added, or every member is removed mid-stream. If accrual ran with `totalShares == 0`, `streamed × 1e18 / 0` would revert — or, with a naive guard, the funds would be consumed and credited to nobody. |
| **Why it matters** | It is the normal creation order (create → fund → add members) and the normal offboarding edge (last member leaves). Silently burning treasury funds there would be a real loss. |
| **Handling** | `_accrueMath` requires `totalShares > 0` to stream anything. With no shares the pool consumes **nothing**: `owed` and `accIndex` stay put, `available` is untouched, and `lastAccrual` still advances so the skipped interval is never replayed (R3, R7). `fundedUntil` returns `type(uint64).max` in that state, which the app renders as "not streaming" rather than a runway. When shares are set again, streaming resumes from that moment with no back-pay. |
| **Residual risk** | The unshared interval is simply not paid — the intended semantics. |
| **Enforced in** | `_accrueMath` (`totalShares > 0` guard), `fundedUntil` |
| **Test** | `contracts/test/unit/DripPoolShares.t.sol`: `DripPoolSharesTest.test_SetShares_ZeroTotalSharesConsumesNothing`, `test_SetShares_AllMembersLeaveThenReturn`; `contracts/test/unit/DripPoolViews.t.sol`: `DripPoolViewsTest.test_FundedUntil_MaxWithoutShares`; `packages/sdk/test/math.test.ts`: "streams nothing and consumes nothing while totalShares is zero". |

## 16. Batch state restore is incomplete

| | |
|---|---|
| **Threat** | `withdrawForBatch` writes `pending`, `owed` and `balance` before the transfer and must undo **all three** when the transfer fails. Restoring two of the three would either lose the member's claim or break I2 for the whole pool. |
| **Why it matters** | This is the only place in the contract where state is written and then conditionally rolled back by hand; a `revert` cannot be used because the batch must not fail. |
| **Handling** | The failure branch mirrors the success branch exactly, on the same `wad` and `units` values held in memory: `m.pending += wad; p.owed += wad; p.balance += units;` then `emit WithdrawSkipped`. Because the three were decremented by those same values a few lines earlier and no other storage was touched in between, the pool returns to a bit-identical state — as if the entry had been skipped for zero claimable. `total` (the return value) counts only successful transfers. Duplicates are safe on top of this: the second occurrence settles to the same index and floors to 0 units, so it is skipped (R8). |
| **Residual risk** | A token whose `transfer` returns `true` but moves nothing would be treated as a success and the member's claim would be lost — not possible with FiatToken USDC, and out of the §12 model. |
| **Enforced in** | `withdrawForBatch` restore branch |
| **Test** | `contracts/test/unit/DripPoolBatch.t.sol`: `DripPoolBatchTest.test_Batch_SkipsBlocklistedMemberAndRestoresState`, `test_Batch_BlocklistedMemberCanBePaidLater`, `test_Batch_SkipsMemberWhoseTokenReturnsFalse`, `test_Batch_PaysEveryone`, `test_Batch_SingleAccrual`, `test_Batch_HandlesDuplicates`, `test_Batch_WorksAfterCancel`, `test_Batch_WorksWhenFrozen`. |

## 17. Batch as a gas / DoS surface

| | |
|---|---|
| **Threat** | A caller passes a huge member list to `withdrawForBatch` or `setSharesBatch` and exceeds the block gas limit, or an attacker pads a payroll batch with addresses to make "Pay everyone" fail. |
| **Why it matters** | Both batches are `external`; `withdrawForBatch` is permissionless. |
| **Handling** | `MAX_BATCH = 100` on both, reverting `TooManyItems` above it; `setSharesBatch` also requires equal array lengths (`LengthMismatch`). At the §4.6 target of ≤ 60k gas per batched member, 100 entries stay well inside a block. The app chunks its member list into groups of 100. A batch built by an attacker can only waste the attacker's own gas: entries with nothing claimable are skipped, and the members who *are* paid are paid correctly. An empty list is a no-op (one accrual). |
| **Residual risk** | A collective with more than 100 members needs several transactions; that is a UX cost, not a safety one. |
| **Enforced in** | `withdrawForBatch`, `setSharesBatch` (`MAX_BATCH`, `TooManyItems`, `LengthMismatch`) |
| **Test** | `contracts/test/unit/DripPoolBatch.t.sol`: `DripPoolBatchTest.test_Batch_MaxBatch`, `test_Batch_RevertsAboveMaxBatch`, `test_Batch_EmptyListIsNoop`, `test_Batch_ZeroAddressEntryIsSkipped`; `contracts/test/unit/DripPoolShares.t.sol`: `DripPoolSharesTest.test_SetSharesBatch_MaxBatch`, `test_SetSharesBatch_RevertsAboveMaxBatch`, `test_SetSharesBatch_RevertsOnLengthMismatch`, `test_SetSharesBatch_EmptyIsNoop`, `test_SetSharesBatch_SingleAccrual`, `test_SetSharesBatch_DuplicatesLastWins`, `test_SetSharesBatch_SkipsUnchangedSilently`. |

## 18. The offchain mirror disagrees with the chain

| | |
|---|---|
| **Threat** | `packages/sdk/src/math.ts` ticks a member's claimable in the browser without RPC calls. If it drifts from the contract, the UI shows an amount that a withdrawal does not pay — users lose trust, and a "Pay everyone" preview could be wrong. |
| **Why it matters** | The mirror is a second implementation of the accounting; two implementations always drift unless something forces them together. |
| **Handling** | The mirror was written from `SPEC.md` §4 alone, not from the contract (PRD §12 phase 1), so an agreement between them is evidence rather than a copy. `contracts/test/vectors/AccrualVectors.t.sol` exports ≥ 30 states (`contracts/test/vectors/accrual.json`) covering fresh pools, freezes, pauses, future start times and bound values; `packages/sdk/test/vectors.test.ts` asserts `claimable` and `fundedUntil` bit-identically against them, and the file is regenerated and checked in CI. Inside the contract the same guarantee holds between reads and writes: `_accrue` and `_simulate` both call the one `pure` `_accrueMath`. A mismatch is resolved against §4.2 of the PRD, never by copying either side. |
| **Residual risk** | The mirror is only as fresh as the last state read from the chain; the app re-syncs every 30 s and after each transaction. A block whose timestamp jumps makes the ticking display briefly optimistic — never the payout. |
| **Enforced in** | `DripPool._accrueMath` (shared by views and writes), `packages/sdk/src/math.ts`, vector export + CI check |
| **Test** | `packages/sdk/test/vectors.test.ts`: "exports at least the 30 vectors the test plan requires", "<vector> matches claimable, fundedUntil and unstreamed"; `contracts/test/vectors/AccrualVectors.t.sol`: `AccrualVectorsTest.test_ExportAccrualVectors`; `contracts/test/unit/DripPoolViews.t.sol`: `DripPoolViewsTest.test_Claimable_MatchesWithdraw`, `test_GetPool_ReflectsAccrualAfterAWrite`; `packages/sdk/test/math.test.ts` (whole file, including "matches the contract constants"). |

## 19. Member discovery from logs is incomplete

| | |
|---|---|
| **Threat** | "Pay everyone" builds its member list from `SharesSet` logs. Arc's public RPC caps `eth_getLogs` at 10 000 blocks, and a member removed to 0 shares stops appearing as current — if either is mishandled, a member with a real balance is silently left out of every batch. |
| **Why it matters** | There is **no onchain member enumeration** (D7), so the log query is the only member list that exists. |
| **Handling** | `packages/sdk/src/members.ts` chunks queries at 10 000 blocks from the deployment block (`splitBlockRange`, with `isRangeTooLarge` to back off when an RPC rejects a range anyway), folds `SharesSet` per address (`candidatesFromLogs`, last value wins) and returns current non-zero members **plus** zero-share addresses that still have `pending`, confirmed by a `getMember` multicall (`getPoolMembers`). Being left out of a batch is not a loss in any case: a member can always call `withdraw` themselves, and anyone can call `withdrawFor(poolId, member)` for them — nothing about a member's claim depends on being discovered. |
| **Residual risk** | An RPC that silently truncates a range, or a wrong `fromBlock`, yields a short list and a partial payroll run; the missing member keeps their full claim and can withdraw directly. |
| **Enforced in** | `packages/sdk/src/members.ts`, deployment block recorded in `deployments/*.json` |
| **Test** | `packages/sdk/test/members.test.ts` (15 tests) covers `splitBlockRange`, `isRangeTooLarge`, `getSharesSetLogs` (10 000-block windows and the halving back-off), `candidatesFromLogs` (last value wins) and `getPoolMembers` (zero-share members that still hold `pending` are kept). Anvil has no Multicall3 predeploy, so those tests exercise the sequential fallback; the multicall path itself is unproven against a live chain (§22). Onchain side covered by `contracts/test/unit/DripPoolShares.t.sol`: `DripPoolSharesTest.test_SetShares_LeaveMidStreamKeepsAccrued` and `contracts/test/unit/DripPoolWithdraw.t.sol`: `DripPoolWithdrawTest.test_WithdrawFor_IsPermissionlessAndPaysTheMember`. |

---

## 20. Paying the singleton itself (funds destroyed, not stolen)

| | |
|---|---|
| **Threat** | A payout destination equal to `address(this)`. The `safeTransfer` succeeds as a no-op self-transfer: `balance`, `owed` and `pending` are debited and `Withdrawn` / `UnstreamedWithdrawn` / `Cancelled` is emitted, but `usdc.balanceOf(DripPool)` does not move. The units become untracked surplus that no pool accounts for and no function can ever pay out — not to the owner (sweeps are bounded by `balance`), not to any member. |
| **Why it matters** | It is silent and irreversible, and an indexer or the web app reports a successful recovery that never happened. I3 (`Σ balance ≤ usdc.balanceOf`) still holds because it errs in the safe direction, so the invariant suite cannot see it. `setPayoutAddress` already refused this destination; the other four routes into a payout address did not. |
| **Handling** | Every route now rejects `address(this)` with `BadPayout`: `setPayoutAddress(to)`, `setShares(member, …)` and `setSharesBatch` (the singleton cannot be enrolled as a member, which closes the default `payout == 0 → member` path), `withdrawUnstreamed(…, to)` and `cancel(…, to)`. With no member equal to the singleton and no payout equal to it, `_withdraw` and `withdrawForBatch` cannot resolve `to` to it either. |
| **Residual risk** | A payout address that is some *other* dead address is still the owner's or the member's own mistake; the contract cannot distinguish it. Direct transfers to the contract remain stuck (§13). |
| **Enforced in** | `setShares`, `setSharesBatch`, `setPayoutAddress`, `withdrawUnstreamed`, `cancel` |
| **Test** | `contracts/test/unit/DripPoolGriefing.t.sol`: `DripPoolGriefingTest.test_SetShares_RevertsOnTheSingleton`, `test_SetSharesBatch_RevertsOnTheSingleton`, `test_WithdrawUnstreamed_RevertsOnTheSingleton`, `test_Cancel_RevertsOnTheSingleton`, `test_OwnerSweeps_StillWorkWithARealDestination`; `contracts/test/unit/DripPoolShares.t.sol` and `DripPoolOwnerFunds.t.sol` for the unchanged happy paths. |

## 21. What SharedArc does not protect against

- **A malicious or careless pool owner, going forward.** Pause, re-weight, sweep and cancel are all one
  transaction, with no timelock. Use a Safe or a DAO as `owner` if that matters (§2).
- **Depositing into the wrong pool id.** Deposits are permissionless and irreversible; the unstreamed part
  becomes that pool owner's to sweep.
- **USDC itself.** Blocklist, upgrade, pause or a Circle policy change are outside the model (§5, §12).
- **Dust below 1 USDC unit.** Unreachable by member and owner alike, by design (§4).
- **Direct transfers to the contract.** Permanently stuck (§13).
- **Sub-wad rounding under a griefer.** Bounded and economically irrelevant, but not zero (§4, SPEC §6.2).
- **Private-key loss** by a member or an owner. There is no recovery path anywhere in the contract.
- **Anything about the future value of a stream.** SharedArc is not an escrow, not vesting, and gives no
  guarantee that a pool stays funded.

## 22. Open gaps in the evidence

Stated explicitly so no row above over-claims:

1. **The fork test cannot move real USDC.** `contracts/test/fork/ArcUsdc.fork.t.sol` runs against Arc state
   when `ARC_TESTNET_RPC` (or `ARC_RPC`) is set and is skipped otherwise. Its read-only checks and
   `createPool` run against the real token, but Arc's USDC delegates `transfer` / `transferFrom` to a
   node-side precompile at `0x1800…0000` that a local fork cannot execute, so the deposit/withdraw body is
   guarded and logs `SKIPPED`. §5 and §12 therefore still rest on `MockUSDC`.
2. **No reentrancy test** with a hostile token or payout contract (§6): `MockUSDC` has no hooks, so the
   `nonReentrant` + CEI layers are argued, not demonstrated. A `ReenteringToken` mock would close this.
3. **Blocklist behaviour is mock-only** (§5), for the reason in gap 1. This settles PRD §14's third open
   question as mock-only for this release: whether a real FiatToken blocklist revert behaves identically to
   `MockUSDC.blacklist` under `trySafeTransfer` is argued from `trySafeTransfer`'s semantics (any revert is
   caught), not demonstrated on Arc.
4. **Fee-on-transfer behaviour is untested** (§12), deliberately — it is documented as unsupported.
5. **Member discovery is tested against anvil, not Arc** (§19): `packages/sdk/test/members.test.ts` covers the
   chunking and the zero-share recovery, but anvil has no Multicall3 predeploy, so only the sequential
   fallback of `getPoolMembers` is executed. Arc mainnet does have canonical Multicall3 at
   `0xcA11bde0…76CA11`, and that path is unproven.
6. **CCTP is encoding-tested only** (`packages/sdk/src/bridge.ts`, `docs/CCTP.md`): no burn has been executed
   on any chain, and the bridge is not part of the PRD §10.2 mainnet proof.
