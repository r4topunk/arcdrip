# ArcDrip — Product Requirements Document

Version 1.0 · 2026-09-18 · Owner: r4to · Status: approved, ready for build
Target: Arc Microgrants (DoraHacks), deadline 2026-10-14 23:59 ET. Must be live on Arc mainnet with a public repo.

This document is self-contained. A fresh session must be able to build the whole project from it plus the two reference repos named in §2.4. Everything in the codebase (code, comments, docs, commits, site copy) is in English. The site also ships a PT-BR translation. The Portuguese decision log is `../PLAN-ARCDRIP.md`.

---

## 0. TL;DR

**ArcDrip** is a shared USDC stream for collectives: **one rate, N shares, live runway**. A pre-funded pool pays `ratePerSecond` USDC, split among members by mutable integer shares. Joining, leaving or re-weighting mid-stream is one O(1) write that touches nobody else (accumulated-index accounting). When the pool runs dry the stream freezes by itself and resumes on the next deposit; it can never owe more than it holds. The owner can never touch what members have already earned.

Onchain it is one immutable singleton, `DripPool`, holding many pools. Offchain it is a TypeScript SDK that mirrors the accrual math (so a UI ticks per second without RPC calls) and a static web app, **Collective Payroll**: create a pool, set members and shares, deposit, watch balances fill, see "runway: 23 days", press "Pay everyone".

Deliverables: `contracts/` (Foundry), `packages/sdk`, `apps/web` (static Next.js, EN/PT-BR), `docs/`, mainnet deployment with proof transactions, project page on GitHub Pages, DoraHacks submission text. No keeper, no relayer, no hosted service.

---

## 1. Problem and why Arc

### 1.1 Problem
A collective (DAO, co-op, open-source team, agent swarm) paying contributors has two bad options today. Discrete transfers: someone must remember, sign, and get the amounts right every period. Per-recipient streams (Sablier-style): re-weighting means cancelling and recreating N streams, and the treasury's remaining runway is spread over N balances. Splitters (0xSplits-style) divide what arrives, instantly, with no notion of time.

### 1.2 What ArcDrip changes
One pool, one rate, one balance, one runway number. Shares are relative weights; changing one member's weight re-prices everyone from that second onward without touching their storage. What a member has accrued is theirs: removal, re-weighting, pause and cancel never reduce it.

### 1.3 Why Arc specifically
| Arc property | Use in ArcDrip |
|---|---|
| Gas paid in USDC, 20 gwei floor | A member holding only their payroll can withdraw; a withdrawal costs about 0.002 USDC |
| USDC is native and an ERC-20 at `0x3600000000000000000000000000000000000000` (6 decimals) | Treasury, payroll and gas are the same asset |
| Sub-second deterministic finality | The UI's local per-second simulation and the chain agree; no confirmation depth |
| USDC blocklist reverts transfers | Payouts are per-member pulls; a blocked member can never stall others (batch skips, never reverts) |
| No Sablier, Superfluid, LlamaPay or 0xSplits on Arc (0xSplits issue #77 from Circle DevRel open since 2026-04-08) | Greenfield as infrastructure; see §9 for prior art |

---

## 2. Scope

### 2.1 In scope (v1)
- `DripPool.sol`: immutable singleton, many pools, per-pool owner, accumulated-index streaming, freeze-on-empty, pull withdrawals with permissionless push-to-member, cancel, unstreamed recovery.
- `@arcdrip/sdk`: viem actions, Zod schemas, offchain accrual mirror (`claimable`, `runway`), member discovery from logs, rate helpers.
- `apps/web`: Collective Payroll reference app.
- Docs: README, SPEC, THREATS, GAS, DEPLOY, CHECKLIST, SUBMISSION, AGENTS.md; project page.

### 2.2 Out of scope (v1), recorded as options
- `depositWithAuthorization` (EIP-3009 gasless donation).
- Onchain CCTP leg (`withdrawCrossChain` via `TokenMessenger.depositForBurn`).
- Waterfall / tiered splits.
- SealedDAO (ArcSeal) as pool owner (needs a `Call` proposal type there).
- Keeper process. Transferable stream positions (NFT).
- `withdrawAndBridge` in the SDK is **in scope only if** Bridge Kit supports Arc mainnet as a source chain at build time (§14); otherwise documented as an option.

### 2.3 Non-goals stated for reviewers
No token, no yield, no fees, no admin key over the contract, no upgradeability. Not a Sablier clone: there are no per-recipient streams, only pools with shares. Not a splitter: nothing is distributed on arrival, only over time.

### 2.4 Reference repos (same author, same conventions)
- `/Users/r4to/Script/arc/arc-subscriptions` (ArcPull): monorepo layout, root `package.json` scripts (`check` = build + test + typecheck + lint + fmt + ABI check), Foundry config, SDK ABI generation and check, `deployments/arc-mainnet.json` shape, `CHECKLIST.md` / `DEPLOY.md` style, `site/index.html` + `.github/workflows/pages.yml`, USDC blocklist mock.
- `/Users/r4to/Script/arc/arc-seal` (ArcSeal): most recent iteration of the same conventions; web app structure with EN/PT-BR content, `docs/GAS.md` format, `AGENTS.md`.
Copy structure and tooling. Do not copy business logic.

---

## 3. Fixed decisions
| # | Decision | Reason |
|---|---|---|
| D1 | Use case = collective payroll: a treasury pays N contributors by weight, continuously | The one case where stream × split is justified |
| D2 | Pool with `rate` + `shares`, accumulated index | True merge of both modules; O(1) join/leave |
| D3 | Insolvency impossible by construction: accrual is capped by funded time; the stream freezes and resumes by itself | Single payer needs no liquidation |
| D4 | Per-pool generic `owner` (two-step transfer). EOA, Safe or DAO. No built-in governance. No contract-level owner | Pure module |
| D5 | `withdraw` by member + permissionless `withdrawFor` (funds always go to the member's payout address). Optional `payoutAddress`. Zero claimable reverts | Anyone can run payroll; a member without gas still gets paid |
| D6 | CCTP stays out of the contract | No bridge in the audit surface |
| D7 | Singleton with incremental `poolId`; immutable; no onchain member enumeration | One address for SDK/Sourcify |
| D8 | Pause = `setRate(0)`. Remove = `setShares(m, 0)`, accrued stays withdrawable forever. `cancel` returns only the unstreamed part. `withdrawUnstreamed` bounded by `balance − owed`. Optional `startTime`. No cliff | Owner never touches earned funds |
| D9 | Internal amounts in **wad** = USDC units × 1e12 (18 decimals). Free integer shares, not bps | 1 USDC/month must not round to zero; adding a member is one write |
| D10 | Deliverables: contracts + SDK + web + docs + mainnet proof. No keeper | No new unhosted process |
| D11 | Name ArcDrip, folder `arc-drip/`, repo `r4topunk/arcdrip`, contract `DripPool`, page r4topunk.github.io/arcdrip | "ArcSplit" and "ArcFlow" are taken |
| D12 | Built in parallel with ArcSeal | User's call |
| D13 | Funding only via `approve` + `deposit`; permissionless on a live pool | Differentiator is the accounting |
| D14 | CEI + `ReentrancyGuard`; no `receive()`; Foundry, Solidity 0.8.x, TS/pnpm, viem/wagmi, Next.js static export, Zod, pino in the SDK | Precedent |
| D15 | "Pay everyone" is one tx: `withdrawForBatch`, which **skips** (never reverts on) a member whose transfer fails or whose claimable is zero | Refines D5/D10; blocklist-safe |

---

## 4. Onchain specification

### 4.1 Constants and types
```
IERC20 public immutable usdc;                 // constructor arg; Arc: 0x3600…0000
uint256 constant WAD_PER_UNIT   = 1e12;       // 1 USDC unit (1e-6 USDC) = 1e12 wad
uint256 constant INDEX_SCALE    = 1e18;
uint256 constant MAX_RATE       = 1e30;       // wad/s  (= 1e12 USDC/s), overflow guard
uint256 constant MAX_SHARES     = 1e15;       // per member
uint256 constant MAX_TOTAL_SHARES = 1e18;     // keeps per-accrual dust < 1 wad
uint256 constant MAX_BATCH      = 100;

struct Pool {
  address owner; address pendingOwner;
  uint64  startTime;      // accrual never starts before this
  uint64  lastAccrual;    // timestamp of last _accrue
  bool    cancelled;
  uint128 ratePerSecond;  // wad per second, whole pool
  uint128 totalShares;
  uint256 balance;        // USDC units held for this pool
  uint256 owed;           // wad streamed to members and not yet withdrawn (includes dust)
  uint256 accIndex;       // wad per share, scaled by INDEX_SCALE
}
struct Member { uint128 shares; address payout; uint256 index; uint256 pending; } // pending in wad
mapping(uint256 => Pool) pools;  mapping(uint256 => mapping(address => Member)) members;  uint256 nextPoolId = 1;
```

### 4.2 Accrual (the only place time enters)
```
_accrue(p):
  from = max(p.lastAccrual, p.startTime)
  if (now > from && p.ratePerSecond > 0 && p.totalShares > 0):
      available = p.balance * WAD_PER_UNIT − p.owed          // wad not yet streamed; never negative (I2)
      dt        = min(now − from, available / p.ratePerSecond) // floor; this is the freeze
      streamed  = p.ratePerSecond * dt
      p.accIndex += streamed * INDEX_SCALE / p.totalShares     // floor
      p.owed     += streamed
  p.lastAccrual = now

_settle(p, m):  // always after _accrue
  m.pending += m.shares * (p.accIndex − m.index) / INDEX_SCALE   // floor
  m.index    = p.accIndex
```
Rules that follow, and must be stated in `docs/SPEC.md`:
- Every state-changing function calls `_accrue` **before** changing `rate`, `totalShares`, `balance` or `owed`. Because parameters are constant between accruals, capping `dt` is exactly equivalent to "streaming stopped at the moment funds ran out"; no `fundedUntil` is stored.
- Frozen time is not owed later. After a freeze, a deposit resumes streaming from the deposit's timestamp.
- With `totalShares == 0` nothing streams and no funds are consumed (money never streams into the void).
- All floors favour the pool. `owed` grows by the full `streamed`, members collectively receive `≤ streamed`; the difference is dust that stays in `owed` forever (bounded, < 1 wad per accrual by `MAX_TOTAL_SHARES`).
- View `fundedUntil(poolId)`: `type(uint64).max` if rate or totalShares is 0, else `max(lastAccrual,startTime) + available/rate` computed on simulated state.

### 4.3 Functions
| Function | Who | Behaviour |
|---|---|---|
| `createPool(owner, ratePerSecond, startTime, name) → poolId` | anyone | `owner != 0`, `rate ≤ MAX_RATE`, `startTime == 0` means now, else must be `≥ now`. `name` only emitted. `lastAccrual = now` |
| `deposit(poolId, amount)` | anyone | pool exists and not cancelled; `amount > 0`; `_accrue`; `balance += amount`; `transferFrom` |
| `setRate(poolId, rate)` | owner | not cancelled; `_accrue`; set. `0` = pause |
| `setShares(poolId, member, shares)` | owner | not cancelled; `member != 0`; `shares ≤ MAX_SHARES`; `_accrue`, `_settle`; update `totalShares` (≤ `MAX_TOTAL_SHARES`); no-op (same value) reverts `NoOp` |
| `setSharesBatch(poolId, members[], shares[])` | owner | same, ≤ `MAX_BATCH`, one `_accrue`; duplicates allowed (last wins); unchanged entries skipped silently |
| `setPayoutAddress(poolId, to)` | member (any address; stored even with 0 shares) | `to != address(this)`; `0` resets to self |
| `withdraw(poolId)` | member | `_accrue`, `_settle`; `units = pending / WAD_PER_UNIT`; revert `NothingToWithdraw` if 0; `pending −= units*1e12`; `owed −= units*1e12`; `balance −= units`; transfer to payout-or-self |
| `withdrawFor(poolId, member)` | anyone | identical; funds go to the member's payout, never to the caller |
| `withdrawForBatch(poolId, members[])` | anyone | ≤ `MAX_BATCH`; one `_accrue`; per member: settle, compute units; if 0 → skip; else update state and `try usdc.transfer`; on revert or `false` → restore that member's `pending`, pool `owed`/`balance`, emit `WithdrawSkipped`. Never reverts because of one member |
| `withdrawUnstreamed(poolId, amount, to)` | owner | `_accrue`; `amount ≤ balance − ceilDiv(owed, 1e12)`; `balance −= amount`; transfer |
| `cancel(poolId, to)` | owner | `_accrue`; `rate = 0`; `cancelled = true`; refund `balance − ceilDiv(owed, 1e12)` to `to` (may be 0); members keep withdrawing forever |
| `transferPoolOwnership(poolId, newOwner)` / `acceptPoolOwnership(poolId)` | owner / pendingOwner | two-step; works on cancelled pools too |
| Views | — | `getPool`, `getMember`, `claimable(poolId, member) → units` (simulated accrue+settle, floor), `fundedUntil`, `unstreamed(poolId) → units` |

Notes: `nonReentrant` on every function that transfers. Transfers use OZ `SafeERC20` except inside the batch `try` (raw call through an internal helper that returns success). A pool id that was never created reverts `PoolNotFound` (check `owner == 0`).

### 4.4 Events and errors
Events: `PoolCreated(poolId, owner, ratePerSecond, startTime, name)`, `Deposited(poolId, from, amount)`, `RateSet(poolId, oldRate, newRate)`, `SharesSet(poolId, member, oldShares, newShares, totalShares)`, `PayoutAddressSet(poolId, member, to)`, `Withdrawn(poolId, member, to, amount, caller)`, `WithdrawSkipped(poolId, member, amount)`, `UnstreamedWithdrawn(poolId, to, amount)`, `Cancelled(poolId, to, refund)`, `OwnershipTransferStarted(poolId, owner, pendingOwner)`, `OwnershipTransferred(poolId, oldOwner, newOwner)`. Every event that changes accrual inputs lets an indexer rebuild state with the SDK mirror.
Errors: `PoolNotFound`, `NotOwner`, `NotPendingOwner`, `PoolCancelled`, `ZeroAddress`, `ZeroAmount`, `BadRate`, `BadShares`, `BadStartTime`, `BadPayout`, `NoOp`, `NothingToWithdraw`, `InsufficientUnstreamed`, `LengthMismatch`, `TooManyItems`.

### 4.5 Invariants (Foundry invariant suite, handler with ≥ 5 actors and ≥ 3 pools)
- **I1** For every pool: `Σ_m (pending_m + shares_m × (accIndex − index_m) / 1e18) ≤ owed`, and the gap (dust) `≤ accrualCount × 1 wad + memberSettleCount × 1 wad` (track counters in the handler).
- **I2** For every pool: `owed ≤ balance × 1e12`.
- **I3** `Σ pools.balance ≤ usdc.balanceOf(DripPool)` (direct donations make it `<`).
- **I4** No owner action ever decreases any member's `claimable` (ghost-check before/after `setRate`, `setShares` on *another* member, `withdrawUnstreamed`, `cancel`, ownership transfer).
- **I5** Total paid to a member over any history `≤ Σ over intervals (rate × dt × shares/totalShares)` computed in exact rational arithmetic by the test (never over-pays).

### 4.6 Gas targets (measured, published in `docs/GAS.md`)
| Call | Target |
|---|---|
| `createPool` | ≤ 130k |
| `deposit` | ≤ 95k |
| `setShares` (new member) | ≤ 110k |
| `withdraw` / `withdrawFor` | ≤ 95k (≈ 0.002 USDC at 20 gwei) |
| `withdrawForBatch` per member | ≤ 60k |

---

## 5. SDK specification (`@arcdrip/sdk`)
- `constants.ts`: chain ids (5042, 5042002), RPCs, USDC address, `DRIP_POOL_ADDRESS` per chain (filled from `deployments/`), scales.
- `schemas.ts` (Zod): `PoolState`, `MemberState`, `PoolEvent` union; bigint-safe parsing.
- `math.ts`: pure, bigint, **bit-identical to §4.2**: `accrue(pool, now)`, `settle(pool, member)`, `claimable(pool, member, now) → units`, `fundedUntil(pool, now)`, `runwaySeconds(pool, now)`, `unstreamed(pool, now)`.
- `rate.ts`: `toRatePerSecond({amount: "1000", per: "month" | "week" | "day" | seconds}) → wad/s` (month = 30 days, documented), `fromRatePerSecond(rate, per)`, `memberRate(pool, member)`.
- `actions.ts` (viem): read (`getPool`, `getMember`, `claimableOnchain`), write (`createPool`, `approveAndDeposit`, `setRate`, `setShares`, `setSharesBatch`, `setPayoutAddress`, `withdraw`, `withdrawFor`, `withdrawForBatch`, `withdrawUnstreamed`, `cancel`, ownership pair). Writes simulate first and decode custom errors into typed results.
- `members.ts`: `getPoolMembers(client, poolId, {fromBlock})` from `SharesSet` logs, chunked at 10,000 blocks (public RPC cap), returns current non-zero members plus zero-share members with pending balance (needs one `getMember` multicall).
- `logger.ts`: pino, levels, optional `correlationId` on every action.
- ABI generated from Foundry output and checked in CI (`sdk:check-abi`, same as ArcPull).
- Optional `bridge.ts`: `withdrawAndBridge` (see §2.2, §14).

---

## 6. Web app (`apps/web`) — "Collective Payroll"
Static export, no server, wagmi + viem, EN/PT-BR. Pool id via query string (`/pool?id=7`), not dynamic routes.
| Page | Content |
|---|---|
| `/` | What it is in three lines, "Create a pool" form (name, amount per period → rate, optional start), recent pools from `PoolCreated` logs, link to docs |
| `/pool?id=` | Header: name, owner, rate as "X USDC / month", balance, **runway** ("23 d 4 h", red under 3 days, "frozen" when 0), status (scheduled / streaming / paused / frozen / cancelled). Member table: address, shares, % of pool, personal rate, claimable ticking every second from `math.ts` (re-sync from chain every 30 s and after each tx), Withdraw button on own row. Actions: Deposit (approve + deposit), **Pay everyone** (`withdrawForBatch`, chunks of 100). Owner panel: add / edit / remove member, set rate, pause/resume, withdraw unstreamed, cancel, transfer ownership. Member panel: set payout address |
| `/docs` | How the math works (the §4.2 block and a worked example), guarantees, "plug a Safe or any DAO as owner", comparison table vs Sablier / 0xSplits / Arc Studio Revenue Router, FAQ |
UX rules: every number shows USDC with 6 decimals max; ticking values use `requestAnimationFrame` throttled to 1 Hz; all writes show the decoded custom error on failure; wrong network prompts a switch to Arc.

---

## 7. Security and threat model (`docs/THREATS.md` must cover these)
| Threat | Handling |
|---|---|
| Owner rug of earned funds | `owed` is untouchable: `withdrawUnstreamed` and `cancel` are bounded by `balance − ceilDiv(owed)`; I4 |
| Owner rug of future funds | Allowed and documented: it is a payroll, the owner can pause, re-weight or cancel. Members are protected for the past, not the future |
| Insolvency / last-withdrawer loses | `dt` cap in `_accrue`; I2 |
| Rounding drift pays members more than streamed | All floors favour the pool; I1, I5 |
| Blocklisted member | Only their own withdrawal fails; batch skips and restores state; they can set a new payout address |
| Malicious payout address (contract that reverts) | USDC has no receive hooks; transfer to a contract cannot reenter. Still CEI + `nonReentrant` |
| Dust griefing via `withdrawFor` | Withdrawal < 1 unit reverts `NothingToWithdraw`; attacker only burns own gas; member's funds still arrive at their address |
| Front-running `setShares` with `withdrawFor` | Harmless: `setShares` settles first; accrued is identical either way |
| Timestamp manipulation | Validator skew of seconds moves sub-cent amounts between members of the same pool; documented |
| Overflow | `MAX_RATE`, `MAX_SHARES`, `MAX_TOTAL_SHARES`; fuzz at bounds |
| Pool squatting / spam pools | Pools are isolated by accounting; no global state a spammer can degrade |
| Fee-on-transfer / rebasing token | `usdc` is immutable and set at deploy; not a generic-token contract. Documented |
| Direct USDC transfers to the contract | Ignored by accounting (I3 is `≤`); unrecoverable, documented |
| Ownership to a wrong address | Two-step transfer |

---

## 8. Test plan

### 8.1 Contracts (Foundry), target ≥ 70 tests
Unit per function incl. every error. Scenarios: join mid-stream, leave mid-stream (accrued intact), re-weight, pause/resume, **freeze then deposit** (no back-pay), `setRate` and `setShares` **while frozen**, `totalShares == 0` period, future `startTime`, cancel with and without owed, withdraw after cancel, payout address, batch with a blocklisted member (ArcPull's USDC mock) and a zero-claimable member, 1 USDC/month precision over a simulated year, bounds (`MAX_*`). Fuzz: random op sequences vs an exact-rational reference model (I5). Invariant suite I1–I4. Gas snapshot committed. Fork test against Arc testnet USDC (`deposit`, `withdraw`).

### 8.2 SDK (Vitest), target ≥ 40 tests
`math.ts` vs contract: ≥ 30 vectors exported by a Foundry test to `test/vectors/accrual.json` (state, now → claimable, fundedUntil), asserted bit-identical. Rate helpers round-trip. Actions on anvil. Member discovery with chunked logs. Error decoding.

### 8.3 Web (Vitest + Testing Library), target ≥ 20 tests
Status derivation, runway formatting, ticking value equals `math.ts`, owner/member panel gating, batch chunking, i18n key parity EN/PT-BR. One Playwright smoke on the static export against anvil.

### 8.4 End-to-end on testnet (chain 5042002)
`scripts/e2e-testnet.ts`, idempotent, three keystores, prints tx hashes: create pool, shares 1/1/2, deposit small amount, wait, withdraw, add 4th member, let it freeze, deposit, `withdrawForBatch`, `withdrawUnstreamed`, cancel.

---

## 9. Facts the build relies on (research 2026-09-17/18)
- Arc: chain id 5042 mainnet / 5042002 testnet; RPC `https://rpc.mainnet.arc.io` / `https://rpc.testnet.arc.io`; faucet `https://faucet.circle.com`; explorer `https://explorer.arc.io` (Cloudflare-gated API; verify via Sourcify, which supports 5042). Block time ≈ 0.5 s, gas floor 20 gwei, gas paid in USDC.
- USDC ERC-20 view at `0x3600000000000000000000000000000000000000`, 6 decimals, FiatTokenV2_2-like (blocklist, EIP-3009). Implementation not on Sourcify.
- `eth_getLogs` capped at 10,000 blocks per call on the public RPC.
- Prior art on Arc (2026-09-18): streaming — Spigot (`github.com/Risingtell/spigot`, mainnet, agent metering, per-recipient), ArcFlow/FlowPay (testnet), Cadence (deck only); split — hackathon "ArcSplit" (`github.com/lhl200003/ArcSplit`, testnet, immutable splits), Splitsy (bill splitting), Arc Studio "Revenue Router" tutorial (official, testnet sample). None has time-based distribution with mutable shares. Sablier's chain list and 0xSplits do not include Arc.

---

## 10. Definition of done

### 10.1 Code (agents)
- [ ] `pnpm install && pnpm check` green at the repo root.
- [ ] Test counts meet §8; invariants I1–I5 pass at ≥ 256 runs × depth 100; gas snapshot committed; `docs/GAS.md` filled.
- [ ] `test/vectors/accrual.json` generated by Foundry and consumed by the SDK tests.
- [ ] Testnet e2e script dry-runs on anvil.
- [ ] Docs complete: README (tables in ArcPull style: what, why Arc, guarantees, addresses, proof), SPEC, THREATS, GAS, DEPLOY, CHECKLIST, SUBMISSION, AGENTS.md. Site copy EN + PT-BR.
- [ ] `site/index.html` and `.github/workflows/pages.yml` present.
- [ ] No secrets in the repo; `.env.example` only. Never read or print `/Users/r4to/Script/arc/.env`.

### 10.2 Human steps (`CHECKLIST.md`)
1. Fund deployer (main) with about 8 USDC; B, C, OPS need nothing (that is the point of `withdrawFor`), but give each 0.05 USDC for their own txs.
2. Deploy `DripPool(usdc)` with CREATE2 salt `keccak256("arcdrip.v1")`; record `deployments/arc-mainnet.json`; verify on Sourcify (exact match).
3. Proof pool 1 "r4to collective": rate 3 USDC/day, shares main 1 / B 1 / C 2. Deposit **1 USDC** (runway 8 h).
4. After ≥ 1 h: `withdraw` from C; `withdrawFor(B)` sent from OPS.
5. `setShares(OPS, 1)` mid-stream (join); `setPayoutAddress` from B to a fresh address.
6. Let it run dry (freeze). Record `claimable` stops growing. Deposit 5 USDC (resume, no back-pay).
7. `withdrawForBatch([main, B, C, OPS])` from any wallet; `setShares(B, 0)` (leave) then `withdrawFor(B)` still pays the accrued amount.
8. `setRate(0)` (pause), `setRate` back, `withdrawUnstreamed(1 USDC)`.
9. Proof pool 2: create, deposit 1 USDC, one member, cancel after 10 min; member withdraws after cancel.
10. Leave pool 1 streaming ≥ 3 days; then check with the SDK: `Σ withdrawn + Σ claimable + dust == streamed`.
11. Update README proof table, `deployments/arc-mainnet.json` `proofTxs`, `docs/GAS.md` mainnet column, site status line.
12. Push to `github.com/r4topunk/arcdrip` public, Pages enabled.
13. Submit the BUIDL on DoraHacks with `SUBMISSION.md`. The form keeps no drafts and dropdowns linger.

---

## 11. Repository layout
```
arcdrip/
  AGENTS.md  README.md  LICENSE (MIT)  CHECKLIST.md  DEPLOY.md  SUBMISSION.md  .env.example
  package.json  pnpm-workspace.yaml  .github/workflows/{ci.yml,pages.yml}
  contracts/   foundry.toml remappings.txt src/{DripPool.sol,interfaces/IDripPool.sol} test/{unit,fuzz,invariant,fork,mocks,vectors} script/{Deploy.s.sol,record-deployment.mjs}
  packages/sdk/     src/{index.ts,constants.ts,schemas.ts,math.ts,rate.ts,actions.ts,members.ts,logger.ts,abi/} test/
  apps/web/         Next.js static export, content/{en,pt-BR}/*.md
  scripts/          e2e-testnet.ts
  docs/             SPEC.md THREATS.md GAS.md
  deployments/      arc-testnet.json arc-mainnet.json
  site/index.html   project page (GitHub Pages root)
```
Root scripts mirror ArcPull: `build`, `test`, `check`, `lint`, `typecheck`, `contracts:*`, `sdk:check-abi`, `e2e:testnet`.

---

## 12. Execution plan for the build session (Workflow)

Run as a Workflow (the user's standing opt-in covers it). Agents on `opus` unless noted; every call sets `model` explicitly. Every agent gets this PRD path, the two reference repo paths, the target directory `/Users/r4to/Script/arc/arc-drip`, and the rule "never read `.env`". Phases are sequential; items inside a phase run in parallel.

| Phase | Agents (parallel) | Output | Gate |
|---|---|---|---|
| 0 Scaffold | 1 agent: monorepo skeleton from ArcPull/ArcSeal conventions, CI, lint, Foundry, empty packages | `pnpm check` green on the empty project | layout matches §11 |
| 1 Core | A: `DripPool.sol` + `IDripPool.sol` + unit tests + blocklist mock + vector export. B: SDK `math.ts`, `rate.ts`, `schemas.ts`, `constants.ts` written **from §4.2 only**, not from A's code (independent implementation is the cross-check) | tests green per package | B's math passes A's `accrual.json` vectors bit-identically; any mismatch is resolved against §4.2, not by copying |
| 2 Hardening + SDK | A: fuzz vs exact-rational model + invariant suite I1–I5 + gas snapshot + fork test. B: SDK actions, members, logger, ABI check, anvil tests. C (sonnet): `docs/SPEC.md` + `docs/THREATS.md` drafted from §4 and §7 | contracts ≥ 70, SDK ≥ 40 | verifier agent runs `pnpm check`, reads THREATS against §7 |
| 3 App | A: `apps/web` pages + tests + Playwright smoke. B (sonnet): `site/index.html`, EN/PT-BR content, README skeleton. C: `scripts/e2e-testnet.ts`, `Deploy.s.sol`, `DEPLOY.md` | smoke green; e2e dry-run on anvil | reviewer clicks through the static export |
| 4 Review | Two independent reviewers: adversarial security review of the contract against §4.5 and §7 (findings with repro tests; focus: frozen-pool paths, batch state restore, ceilDiv bounds, rounding direction); product review of copy against §2.3 | findings fixed or explicitly deferred | all CONFIRMED findings fixed; `pnpm check` green |
| 5 Handoff | 1 agent (sonnet): `CHECKLIST.md`, `SUBMISSION.md`, `AGENTS.md`, final README tables with TBD rows for mainnet | human checklist ready | Fable spot-checks sonnet output |

Budget guideline: about 10 agents. Testnet e2e and §10.2 are human-driven (keys, real USDC) and happen after the workflow.

---

## 13. Metrics
- Gas per call vs §4.6, in USDC.
- Dust after the 3-day mainnet proof: `streamed − Σ withdrawn − Σ claimable` < 1e-6 USDC.
- SDK mirror error vs chain: 0 units on every vector.
- Regression: gas snapshot, test counts and vector file in CI.

## 14. UNKNOWN
- Whether Bridge Kit / CCTP supports Arc mainnet as a source chain today, and its addresses. Phase 2B checks; if not, `bridge.ts` is dropped and documented as an option.
- Whether `arc-anvil` or plain anvil reproduces Arc's gas accounting closely enough for §4.6; if not, the mainnet column of `GAS.md` is the authority.
- Whether the batch `try` around `usdc.transfer` behaves the same against the real FiatToken blocklist revert as against the mock; the fork test must include a blocklisted-address case if a known blocked address exists on testnet, otherwise document as mock-only.
- Whether reviewers discount a fifth submission from the same builder (rules allow it).
