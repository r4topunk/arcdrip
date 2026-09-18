# AGENTS.md: SharedArc

Instructions for AI agents and contributors working in this repo.

## TL;DR

```bash
git submodule update --init --recursive
pnpm install
pnpm build                  # forge build + sdk (tsup) + web static export (apps/web/out) + scripts
pnpm test                   # forge test (unit, fuzz, invariant, gas) + every vitest suite
pnpm check                  # build + test + typecheck + lint (biome) + forge fmt --check + ABI drift + gas snapshot
pnpm contracts:test         # forge test -vvv only
pnpm contracts:test:ci      # forge test, quiet (what `pnpm test` runs)
# read-only fork check against real Arc mainnet USDC (nothing broadcast); skipped unless ARC_RPC is set:
cd contracts && env ARC_RPC=https://rpc.mainnet.arc.io forge test --match-contract ArcUsdcForkTest -vv
# regenerate the SDK ABI after a contract change (writes packages/sdk/src/abi/DripPool.ts, generated, never hand-edited):
pnpm contracts:abi
pnpm sdk:check-abi          # fails if the committed module is stale (part of `pnpm check`)
# gas snapshot (contracts/.gas-snapshot; excludes invariant/fork — see docs/GAS.md):
pnpm contracts:snapshot         # regenerate
pnpm contracts:snapshot:check   # check at 5% tolerance (part of `pnpm check`)
# per-call gas table that feeds docs/GAS.md:
cd contracts && forge test --match-contract Gas -vv
# offline rehearsal of the whole PRD 8.4 flow on a local anvil (no keys, no network):
pnpm e2e:dry-run
pnpm e2e:dry-run --port 8600
# the web app against a local anvil:
pnpm --filter @sharedarc/web dev          # http://localhost:3000
pnpm --filter @sharedarc/web e2e:smoke    # Playwright smoke over the static export
```

If a command is not in this list, it is probably not the right command. Never invent a script name; check the
root `package.json`.

## Sources of truth

| Topic | File |
|---|---|
| Product scope, the 15 fixed decisions (D1–D15), non-goals, gas targets | `PRD.md` |
| Contract behaviour, accrual math, invariants, worked example | `docs/SPEC.md` |
| Per-threat security model, the Phase 4 review findings and what pins each | `docs/THREATS.md` |
| Contract ABI (binding) | `contracts/src/DripPool.sol`, `contracts/src/interfaces/IDripPool.sol` |
| Generated ABI for TS | `packages/sdk/src/abi/DripPool.ts` (never edit by hand — see TL;DR) |
| Gas numbers | `docs/GAS.md` |
| Addresses and proof txs | `deployments/arc-mainnet.json`, `deployments/arc-testnet.json` |
| Operator runbook (human steps) | `DEPLOY.md`, `CHECKLIST.md` |
| DoraHacks submission text | `SUBMISSION.md` |
| Optional cross-chain payout leg | `docs/CCTP.md` |

If code and `docs/SPEC.md` disagree, fix the code, or update SPEC in the same commit with a reason. The PRD's 15
decisions (D1–D15) are final: do not reopen them; a genuine gap goes in a doc's own UNKNOWN section, not into a
silent behaviour change.

## Layout

```
contracts/          Foundry (solc 0.8.30, evm prague, optimizer 10k runs), forge-std as a git submodule
  src/DripPool.sol        the immutable singleton: pools, shares, accumulated-index accrual, withdrawals
  src/interfaces/IDripPool.sol   the full external ABI with NatSpec; the SDK's ABI is generated from it
  script/                 Deploy.s.sol (CREATE2), record-deployment.mjs
  test/unit,fuzz,invariant,gas,fork,mocks,vectors/   see "Test layers" below
packages/sdk        @sharedarc/sdk    accrual mirror, rate helpers, viem actions, Zod schemas, member discovery,
                                    pino logging, optional CCTP leg
apps/web            @sharedarc/web    "Collective Payroll": Next.js static export, EN/PT-BR, wallet-only
scripts/            @sharedarc/scripts   e2e-testnet.ts (PRD 8.4) and its offline dry-run harness
docs/               SPEC.md, THREATS.md, GAS.md, CCTP.md
deployments/        arc-mainnet.json, arc-testnet.json (committed); anvil-dry-run.json (gitignored)
site/               index.html + og.png — project page, GitHub Pages root, no build step
```

## Test layers (`contracts/test/`)

- **unit/** — one file per behaviour area: `DripPoolCreate`, `DripPoolDeposit`, `DripPoolShares`,
  `DripPoolWithdraw`, `DripPoolBatch`, `DripPoolOwnerFunds`, `DripPoolOwnership`, `DripPoolViews`,
  `DripPoolBounds`, `DripPoolScenarios` (join/leave/re-weight/freeze/resume), `DripPoolGriefing` (the Phase 4
  review's repro + regression tests), on the shared fixture in `Base.t.sol`.
- **fuzz/** — `DripPoolFuzz.t.sol` against `RationalAcc.sol`, an exact-rational reference model: random operation
  sequences must never pay a member more than `rate × dt × shares / totalShares` (I5).
- **invariant/** — `DripPool.invariant.t.sol` + `DripPoolHandler.sol`: I1–I4 at 256 runs × depth 100.
- **gas/** — `DripPool.gas.t.sol`: the measurements behind `docs/GAS.md`, taken on cold storage with `vm.cool`.
- **fork/** — `ArcUsdc.fork.t.sol`: read-only checks against the real Arc mainnet USDC. Skipped unless `ARC_RPC`
  is set (4 tests skip by default; that is expected, not a failure).
- **vectors/** — `AccrualVectors.t.sol` exports 39 vectors to `test/vectors/accrual.json`, which
  `packages/sdk/test/vectors.test.ts` replays against the SDK's own `math.ts`. **Both sides must stay
  independent implementations of `docs/SPEC.md` §4** — never "fix" the mirror by porting Solidity into TS, or the
  cross-check stops checking anything. A mismatch is resolved against the spec.

Current counts (from a real `pnpm check` run on 2026-09-18 — re-check before trusting an older number):
contracts **191 passed + 4 skipped** (fork, no `ARC_RPC`) = 195 total; `@sharedarc/sdk` **217**; `@sharedarc/web`
**74**; `@sharedarc/scripts` **36**. Total 518.

## Conventions

- Language: English everywhere (code, comments, docs, commits). The web app and `site/index.html` additionally
  ship PT-BR strings (`apps/web/src/lib/i18n.ts`, `apps/web/content/pt-BR/*.md`, the `I18N` object in
  `site/index.html`); every EN string needs a PT-BR counterpart under the same key, and the glossary must match
  across the app and the site (`shares` → *shares*, a pool is feminine — *a pool*, *a dona* — and the live pill
  is *FLUINDO*). `apps/web/test/i18n.test.tsx` checks EN/PT key parity; keep it passing.
- Package manager: pnpm workspaces (`pnpm-workspace.yaml`). No npm or yarn lockfiles. Add a dependency with
  `pnpm --filter <pkg> add …`, never a bare `pnpm install` unless the lockfile really needs re-resolving.
- Units. On-chain and in the SDK, USDC is **6-decimal ERC-20 base units** (`bigint`) read from
  `0x3600000000000000000000000000000000000000`. The same address also exposes an 18-decimal *native* view of the
  identical balance — never read it, never sum the two, never mix decimals in a UI string. Internal accounting is
  **wad** = units × 1e12; `accIndex` is wad-per-share × 1e18. Every boundary between the two is a division that
  **floors**, and every floor favours the pool.
- Solidity: custom errors (no revert strings), NatSpec on every external function, checks-effects-interactions,
  `nonReentrant` on every function that transfers, OZ `SafeERC20` except inside the batch `try`. `forge fmt`,
  line length 120.
- TypeScript: strict, ESM, viem only (no ethers), Zod for every public SDK input and for env/config parsing in
  `scripts/` and `apps/web`. Biome for lint and format.
- Logging (`@sharedarc/sdk`): pino child logger with a `correlationId` per action (`packages/sdk/src/logger.ts`);
  `LOG_LEVEL=info`/`debug` surfaces it in the operator scripts.
- Tests that need a chain start their own throwaway anvil on a free port with unlocked dev accounts. Never
  hardcode a private key; sign from an unlocked account. Forge cheatcode accounts (`makeAddrAndKey`) are fine in
  tests only.
- Every contract function, every SDK math/rate/action helper and every non-trivial web helper (formatting, status
  derivation, error mapping) needs a test. A new custom error needs a Foundry revert test and, if it is
  user-facing, an entry in `apps/web/src/lib/errors.ts` (EN + PT-BR).
- Commits: small, imperative subject (for example `contracts: skip an unpayable batch entry before settling`).

## Invariants not to break

Load-bearing. A change to `DripPool.sol` that violates one needs a PRD decision update, not a tweaked assertion.

1. **I1 — dust is bounded.** `Σ_m (pending + shares × (accIndex − index) / 1e18) ≤ owed`, and the gap is at most
   `accrualCount × 1 wad + memberSettleCount × 1 wad`. Every division floors, always in the pool's favour.
2. **I2 — never owes more than it holds.** `owed ≤ balance × 1e12`. This is what `_accrue`'s `dt` cap enforces,
   and the cap *is* the freeze. Nothing may accrue past the funded time, and frozen time is never back-paid.
3. **I3 — pools are isolated.** `Σ pools.balance ≤ usdc.balanceOf(DripPool)`. A direct USDC transfer to the
   contract is ignored by the accounting (and unrecoverable — documented, not a bug).
4. **I4 — the owner controls the future, never the past.** No action moves a member's earned funds to another
   address, and no action reduces `claimable` beyond the I1 dust it triggers. `withdrawUnstreamed` and `cancel`
   are bounded by `balance − ceilDiv(owed, 1e12)`. Read `docs/SPEC.md` §6.2 for the exact wording — I4 is a bound,
   not an equality, and §6.2 says why.
5. **I5 — never over-pays.** Total paid to a member over any history is at most the exact-rational
   `Σ rate × dt × shares / totalShares`. Checked by the fuzz suite against `RationalAcc.sol`.
6. **Accrue before you mutate.** Every state-changing function calls `_accrue` *before* changing `rate`,
   `totalShares`, `balance` or `owed`, and `_settle` for every member it touches, right after. Reordering this is
   how members silently get re-priced over time they already earned.
7. **Payouts go to the member.** `withdrawFor` and `withdrawForBatch` are permissionless but must always send to
   the member's `payout`-or-self, never to the caller. `to == address(this)` is rejected everywhere
   (`BadPayout`).
8. **The batch skips, never reverts.** `withdrawForBatch` computes payable units from the *unsettled* state and
   `continue`s before writing when there is nothing to pay, and restores `pending`/`owed`/`balance` and emits
   `WithdrawSkipped` when a transfer reverts or returns `false`. One blocked member must never stall the rest,
   and a permissionless poke must never force a settle on an arbitrary address.
9. **Immutable.** No owner over the contract, no pause, no fee, no upgrade path, no `receive()`. The token is an
   immutable constructor argument.

## Hard rules

1. **Never send a transaction to Arc mainnet or Arc testnet** from an agent session. No `--broadcast` against a
   remote RPC, no `cast send` to a remote RPC. Local anvil only. `contracts/test/fork/*` stays read-only.
2. **Never read, cat, grep, source, print or copy `/Users/r4to/Script/arc/.env`, any other `.env*` file, a
   Foundry keystore, or a private key or seed.** Use `.env.example` only, and keep it to placeholders. Deploy and
   operator scripts take signers from Foundry encrypted keystores (`--account`), supplied by the human operator
   (`DEPLOY.md`). If a task seems to need a key, it is a human step — stop and say so.
3. **Never publish**: no `git push`, `gh repo create`, `npm publish`, or any deploy of `apps/web` / `site/`.
   Those are human steps in `CHECKLIST.md`.
4. Keep to the v1 scope in `PRD.md` §2. Anything in §2.2 (out of scope) is documentation only, never built.
5. Never write a `TBD` mainnet value as if it were real. Addresses, transaction hashes and mainnet gas numbers
   come from `deployments/*.json` after a human run, never from a guess.
6. Before calling work done, run the relevant commands above and report the **real** output — exact test counts,
   exact `pnpm check` exit code. Never an estimate, never a remembered number.
7. Other agents may be working in parallel in other directories of this repo. Touch only the paths you were
   given; keep any edit to a shared root file (lockfile, workspace file) minimal.

## Arc gotchas

- Chain id `5042` (mainnet, Foundry alias `arc`), `5042002` (testnet, alias `arc_testnet`); both RPCs are in
  `contracts/foundry.toml`.
- USDC `0x3600000000000000000000000000000000000000` is both the gas token and a 6-decimal ERC-20 view. Read only
  the ERC-20 view. A member who can send a transaction already holds USDC, which is why a payout to a
  zero-balance address is the rare case in `docs/GAS.md`.
- The USDC blocklist reverts `transfer`/`transferFrom` for a blocked address. That is the whole reason for the
  pull-plus-skip design (D5/D15). Only `MockUSDC` reproduces it locally; the real behaviour is unproven on
  mainnet (`PRD.md` §14).
- `eth_getLogs` is capped at 10,000 blocks on the public RPC: `packages/sdk/src/members.ts` and the web app's log
  scans paginate below that.
- EIP-7623 calldata floor pricing is active on Arc; `anvil --hardfork prague` reproduces it, which is what the
  dry run uses. It never actually binds for `DripPool`'s calls: even a 100-entry `withdrawForBatch` is
  execution-heavy (≈ 3.9M gas) against a calldata floor around 114k.
- Arc's USDC is a proxy over a native-coin precompile, which plain anvil does not emulate. Local gas for any call
  that moves tokens runs roughly 1k–3.5k **low** versus mainnet; the mainnet column of `docs/GAS.md` is the
  authority once the proof run fills it.
- Sourcify (not `explorer.arc.io`'s Blockscout API, which sits behind a Cloudflare challenge) is the verification
  path for both Arc chains. A CREATE2 deployment needs no hand-encoded constructor argument for a runtime exact
  match: the single `usdc` argument is an immutable and Sourcify recovers it (`DEPLOY.md` §5).
- Validator timestamp skew of a few seconds moves sub-cent amounts *between members of the same pool* and never
  changes the total streamed. Do not "fix" it; it is documented in `docs/THREATS.md`.
