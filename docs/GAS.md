# Gas

> Measured 2026-09-18 with forge 1.7.1 (solc 0.8.30, `optimizer = true`, 10,000 runs, `evm_version = "prague"`)
> from `contracts/test/gas/DripPool.gas.t.sol`. Reproduce with:
>
> ```bash
> cd contracts && forge test --match-contract Gas -vv
> ```
>
> **Execution gas (forge)**: `vm.lastCallGas().gasTotalUsed` for the measured call, run on cold storage
> (`vm.cool` on both `DripPool` and the token) so every slot it touches is being touched for the first time,
> exactly as in a standalone transaction. It excludes the 21,000 intrinsic gas and the calldata cost.
>
> **Tx model**: `21,000 + calldata (4 / 16 gas per zero / non-zero byte) + execution - refund (capped at 1/5)`,
> floored by EIP-7623 (Prague) at `21,000 + 10 gas per calldata token`. This is what a sender actually pays, and
> it is the number compared with the PRD 4.6 targets.
>
> **USDC**: Arc charges gas in USDC at a 20 gwei floor, so 1 gas = 0.00000002 USDC.
>
> The token here is `MockUSDC` (6 decimals, blocklist). Arc's USDC is a proxy over a native-coin precompile, so
> on mainnet expect roughly +1k to +3.5k on every call that moves tokens (one extra DELEGATECALL plus a cold
> account on a fresh transaction). The **Arc mainnet** column is filled from the PRD 10.2 proof transactions
> (`cast receipt <hash> gasUsed`) and is the authority when the two disagree (PRD 14, second UNKNOWN).

## PRD 4.6 targets

| Call | Target | Execution gas | Tx model | USDC at 20 gwei | vs target | Arc mainnet gasUsed |
|---|---:|---:|---:|---:|---|---:|
| `createPool` | ≤ 130,000 | 55,666 | 77,990 | 0.00156 | within (−52,010) | 78,014 |
| `deposit`, running pool | ≤ 95,000 | 78,969 | 97,537 | 0.00195 | **over** (+2,537) | in progress (proof row 5); a first deposit into an unfunded pool measured 94,420 |
| `setShares`, new member, running pool | ≤ 110,000 | 94,100 | 115,812 | 0.00232 | **over** (+5,812) | 98,712 |
| `withdraw`, repeat | ≤ 95,000 | 108,763 | 107,267 | 0.00215 | **over** (+12,267) | in progress; the pool's first `withdraw` measured 166,744 (see below) |
| `withdrawFor`, repeat | ≤ 95,000 | 108,894 | 107,562 | 0.00215 | **over** (+12,562) | in progress; a member's first `withdrawFor` measured 137,543 |
| `withdrawForBatch`, 4 members, per member | ≤ 60,000 | 63,385 | 55,133 | 0.00110 | within (−4,867) | in progress (proof row 6) |
| `withdrawForBatch`, 10 members, per member | ≤ 60,000 | 54,053 | 45,091 | 0.00090 | within (−14,909) | not run (the proof batch has 4 members) |
| `withdrawForBatch`, 100 members, per member | ≤ 60,000 | 48,454 | 39,066 | 0.00078 | within (−20,933) | not run (the proof batch has 4 members) |

Whole batch calls: 4 members 220,535 (0.00441 USDC), 10 members 450,916 (0.00902 USDC), 100 members 3,906,628
(0.07813 USDC). A member with nothing payable is skipped *before* being settled, so an entry that pays nothing
now costs two cold reads instead of two cold writes: a 100-entry batch where nobody is payable fell from
2,813,081 to 835,081 gas in `DripPoolBatchTest.test_Batch_MaxBatch`. The paying path costs about 500 gas more
per member for the peek (docs/SPEC.md §6.2). **Paying everyone is the cheap path**: one `withdrawForBatch` of 10 costs less per member than a
single `withdraw`, because the 21,000 intrinsic gas and the pool's own cold slots are paid once instead of ten
times. That is also the path the reference app's "Pay everyone" button uses (PRD 6).

## Arc mainnet receipts

Every proof transaction so far, `gasUsed` from `cast receipt <hash> --rpc-url https://rpc.mainnet.arc.io`
(2026-09-18, effective gas price 20.0–20.7 gwei; hashes in `deployments/arc-mainnet.json` `proofTxs`).

| Call | gasUsed | ≈ USDC | Context |
|---|---:|---:|---|
| Deploy `DripPool` (CREATE2 factory) | 2,365,058 | 0.0473 | one-off |
| `createPool` | 78,014 / 78,038 | 0.0016 | pools 1 and 2 |
| `setSharesBatch`, 3 new members, no deposit yet | 148,621 | 0.0031 | pool 1 |
| `setShares`, new member, no deposit yet | 89,034 | 0.0018 | pool 2 |
| `setShares`, new member, running pool | 98,712 | 0.0020 | pool 1, a fourth member joins mid-stream |
| USDC `approve` | 55,438 | 0.0011 | |
| `deposit`, first into an unfunded pool | 94,420 | 0.0019 | pools 1 and 2 |
| `withdraw`, first in the pool | 166,744 | 0.0033 | pool 1 (C) and pool 2 (C, before the cancel) |
| `withdrawFor`, member's first, pool already initialised | 137,543 | 0.0028 | pool 1, OPS pays B |
| `setPayoutAddress` | 48,378 | 0.0010 | pool 1 (B) |
| `cancel` | 85,321 | 0.0017 | pool 2 |
| `withdraw` after `cancel` | 94,491 | 0.0019 | pool 2 (C) |

The first `withdraw` in a pool initialises `accIndex`, `owed` and the member's `index`/`pending` (the "First-time
calls" table below: 141,467 locally); on Arc it lands about 25k higher. The likely cause is the USDC proxy over
the native-coin precompile, but the exact split is not measured. Steady-state rows fill in with proof rows 5–8.

## First-time calls

Four storage slots go from zero exactly once in a pool's life, at 22,100 gas each (EIP-2929/2200 cold
zero → non-zero write): the pool's `accIndex` and `owed` on its first accrual, and each member's `index` and
`pending` on their first settle. The steady-state rows above are what a running payroll pays; these are the
one-off rows behind them.

| Call | Execution gas | Tx model | USDC | What is being initialised |
|---|---:|---:|---:|---|
| `deposit`, first ever | 86,600 | 105,168 | 0.00210 | the pool's `balance` |
| `setShares`, new member, first accrual | 111,200 | 132,912 | 0.00266 | `accIndex`, `owed`, the member's `index` |
| `withdraw`, first ever in the pool | 142,963 | 141,467 | 0.00283 | `accIndex`, `owed`, the member's `index` and `pending` |
| `withdrawForBatch`, 10 members, first run, per member | 72,863 | 60,139 | 0.00120 | `index` + `pending` per member (139 gas over the 60k target on the one run that initialises them; every later run is 45,091) |
| `withdraw` to a payee with a zero USDC balance | 125,997 | 124,501 | 0.00249 | the payee's token slot (+20,000) |

The last row is rare on Arc: gas is paid in USDC, so any address able to send a transaction already holds some.
It applies to a `payoutAddress` pointing at a fresh address that has never been funded.

## Where the misses come from

Four rows sit above their PRD 4.6 target, from three causes (`withdraw` and `withdrawFor` share one). None of
them is a layout accident; each is a write the design calls for, and none was tuned away because the accounting of PRD 4.3 is the deliverable.

- **`withdraw` / `withdrawFor`, +12k.** A withdrawal is the one call that touches everything: it reads the whole
  `Pool` struct (7 slots) and the whole `Member` struct (4 slots) cold (2,100 each = 23,100), writes six of them
  (`accIndex`, `owed`, `lastAccrual`, `balance`, the member's `index` and `pending`), takes the
  `ReentrancyGuard` lock (a cold 1 → 2 → 1 pair) and then makes an external token transfer. The PRD's own cost
  estimate, "about 0.002 USDC", is essentially met: the measured 0.00215 USDC is 7% above it. The cheap path is
  `withdrawForBatch`, which amortises the pool half of that cost and comes in at 0.00089 USDC per member at ten
  members.
- **`setShares` (new member), +5.8k.** Adding a member writes their `shares` slot from zero (22,100) on top of
  the accrue-and-settle every share change must do first (PRD 4.2: `_accrue` then `_settle`, or the member would
  be re-priced over time they already earned). Re-weighting an existing member, where no slot starts at zero, is
  103,826, and removing one is 99,014.
- **`deposit`, +2.5k.** `deposit` must `_accrue` before it changes `balance`, which is three writes before the
  `transferFrom` even starts. Within measurement noise of the target; a first deposit into a fresh pool is
  105,168.

## Other measurements

| Measurement | Gas | USDC at 20 gwei | Source |
|---|---:|---:|---|
| deploy `DripPool` | 2,057,673 | 0.04115 | forge trace of the `CREATE` (execution + code deposit). A real deploy transaction adds 21,000 intrinsic gas plus the init code as calldata |
| runtime size | 10,055 bytes | — | `forge build --sizes` (limit 24,576) |
| `setRate` (pause / resume) | 45,044 exec / 66,436 tx | 0.00133 | `test_Gas_SetRate` |
| `setShares` re-weight | 82,290 exec / 103,786 tx | 0.00208 | `test_Gas_SetSharesReweight` |
| `setShares` remove (to 0) | 82,290 exec / 98,974 tx | 0.00198 | `test_Gas_SetSharesRemove` |
| `withdrawUnstreamed` | 76,121 exec / 95,045 tx | 0.00190 | `test_Gas_WithdrawUnstreamed` |
| `cancel` | 78,232 exec / 97,004 tx | 0.00194 | `test_Gas_Cancel` (includes the `RateSet(rate -> 0)` log) |

## Regression guard

`contracts/.gas-snapshot` is committed and `pnpm contracts:snapshot:check` re-runs it with a 5% tolerance, so a
change that makes any call more expensive fails CI. The gas tests pause metering except around the one measured
call, so each snapshot line is that call and nothing else.

The assertions inside `DripPool.gas.t.sol` are **regression ceilings, not the PRD 4.6 targets**: a suite that
failed on the three documented misses above would be red on every run and would stop guarding anything. The
targets live in this file, measured, with the reason for each miss.

## PRD 13 metrics

- A member's withdrawal costs 0.00215 USDC, or 0.00089 USDC when payroll is run as a batch of ten. A member
  holding nothing but their payroll can pay for their own withdrawal out of it after about 0.0022 USDC has
  accrued (a pool paying 1 USDC/day funds that in about 3 minutes).
- Running payroll for a 10-member collective costs 0.00892 USDC per run; for 100 members, 0.07711 USDC.
- Creating a pool costs 0.00156 USDC; deploying the singleton, once, costs about 0.041 USDC plus the init-code calldata. Budget about 0.06 USDC for the deploy transaction (PRD 10.2 step 1 asks for about 8 USDC in the deployer, which is ample).
