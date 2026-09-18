# DoraHacks BUIDL submission: Arc Microgrants

Paste-ready fields for https://dorahacks.io/hackathon/arc-microgrants. Deadline: **2026-10-14 23:59 ET**.
The form keeps no draft (fill every field in one sitting) and its dropdowns linger from a previous attempt
(re-check each one before submitting) — see [CHECKLIST.md](CHECKLIST.md).
Filled from the repo and from mainnet receipts as of 2026-09-18. Proof rows that cannot exist yet (5–8 need proof
pool 1 to run dry, row 10 needs three days of streaming) read "in progress" with the pool's explorer link;
**never fill one with a guess.**

## Name

ArcDrip

## One-liner (≤ 100 chars)

A shared USDC stream for collectives on Arc: one rate, N shares, live runway.

## Description (≤ 300 words)

ArcDrip is an MIT-licensed streaming-payroll primitive for Arc — a building block, not a SaaS.

A collective paying contributors has two bad options today. Discrete transfers mean someone must remember,
sign and get the amounts right every period. Per-recipient streams mean re-weighting is cancel-and-recreate
across N streams, and the treasury's runway is spread over N balances. Splitters divide what arrives, instantly,
with no notion of time.

ArcDrip is the product of stream × split. One immutable singleton, `DripPool`, holds many pools. A pool has one
`ratePerSecond` for the whole collective and gives each member an integer number of shares. Anyone can deposit
USDC into it; from then on every member's claimable balance grows every second in proportion to their shares,
with no keeper and no per-period transaction. The treasury watches **one** number: `balance / rate` is the
runway for everyone at once.

Joining, leaving or re-weighting mid-stream is one O(1) write that touches nobody else's storage, because the
accounting is an accumulated index rather than a loop over members. Adding the hundredth member costs what the
first one cost.

Three guarantees are enforced on-chain. **Earned is earned:** `withdrawUnstreamed` and `cancel` are bounded by
`balance − ceilDiv(owed)`, and a Foundry invariant asserts no owner action ever lowers a member's claimable.
**Never owes more than it holds:** accrual caps elapsed time at `available / rate`, so an empty pool freezes
instead of promising, and resumes on the next deposit with no back-pay. **Payouts go to the member:**
`withdrawFor` and `withdrawForBatch` are permissionless but always pay the member's own payout address, so a
contributor holding no gas still gets paid.

No token, no yield, no fees, no admin key over the contract, no upgradeability.

## How Arc is used

Gas on Arc is paid in USDC at a 20 gwei floor, so the treasury, the payroll and the gas are the same asset: a
member who holds nothing but their payroll can withdraw it for about 0.002–0.003 USDC, and one `withdrawForBatch` of
ten members costs about 0.0009 USDC per member — paying everyone is cheaper than everyone paying themselves.
USDC is native to Arc *and* an ERC-20 at `0x3600000000000000000000000000000000000000` (6 decimals); ArcDrip
reads only the ERC-20 view and never mixes it with the 18-decimal native view of the identical balance.

Arc's sub-second deterministic finality is what lets the reference app tick locally: the SDK mirrors the accrual
math exactly, so a balance can count up every second in the browser with no RPC call and no confirmation depth,
and the chain agrees when you read it back.

USDC's compliance blocklist reverts transfers to a flagged address, which is why every payout is a pull and why
`withdrawForBatch` wraps each transfer in a `try`: on a revert or a `false` return it restores that member's
`pending` and the pool's `owed`/`balance` and emits `WithdrawSkipped`. One blocked member can never stall the
other ninety-nine.

Arc's 6-decimal token with per-second accrual is also why internal amounts are **wad** (USDC units × 1e12):
1 USDC/month is 385,802,469,135 wad/s rather than rounding to zero. `eth_getLogs` is capped at 10,000 blocks on
the public RPC, so member discovery from `SharesSet` logs is chunked to that window and finished with one
multicall. Nothing bridge-related is in the contract; CCTP V2 is an optional SDK leg, documented separately.

## What is built

- `DripPool.sol` + `IDripPool.sol`: one immutable Foundry singleton (no owner, no pause, no upgrade, no fee),
  accumulated-index accrual, freeze-on-empty, pull withdrawals with permissionless push-to-member, batch payout
  that skips instead of reverting, two-step per-pool ownership. Unit, fuzz, invariant, gas and read-only Arc
  fork tests, plus a griefing-regression suite from the Phase 4 adversarial review. Committed gas snapshot,
  CREATE2 deploy script.
- `@arcdrip/sdk`: the accrual mirror (`claimable`, `runwaySeconds`, `fundedUntil`, `unstreamed`, `poolStatus`)
  implemented **independently from the spec**, not ported from the Solidity, and cross-checked against 39
  vectors that a Foundry test exports to `contracts/test/vectors/accrual.json`; rate helpers; viem actions for
  every call that simulate first and return decoded custom errors instead of raw reverts; member discovery from
  chunked logs; Zod schemas; pino logging with a correlation id per action; an optional CCTP bridge leg.
- `apps/web`: "Collective Payroll", a static Next.js export (EN/PT-BR, wallet-only, no server and no indexer) —
  create a pool, set members and shares, deposit, watch every balance tick, read the runway as "23 d 4 h", press
  "Pay everyone", and an owner panel for rate, shares, pause, sweep, cancel and ownership transfer.
- `scripts/`: an idempotent testnet end-to-end run over the full lifecycle, which doubles as an offline
  anvil rehearsal (`pnpm e2e:dry-run`) that is itself a test.
- Docs: a full spec (`docs/SPEC.md`), a per-threat security model (`docs/THREATS.md`), a measured gas breakdown
  (`docs/GAS.md`), a CCTP note (`docs/CCTP.md`) and an operator runbook (`DEPLOY.md` + `CHECKLIST.md`).
- Test counts from a real `pnpm check` run on 2026-09-18: contracts **191 passed + 4 skipped** (read-only Arc
  fork tests, skipped without `ARC_RPC`), `@arcdrip/sdk` **217**, `@arcdrip/web` **74**, `@arcdrip/scripts`
  **36** — **518 tests**, all passing, `pnpm check` exits 0. Invariants I1–I5 run at 256 runs × depth 100.

## Tech stack

- **Chain:** Arc mainnet (chainId 5042), USDC `0x3600…0000` (native + ERC-20 view, 6 decimals)
- **Contracts:** Solidity 0.8.30, Foundry (unit, fuzz against an exact-rational reference model, invariant, gas,
  read-only mainnet fork), OpenZeppelin `SafeERC20` + `ReentrancyGuard`, CREATE2 deploy, immutable
- **SDK:** TypeScript, viem, Zod, tsup, Vitest, pino
- **Web:** Next.js (static export), React, wagmi, Tailwind CSS, shadcn/ui, EN/PT-BR
- **Tooling:** pnpm workspaces, Biome, GitHub Actions (CI + Pages)
- **License:** MIT

## Links

| Field | Value |
|---|---|
| Live link (hosted dApp on mainnet) | https://r4topunk.github.io/arcdrip/app/ |
| Project page | https://r4topunk.github.io/arcdrip/ |
| Public repo | https://github.com/r4topunk/arcdrip |
| Proof pool 1 in the dApp (balances ticking live) | https://r4topunk.github.io/arcdrip/app/pool/?id=1 |
| `DripPool` contract | https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f |
| Source verification (Sourcify, exact match) | https://repo.sourcify.dev/5042/0x92b8fdB2c457b64d4510aC980A84283356D8A44f |
| Demo video | none (optional) |
| Builder profile (GitHub / X / Farcaster) | https://github.com/r4topunk · https://x.com/r4topunk · https://farcaster.xyz/r4topunk |

## Team

Team r4to: r4to (r4topunk), solo builder. Researcher and builder working on AI agents and Web3. GitHub https://github.com/r4topunk, X and Farcaster @r4topunk. Designed, built, tested and deployed ArcDraw, ArcPull, MemoKit, ArcSeal, ArcPet and ArcDrip on Arc mainnet.

## Grant and next milestones

This targets the same Arc Microgrants (DoraHacks) track as the author's other 2026-09 submissions (ArcPull,
ArcSeal). Grant requested: the fixed 500 USDC microgrant; no use-of-funds breakdown.

Candidate milestones, taken from the repo docs (PRD §2.2 out-of-scope items, recorded as options, not promises):

1. A hosted, always-on copy of `apps/web` (today it is a static export anyone can build and serve themselves).
2. `depositWithAuthorization` (EIP-3009): fund a pool gaslessly with a signature, so a donor needs no Arc USDC.
3. An on-chain CCTP leg — `withdrawCrossChain` via `TokenMessenger.depositForBurn` — so a contributor can take
   their payout to another chain in one transaction. Deliberately kept out of v1's audit surface.
4. Publish `@arcdrip/sdk` to npm (today it is workspace-only) and ship a small embeddable "runway" widget.
5. Explore waterfall / tiered splits and transferable stream positions as v2 options.

## Mainnet deployment

From `deployments/arc-mainnet.json`.

| Contract | Address | Deploy tx | Block | Verified |
|---|---|---|---|---|
| DripPool | [`0x92b8fdB2c457b64d4510aC980A84283356D8A44f`](https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f) | [`0x40bb…a621`](https://explorer.arc.io/tx/0x40bb522a145c1a0617df2b08daa1f718b8e2b08c5141844265f25fb4338fa621) | 21543579 | yes — Sourcify exact match (runtime and creation) |

Deployed with CREATE2 salt `keccak256("arcdrip.v1")` =
`0xf565c9179457d16efba5e73e31ac6a25a183c67a440009e4dd04baf336278b6d`, one constructor argument
(`usdc = 0x3600…0000`) stored as an immutable, so Sourcify recovers it from the deployed code and no encoded
constructor argument is needed for a runtime exact match (`DEPLOY.md` §5). The contract has no owner, no pause
and no upgrade path: nothing is held back after deploy.

## Mainnet proof transactions

Same data as `deployments/arc-mainnet.json` `proofTxs` and the README's Mainnet proof table. Every hash has
receipt status 1. Rows 5–8 run when proof pool 1 runs dry (2026-09-19 ≈ 02:54 UTC) and row 10 after three days.

| # | Proof | Tx |
|---|---|---|
| 1 | Deploy `DripPool(usdc)` (CREATE2), Sourcify exact match | deploy: https://explorer.arc.io/tx/0x40bb522a145c1a0617df2b08daa1f718b8e2b08c5141844265f25fb4338fa621 |
| 2 | Proof pool 1 "r4to collective": 3 USDC/day, shares 1 / 1 / 2, deposit 1 USDC (8 h of runway) | createPool: https://explorer.arc.io/tx/0xc46ded991975902399f5592699d769428262a8b85641762f04e6180a56741e17 · setSharesBatch: https://explorer.arc.io/tx/0x445a5431f608871356fa3e084941523006d9fd8928a812f08c0c8dc2b3a2dafa · approve: https://explorer.arc.io/tx/0x412ecbea1cab2449cf92521ad0741c58f4f235bb68e3d7faaafa6b3956916296 · deposit: https://explorer.arc.io/tx/0xdcd8771e113fc6606a361cbe66211c3da1ef7c11c0de4aaada12368d6cdd8f77 |
| 3 | `withdraw` by a member, and `withdrawFor` for another member paid by a third wallet | withdraw (C): https://explorer.arc.io/tx/0x5fce2ef1183527c979be15c65fc534cacd5c843c4f678ee6ede4c7e93ed1082d · withdrawFor(B) sent by OPS: https://explorer.arc.io/tx/0x2930f93a24bd2cf1ee4fa95dbc5cc870c6987abcf9f54a939bdfde5a270853af |
| 4 | `setShares` mid-stream (a fourth member joins) and `setPayoutAddress` to a fresh address | setShares(OPS, 1): https://explorer.arc.io/tx/0x3b6d2b9740f1fa1fa1054d88099ae849502cf6c4eadb1e88be323bef1a4eb3f6 · setPayoutAddress (B): https://explorer.arc.io/tx/0x6e469441377aa6e126caaee64a9683041cdc7248e60b1ac67b28abe3d3e60072 |
| 5 | The pool runs dry and freezes (`claimable` stops growing); a 1 USDC deposit resumes it with no back-pay | in progress — pool 1 is live: https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f · https://r4topunk.github.io/arcdrip/app/pool/?id=1 |
| 6 | `withdrawForBatch` over all four members in one transaction, sent by one member (C) for everyone | in progress — pool 1 is live: https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f · https://r4topunk.github.io/arcdrip/app/pool/?id=1 |
| 7 | `setShares(member, 0)` (leave), then `withdrawFor` still pays that member the accrued amount | in progress — pool 1 is live: https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f · https://r4topunk.github.io/arcdrip/app/pool/?id=1 |
| 8 | `setRate(0)` (pause), `setRate` back, then `withdrawUnstreamed` of 0.5 USDC | in progress — pool 1 is live: https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f · https://r4topunk.github.io/arcdrip/app/pool/?id=1 |
| 9 | Proof pool 2: create, deposit 0.2 USDC, `cancel`, and the member withdraws **after** the cancel | createPool: https://explorer.arc.io/tx/0xc0bc79e37451b8407a85a0588eb7a9cb4cb336f72a2e2bbaa9d10b1053d5224d · setShares(C, 1): https://explorer.arc.io/tx/0x855f0d39ee98527ad61afa169df01900562fc5005bb9b89e9b528ebd24ba7b93 · approve: https://explorer.arc.io/tx/0xbc59ad3299a0f7d7744dd13cd96b7cf7f730485c73e47c64be0c06c1d4d84599 · deposit: https://explorer.arc.io/tx/0x53f2045644a09be8b8dadcabbbf0a4f0527cc96730aee743a44475928ad1d365 · cancel: https://explorer.arc.io/tx/0x3fa2cf078949abee422a5c95ab405875b21b6eaacdae3b9f050490430f6d6cd6 · withdraw after cancel (C): https://explorer.arc.io/tx/0x1b0c57b5857f80972bf9790c186c1ce82cfae999b0e1721ba147fa125c454457 |
| 10 | After ≥ 3 days streaming: `Σ withdrawn + Σ claimable + dust == streamed`, reconciled with the SDK | in progress — pool 1 is live: https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f · https://r4topunk.github.io/arcdrip/app/pool/?id=1 |

PRD §10.2 definition of done: all ten rows recorded, each transaction status `success` on
`https://explorer.arc.io`, and the three-day reconciliation showing dust below 1e-6 USDC.

## Demo video script (2:00)

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:15 | Project page hero, the one-pool-many-members diagram | "ArcDrip is a shared USDC stream for collectives on Arc. One rate, N shares, one runway number for everyone." |
| 0:15–0:35 | The `_accrue` / `_settle` block on the docs page | "The whole thing is an accumulated index. Changing someone's weight is one write that touches nobody else's storage — adding the hundredth member costs what the first one cost." |
| 0:35–0:55 | `/pool?id=1` with four balances ticking, the runway counter | "Every balance counts up every second, in the browser, with no RPC call: the SDK mirrors the contract's math exactly. The treasury watches one number — balance over rate — not four." |
| 0:55–1:20 | Owner panel: add a member mid-stream; the other three balances don't move | "A contributor joins mid-stream. Nothing already earned moves. From this second on the four of them split the same rate by weight." |
| 1:20–1:40 | Let it freeze, then deposit; the explorer tx | "When the pool runs dry it freezes by itself — it can never owe more than it holds. A deposit resumes it from that timestamp, with no back-pay for the frozen hours." |
| 1:40–1:55 | "Pay everyone" → one `withdrawForBatch` tx on the explorer | "Anyone can pay everyone in one transaction, about nine hundredths of a cent per member. The money always goes to the member's own address, never to the caller — so a contributor holding no gas still gets paid." |
| 1:55–2:00 | Sourcify exact-match page, then the repo | "Immutable, unaudited, MIT, no token, no fees, no admin key." |

Recording tips: record at 1440p; do the mid-stream join and the freeze live against the real mainnet pool rather
than a canned demo — the point is that the other balances visibly do not move.

## Before pasting

- [x] Contract deployed and Sourcify-verified (exact match) — [CHECKLIST.md](CHECKLIST.md) steps 6–8
- [x] Public repo pushed and project page live — [CHECKLIST.md](CHECKLIST.md) steps 25–26
- [ ] All ten proof rows have status `success` on mainnet and are recorded above and in
      `deployments/arc-mainnet.json` (rows 1–4 and 9 done 2026-09-18; 5–8 and 10 in progress)
- [x] `docs/GAS.md` mainnet column filled for the calls measured so far — [CHECKLIST.md](CHECKLIST.md) step 23
- [x] Test counts re-checked against a fresh `pnpm check` (2026-09-18: 191 + 4 skipped, 217, 74, 36)
- [x] Demo video: none (optional)
- [x] X/Farcaster profile and team line
- [x] Grant: fixed 500 USDC, no use-of-funds breakdown
- [x] No placeholder left in the pasted text (the grep for placeholders returns nothing)
