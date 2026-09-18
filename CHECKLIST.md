# CHECKLIST: human-only steps, in order

Everything in the repo is built and tested. These steps need a person: keys, real USDC, publishing. The detailed
commands, the wallet table and every failure mode are in [DEPLOY.md](DEPLOY.md); the paste-ready submission text
is in [SUBMISSION.md](SUBMISSION.md). This file is PRD §10.2 turned into an ordered runbook.

Commands are **fish** (the operator's shell), run from the repository root unless a row says `cd contracts`.
Steps marked **[SENDS]** broadcast a transaction and spend real USDC. No agent runs them.

**Definition of done:** `DripPool` is deployed on Arc mainnet and Sourcify-verified (exact match), the ten proof
rows in the README have real transaction hashes, `deployments/arc-mainnet.json` `proofTxs` matches them, the
repo is public with GitHub Pages live, and the BUIDL is submitted before **2026-10-14 23:59 ET**.

**Budget:** about **8 USDC** in total (deploy ≈ 0.046 USDC, everything else well under 0.01 USDC per call), plus
6 USDC of pool deposits that come back via `withdrawUnstreamed` / `cancel` or get streamed to your own wallets.

## Shell variables used by more than one step

Set these once per terminal (each `cast wallet address` asks for that keystore's password):

```fish
set DEPLOYER (cast wallet address --account arcdrip-deployer)
set WALLET_B (cast wallet address --account arcdrip-wallet-b)
set WALLET_C (cast wallet address --account arcdrip-wallet-c)
set OPS      0x…                 # the fourth member: an address you control, never signs
set USDC     0x3600000000000000000000000000000000000000
set DRIP     (jq -r .contracts.DripPool.address deployments/arc-mainnet.json)
set RATE     34722222222222       # 3 USDC/day in wad/s = 3e6 * 1e12 / 86400
```

`$RATE` is what `toRatePerSecond({ amount: '3', per: 'day' })` returns; re-derive it any time with
`node -e "console.log((3n*10n**18n/86400n).toString())"`.

---

## Steps

| # | PRD §10.2 | Step | Command / place | Done when | ✓ |
|---|---|---|---|---|---|
| 1 | — | Green build and a full offline rehearsal | `pnpm install; and pnpm check; and pnpm e2e:dry-run` | `pnpm check` exits 0; the dry run ends with `DONE: pool 1 cancelled, …` | [ ] |
| 2 | — | Preflight against the live chains (read-only) | [DEPLOY.md §0](DEPLOY.md) | `cast chain-id --rpc-url arc` → `5042`; USDC `decimals()` → `6`; CREATE2 deployer has code | [ ] |
| 3 | — | Create the three keystores | `cast wallet import arcdrip-deployer --interactive` (and `-wallet-b`, `-wallet-c`) — [DEPLOY.md §1](DEPLOY.md) | `cast wallet list` shows the three names; the four addresses are in your local `.env` (addresses only) | [ ] |
| 4 | 1 | **Fund the wallets [SENDS]**: ≈ 8 USDC to main, 0.05 USDC each to B, C and OPS | Bridge with Circle CCTP (App Kit Bridge), then split with `cast send` — [DEPLOY.md §4.1](DEPLOY.md) | `cast call $USDC "balanceOf(address)(uint256)" $DEPLOYER --rpc-url arc` ≥ `6000000`; B/C/OPS ≥ `50000` | [ ] |
| 5 | — | *(Optional but recommended)* full testnet rehearsal on 5042002 | [DEPLOY.md §3](DEPLOY.md): deploy, `node script/record-deployment.mjs 5042002`, `pnpm e2e:testnet` | `deployments/arc-testnet.json` lists twelve `proofTxs` | [ ] |
| 6 | 2 | **Deploy `DripPool(usdc)` [SENDS]**, CREATE2 salt `keccak256("arcdrip.v1")` | `cd contracts`; `forge script script/Deploy.s.sol --rpc-url arc --account arcdrip-deployer --sender $DEPLOYER` (simulate), then the same with `--broadcast` | output ends `deployed 0x…` + `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`; the address equals the testnet one | [ ] |
| 7 | 2 | Record the deployment | `cd contracts; and node script/record-deployment.mjs 5042; and cd ..` | `deployments/arc-mainnet.json` has `address`, `deployBlock`, `deployTx`, `saltHash`; `cast call $DRIP "usdc()(address)" --rpc-url arc` → `0x3600…0000` | [ ] |
| 8 | 2 | Verify on Sourcify (exact match) | `cd contracts; and forge verify-contract $DRIP src/DripPool.sol:DripPool --chain-id 5042 --verifier sourcify --watch` — [DEPLOY.md §5](DEPLOY.md) for the fallback | `curl -s "https://sourcify.dev/server/v2/contract/5042/$DRIP?fields=runtimeMatch"` → `"runtimeMatch":"exact_match"`; set `verified: true` in the JSON | [ ] |
| 9 | 3 | **Proof pool 1 [SENDS]**: create "r4to collective", 3 USDC/day | `cast send $DRIP "createPool(address,uint128,uint64,string)" $DEPLOYER $RATE 0 "r4to collective" --rpc-url arc --account arcdrip-deployer` | `cast call $DRIP "getPool(uint256)" 1 --rpc-url arc` returns owner `$DEPLOYER`, rate `$RATE`; `set POOL 1` | [ ] |
| 10 | 3 | **Shares 1 / 1 / 2 [SENDS]** (main, B, C) | `cast send $DRIP "setSharesBatch(uint256,address[],uint128[])" $POOL "[$DEPLOYER,$WALLET_B,$WALLET_C]" "[1,1,2]" --rpc-url arc --account arcdrip-deployer` | `getPool` shows `totalShares = 4` | [ ] |
| 11 | 3 | **Deposit 1 USDC [SENDS]** (runway 8 h) | `cast send $USDC "approve(address,uint256)" $DRIP 1000000 --rpc-url arc --account arcdrip-deployer`; then `cast send $DRIP "deposit(uint256,uint256)" $POOL 1000000 --rpc-url arc --account arcdrip-deployer` | `cast call $DRIP "fundedUntil(uint256)(uint64)" $POOL --rpc-url arc` ≈ now + 28,800 s | [ ] |
| 12 | 4 | Wait ≥ 1 h, then **`withdraw` from C [SENDS]** | `cast send $DRIP "withdraw(uint256)" $POOL --rpc-url arc --account arcdrip-wallet-c` | `Withdrawn` event with `caller == member == $WALLET_C`; C's USDC balance up ≈ 0.0625 USDC | [ ] |
| 13 | 4 | **`withdrawFor(B)` sent by OPS [SENDS]** — B never signs | `cast send $DRIP "withdrawFor(uint256,address)" $POOL $WALLET_B --rpc-url arc --account <ops keystore>` (any wallet works; OPS is the point) | `Withdrawn(poolId, B, B, amount, caller = OPS)`; the USDC lands on **B**, not on the caller | [ ] |
| 14 | 5 | **`setShares(OPS, 1)` mid-stream [SENDS]** (a fourth member joins) | `cast send $DRIP "setShares(uint256,address,uint128)" $POOL $OPS 1 --rpc-url arc --account arcdrip-deployer` | `totalShares = 5`; nobody else's `claimable` moved (check `cast call $DRIP "claimable(uint256,address)(uint256)" $POOL $WALLET_C --rpc-url arc` before and after) | [ ] |
| 15 | 5 | **`setPayoutAddress` from B to a fresh address [SENDS]** | `cast send $DRIP "setPayoutAddress(uint256,address)" $POOL 0x… --rpc-url arc --account arcdrip-wallet-b` | `getMember(POOL, $WALLET_B).payout` is the new address; the next `withdrawFor(B)` pays it | [ ] |
| 16 | 6 | Let the pool **run dry** (≈ 8 h after step 11) and record the freeze | `cast call $DRIP "claimable(uint256,address)(uint256)" $POOL $DEPLOYER --rpc-url arc` twice, 10 min apart; `cast call $DRIP "unstreamed(uint256)(uint256)" $POOL --rpc-url arc` | the two `claimable` reads are **identical**; `unstreamed` is 0; the app shows status `frozen` | [ ] |
| 17 | 6 | **Deposit 5 USDC [SENDS]** — the stream resumes with no back-pay | `cast send $USDC "approve(address,uint256)" $DRIP 5000000 …`; `cast send $DRIP "deposit(uint256,uint256)" $POOL 5000000 …` (both `--account arcdrip-deployer`) | `claimable` starts growing again from the deposit's own timestamp; the frozen hours are **not** credited (compare with the pre-deposit read from step 16) | [ ] |
| 18 | 7 | **`withdrawForBatch` over all four [SENDS]**, from any wallet | `cast send $DRIP "withdrawForBatch(uint256,address[])" $POOL "[$DEPLOYER,$WALLET_B,$WALLET_C,$OPS]" --rpc-url arc --account arcdrip-wallet-c` | one transaction, four `Withdrawn` events (or a `WithdrawSkipped` for anyone at zero); per-member gas ≈ 45k–60k | [ ] |
| 19 | 7 | **`setShares(B, 0)` (leave), then `withdrawFor(B)` still pays [SENDS]** | `cast send $DRIP "setShares(uint256,address,uint128)" $POOL $WALLET_B 0 …`; wait a moment; `cast send $DRIP "withdrawFor(uint256,address)" $POOL $WALLET_B …` | `totalShares = 4`; the second transaction still transfers B's accrued balance to B's payout address | [ ] |
| 20 | 8 | **Pause, resume, sweep the unstreamed part [SENDS]** | `cast send $DRIP "setRate(uint256,uint128)" $POOL 0 …`; check `claimable` is flat; `cast send $DRIP "setRate(uint256,uint128)" $POOL $RATE …`; `cast send $DRIP "withdrawUnstreamed(uint256,uint256,address)" $POOL 1000000 $DEPLOYER …` (all `--account arcdrip-deployer`) | `RateSet` ×2, `UnstreamedWithdrawn` for 1 USDC; no member's `claimable` fell across any of the three | [ ] |
| 21 | 9 | **Proof pool 2 [SENDS]**: create, deposit 1 USDC, one member, `cancel` after 10 min, member withdraws **after** the cancel | `createPool` → `set POOL2 2`; `setShares($POOL2, $WALLET_C, 1)`; `approve` + `deposit 1000000`; wait 10 min; `cast send $DRIP "cancel(uint256,address)" $POOL2 $DEPLOYER …`; then `cast send $DRIP "withdraw(uint256)" $POOL2 --account arcdrip-wallet-c` | `Cancelled(poolId, to, refund)` with `refund == balance − ceilDiv(owed,1e12)`; the post-cancel `withdraw` **succeeds** | [ ] |
| 22 | 10 | Leave pool 1 streaming **≥ 3 days**, then reconcile with the SDK | `pnpm --filter '@arcdrip/sdk...' build`; then a node one-liner over `getPool` / `getMember` / `claimable` (SDK `math.ts`) | `Σ withdrawn + Σ claimable + dust == streamed`, dust < 1e-6 USDC (PRD §13) | [ ] |
| 23 | 11 | Fill every `TBD`: README proof table + gas mainnet column, `deployments/arc-mainnet.json` `proofTxs`, `docs/GAS.md` mainnet column, site status line | `git grep -n TBD README.md docs/GAS.md SUBMISSION.md site/index.html` | the grep only returns rows that are genuinely still pending; each hash opens on `https://explorer.arc.io/tx/<hash>` with status `success` | [ ] |
| 24 | 11 | Rebuild and re-check with the deployment recorded | `pnpm check` | exit 0 | [ ] |
| 25 | 12 | Create the public repo and push | `git init` (if needed), `gh repo create r4topunk/arcdrip --public --source . --push` | `https://github.com/r4topunk/arcdrip` renders the README | [ ] |
| 26 | 12 | Enable GitHub Pages (source: GitHub Actions) and re-run `pages.yml` | repo Settings → Pages; `.github/workflows/pages.yml` | `https://r4topunk.github.io/arcdrip/` loads the project page and `…/app/` loads the dApp | [ ] |
| 27 | 13 | Record the 2-minute demo video | script in [SUBMISSION.md](SUBMISSION.md) | uploaded, URL in hand | [ ] |
| 28 | 13 | Fill the `TODO(owner)` fields and submit the BUIDL | [SUBMISSION.md](SUBMISSION.md) → `https://dorahacks.io/hackathon/arc-microgrants` | `grep -n "TODO(owner)\|TBD" SUBMISSION.md` returns nothing; the BUIDL is submitted | [ ] |

The DoraHacks form **keeps no draft** — fill every field in one sitting — and its dropdowns linger from a
previous attempt, so re-check each one before pressing submit.

## If short on time (minimum that still qualifies)

Steps 1, 3, 4, 6, 7, 8 (deploy + verify), then the short proof arc: 9, 10, 11, 12, 13, 18 (create → shares →
deposit → withdraw → withdrawFor → batch), then 23, 25, 26 and 28. Skip the testnet rehearsal (5), the freeze
and resume (16–17), pool 2 (21), the three-day reconciliation (22) and a polished video (27) — a screen capture
with the voice-over is enough. Mark the skipped README proof rows `not run` rather than leaving them `TBD`.

## Safety rules for this run

- Private keys never leave `~/.foundry/keystores`. Never `cat`, `echo` or `grep` a key, a seed or a `.env` file;
  pass signers as `--account <keystore-name>` only.
- One transaction at a time from the same wallet: Arc's sub-second blocks make nonce races easy to lose track of.
- Every `--rpc-url arc` is **mainnet money**. Double-check the alias before a `cast send`; `arc_testnet` is free.
- If a step fails, re-read the "Rollback and failure modes" table at the end of [DEPLOY.md](DEPLOY.md) before
  retrying — most failures need a different command, not the same one again.

## UNKNOWN

- Whether Sourcify records a **creation** match for a CREATE2 factory deployment when given
  `--creation-transaction-hash`. Only the runtime exact match is required (DEPLOY.md §5).
- Real mainnet gas for every call: `docs/GAS.md` has a local `MockUSDC` measurement and expects roughly +1k to
  +3.5k on Arc, where USDC is a proxy over a native-coin precompile. Step 23 fills the authoritative column.
- Whether a `withdrawForBatch` entry ever gets **skipped** on mainnet. The blocklist path is tested only against
  the mock (PRD §14); no known blocked address exists to prove it live, so that row of the threat model stays
  mock-only unless one turns up.
- Whether DoraHacks discounts a fifth BUIDL from the same builder (the rules allow it). Ask via the hackathon's
  "Ask Question" before submitting if it matters to you.
- The current grant amount and whether the form asks for a use-of-funds breakdown — check the live form and fill
  the matching section of [SUBMISSION.md](SUBMISSION.md).
