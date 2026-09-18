# SharedArc

**A shared USDC stream for collectives on [Arc](https://arc.io): one rate, N shares, live runway.**

SharedArc is an MIT-licensed building block, not a SaaS. A pre-funded pool pays USDC per second, split among
members by mutable integer shares. Joining, leaving or re-weighting mid-stream is one O(1) write that touches
nobody else's storage. When the pool runs dry the stream freezes by itself and resumes on the next deposit, so
it can never owe more than it holds — and the owner can never touch what members have already earned.

It has three parts: one immutable singleton contract (`DripPool`), a TypeScript SDK that mirrors the accrual
math so a UI ticks per second without RPC calls, and a static reference app, "Collective Payroll".

> **Status:** **live on Arc mainnet** since 2026-09-18. `DripPool` is deployed at
> [`0x92b8fdB2c457b64d4510aC980A84283356D8A44f`](https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f)
> and verified on Sourcify (exact match). Proof rows 1–4 and 9 are recorded below; rows 5–8 land when proof pool 1
> runs dry (about 8 h after its first deposit) and row 10 after three days of streaming. **Unaudited and
> experimental**: keep amounts small.

> **Name:** the project was called ArcDrip until 2026-09-18 and was renamed to avoid a clash with an unrelated
> product of the same name on Arc. That is why the CREATE2 salt is `keccak256("arcdrip.v1")`; the contract,
> its address and every recorded transaction are unchanged.

| | |
|---|---|
| Contract | `DripPool` [`0x92b8fdB2c457b64d4510aC980A84283356D8A44f`](https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f) — [Sourcify exact match](https://repo.sourcify.dev/5042/0x92b8fdB2c457b64d4510aC980A84283356D8A44f), [deployments/arc-mainnet.json](deployments/arc-mainnet.json) |
| Project page | https://r4topunk.github.io/sharedarc/ |
| App | https://r4topunk.github.io/sharedarc/app/ — `apps/web` static export against the mainnet `DripPool` (pool 1: [/app/pool/?id=1](https://r4topunk.github.io/sharedarc/app/pool/?id=1)) |
| Chain | Arc mainnet, chainId 5042, USDC `0x3600000000000000000000000000000000000000` (ERC-20 view, 6 decimals) |

## What it does

An owner creates a pool with a `ratePerSecond` for the **whole pool** and gives each member an integer number
of shares. Anyone can deposit USDC into it. From then on every member's claimable balance grows every second,
in proportion to their shares, with no keeper and no per-period transaction. A member withdraws their own
balance, or anyone can push a payout to every member in one transaction ("Pay everyone").

The pool is the unit of accounting, so the treasury has **one** number to watch: `balance / rate` is the
runway, in days, for the whole collective at once.

### Guarantees enforced on-chain

| Guarantee | Mechanism |
|---|---|
| **Earned is earned** | `owed` (streamed and not yet withdrawn) is untouchable. `withdrawUnstreamed` and `cancel` are bounded by `balance − ceilDiv(owed, 1e12)`. Invariant I4 asserts that no owner action — `setRate`, `setShares` on another member, `withdrawUnstreamed`, `cancel`, ownership transfer — ever decreases any member's `claimable`. |
| **Never owes more than it holds** | `_accrue` caps elapsed time at `available / rate`. That cap *is* the freeze: an empty pool stops streaming instead of promising. Invariant I2: `owed ≤ balance × 1e12`. |
| **No back-pay after a freeze** | Frozen time is never recovered. A deposit resumes streaming from the deposit's own timestamp. |
| **Rounding always favours the pool** | Every division floors. Members collectively receive at most what was streamed; the remainder is dust that stays in `owed` (bounded below 1 wad = 1e-18 USDC per accrual by `MAX_TOTAL_SHARES`). Invariant I1 bounds the dust, and a fuzz run (I5) checks every payout against an exact-rational reference model. |
| **O(1) membership changes** | Accumulated-index accounting: `setShares` settles one member and updates `totalShares`. No loop over members, so the cost of adding the 100th member is the cost of adding the first. |
| **Payouts go to the member** | `withdrawFor` and `withdrawForBatch` are permissionless, but funds always go to the member's payout address, never to the caller. A member with no gas still gets paid by someone else. |
| **One blocked member cannot stall the rest** | `withdrawForBatch` wraps each transfer in a `try`: on a revert or a `false` return it restores that member's `pending` and the pool's `owed`/`balance` and emits `WithdrawSkipped`. The batch never reverts because of one member. |
| **Money never streams into the void** | With `totalShares == 0` nothing accrues and no funds are consumed. |
| **Exit is always open** | Removal is `setShares(member, 0)`: the accrued balance stays withdrawable forever, including after the pool is cancelled. |
| **No admin over the contract** | `DripPool` has no owner, no pause, no fee and no upgrade path. Each *pool* has its own owner (two-step transfer) and that owner's power is bounded by the rows above. |

### Non-goals

No token, no yield, no fees, no admin key over the contract, no upgradeability. **Not a Sablier clone**: there
are no per-recipient streams, only pools with shares. **Not a splitter**: nothing is distributed on arrival,
only over time. The owner's ability to pause, re-weight or cancel the *future* stream is deliberate — this is a
payroll, not an escrow.

## How the math works

One pool stores `ratePerSecond` (wad/s), `totalShares`, `balance` (USDC units), `owed` (wad already streamed
and not yet withdrawn) and `accIndex` (wad per share, ×1e18). A member stores `shares`, `index` and `pending`.
Internal amounts are **wad** = USDC units × 1e12, so 1 USDC/month is 385,802,469,135 wad/s rather than 0.

```
_accrue(p):                                     // the only place time enters
  from      = max(p.lastAccrual, p.startTime)
  available = p.balance * 1e12 - p.owed         // wad not yet streamed
  dt        = min(now - from, available / rate) // floor -> this is the freeze
  streamed  = rate * dt
  p.accIndex += streamed * 1e18 / p.totalShares // floor
  p.owed     += streamed
  p.lastAccrual = now

_settle(p, m):                                  // always right after _accrue
  m.pending += m.shares * (p.accIndex - m.index) / 1e18   // floor
  m.index    = p.accIndex
```

Every state-changing function accrues **before** touching `rate`, `totalShares`, `balance` or `owed`. Because
those parameters are constant between two accruals, capping `dt` is exactly equivalent to "streaming stopped
the moment the funds ran out", so no `fundedUntil` is stored — it is derived.

Worked example: rate 3 USDC/day, shares 1 / 1 / 2, balance 1 USDC. `available / rate` is 8 hours of runway.
After 1 hour the pool has streamed 0.125 USDC: 0.03125 to each 1-share member and 0.0625 to the 2-share one.
Add a fourth member with 1 share at that point and nothing already accrued moves; from that second on the four
of them split the same 3 USDC/day as 1/5, 1/5, 2/5, 1/5. At hour 8 the pool freezes with `claimable` frozen
too; a deposit of 1 USDC resumes it from the deposit's timestamp, with no credit for the frozen hours.

The same math is implemented twice: in Solidity, and independently in `packages/sdk/src/math.ts` from the spec.
A Foundry test exports 39 vectors to `contracts/test/vectors/accrual.json` and the SDK asserts its own results
are bit-identical to them, which is what lets the app tick locally instead of polling.

## Why Arc

| Arc property | What SharedArc does with it |
|---|---|
| USDC is the gas token **and** an ERC-20 (`0x3600…`, 6 decimals) | Treasury, payroll and gas are one asset. A member holding only their payroll can withdraw it. |
| Dollar-priced gas (20 gwei floor) | A withdrawal costs ≈ 0.002 USDC, and one `withdrawForBatch` of ten members costs ≈ 0.0009 USDC per member — so paying everyone is cheaper than everyone paying themselves. |
| Sub-second deterministic finality | The UI's local per-second simulation and the chain agree; no confirmation depth, no reorg handling in the SDK mirror. |
| USDC blocklist reverts transfers | Payouts are per-member pulls and the batch skips a failing member instead of reverting. |
| 6-decimal token, per-second accrual | Internal wad scaling (×1e12) keeps 1 USDC/month from rounding to zero per second, while transfers stay in whole USDC units. |
| `eth_getLogs` capped at 10,000 blocks | Member discovery from `SharesSet` logs is chunked to that window and finished with one multicall. |
| No Sablier, Superfluid, LlamaPay or 0xSplits on Arc | Greenfield: SharedArc is the primitive, not a front end over one. |
| CCTP V2 is live on Arc as a burn chain | Optional SDK helper: withdraw on Arc, then bridge the payout to another chain ([docs/CCTP.md](docs/CCTP.md)). Nothing bridge-related is in the contract. |

## Compared with

| | **SharedArc** | Sablier / LlamaPay | 0xSplits | Arc Studio "Revenue Router" |
|---|---|---|---|---|
| Unit | one pool: one rate, N shares | one stream per recipient | one split, applied on arrival | one router, fixed recipients |
| Time | continuous, per second | continuous, per second | none — instant on receipt | none — instant on receipt |
| Change a recipient's weight | one O(1) write; nobody else is touched, accrued stays | cancel + recreate that stream | new split config; past payouts unaffected | redeploy or reconfigure |
| Runway | one number for the whole collective | N remaining balances to add up | not applicable | not applicable |
| Funding | any address can top the pool up at any time | per stream, up front | whatever arrives | whatever arrives |
| Insolvency | impossible: accrual is capped by funded time, the stream freezes | stream simply runs out at its end date | not applicable | not applicable |
| Payout to a member with no gas | `withdrawFor` / `withdrawForBatch`, permissionless, pays the member | withdraw-for exists in some versions | push on distribute | push on distribute |
| On Arc | yes (this repo; deploy pending) | not deployed | not deployed ([0xSplits issue #77](https://github.com/0xSplits/splits-contracts/issues/77) open since 2026-04-08) | yes, as an official tutorial sample on testnet |

SharedArc is the product of stream × split: a splitter has shares but no time, a stream has time but no shares.
The "who gets what" and the "how fast" live in the same pool, which is why re-weighting is one write instead of
N cancellations.

## Quickstart

Requirements: Node ≥ 22, pnpm 11, Foundry.

```bash
git clone https://github.com/r4topunk/sharedarc && cd sharedarc
git submodule update --init --recursive
pnpm install
pnpm build          # forge build + sdk + web static export (apps/web/out)
pnpm test           # forge test (unit, fuzz, invariant) + every vitest suite
pnpm check          # build + test + typecheck + lint + forge fmt --check + ABI drift + gas snapshot
pnpm --filter @sharedarc/web dev      # http://localhost:3000
```

### Use the SDK

`@sharedarc/sdk` is not published to npm yet; it is a workspace package.

```ts
import {
  approveAndDeposit, claimable, createPool, getMember, getPool, payEveryone, poolStatus,
  runwaySeconds, setShares, toAccrualPool, toRatePerSecond, withdraw,
} from '@sharedarc/sdk';
import { createPublicClient, createWalletClient, custom, http } from 'viem';
import { arc } from 'viem/chains';

const publicClient = createPublicClient({ chain: arc, transport: http() });
const [account] = await window.ethereum.request({ method: 'eth_requestAccounts' });
const walletClient = createWalletClient({ account, chain: arc, transport: custom(window.ethereum) });
// `address` is optional once the deployment is recorded in deployments/arc-mainnet.json.
const config = { publicClient, walletClient, address: '0x…' as const };

const created = await createPool(config, {
  owner: account,
  ratePerSecond: toRatePerSecond({ amount: '3000', per: 'month' }), // month = 30 days
  name: 'r4to collective',
});
if (!created.ok) throw new Error(created.error.name); // custom errors are decoded, nothing is signed

await setShares(config, created.poolId, alice, 2n);
await approveAndDeposit(config, created.poolId, 1_240_000_000n); // 1,240 USDC, 6 decimals

// Read once, then tick locally: the same math as the contract, no RPC per second.
const pool = toAccrualPool(await getPool(config, created.poolId));
const member = await getMember(config, created.poolId, alice);
const now = () => BigInt(Math.floor(Date.now() / 1000));
claimable(pool, member, now());   // USDC units
runwaySeconds(pool, now());
poolStatus(pool, now());          // scheduled | streaming | paused | frozen | cancelled

await withdraw(config, created.poolId);                 // a member pays themselves
await payEveryone(config, created.poolId, everyone);    // anyone pays everyone, chunked at 100
```

Writes simulate first and return `{ ok: false, error }` with the custom error decoded rather than throwing a
raw revert. `pino` logging with a `correlationId` per action is built in.

## Gas

Measured with Foundry against a 6-decimal `MockUSDC` with a blocklist ([docs/GAS.md](docs/GAS.md)). The "tx"
column is what a sender actually pays (21,000 intrinsic + calldata + execution, EIP-7623 floor). At Arc's
20 gwei floor, 100k gas ≈ 0.002 USDC. Arc's USDC is a proxy over a native-coin precompile, so mainnet receipts
should run roughly 1k–3.5k higher on any call that moves tokens; the mainnet column is the authority once the
proof run fills it in.

| Call | PRD target | tx gas | ≈ USDC | vs target | Arc mainnet |
|---|---:|---:|---:|---|---:|
| `createPool` | ≤ 130,000 | 77,990 | 0.00156 | within | 78,014 |
| `deposit`, running pool | ≤ 95,000 | 97,537 | 0.00195 | **over by 2,537** | in progress (row 5); first deposit 94,420 |
| `setShares`, new member | ≤ 110,000 | 115,812 | 0.00232 | **over by 5,812** | 98,712 |
| `withdraw` | ≤ 95,000 | 107,267 | 0.00215 | **over by 12,267** | 166,744 (first in the pool) |
| `withdrawFor` | ≤ 95,000 | 107,562 | 0.00215 | **over by 12,562** | 137,543 (member's first) |
| `withdrawForBatch`, 10 members, per member | ≤ 60,000 | 45,091 | 0.00090 | within | not run (proof batch has 4) |
| `withdrawForBatch`, 100 members, per member | ≤ 60,000 | 39,066 | 0.00078 | within | not run (proof batch has 4) |

Four rows are over the PRD 4.6 targets and stay that way: they are dominated by cold `SSTORE`s that the
accounting needs (see docs/GAS.md for the per-slot breakdown). Batch payout is the cheap path and is what the
app's "Pay everyone" button uses.

## Trust model

| Actor | Can | Cannot |
|---|---|---|
| Pool owner | set the rate (0 = pause), set shares, withdraw the unstreamed balance, cancel, hand ownership over in two steps | reduce anyone's accrued balance, block a withdrawal, take what has already streamed, touch another pool |
| Member | withdraw any time, set a payout address, keep withdrawing after being removed or after a cancel | be paid for time the pool could not fund, be paid twice, force the owner to keep streaming |
| Anyone | create a pool, deposit into a live pool, call `withdrawFor` / `withdrawForBatch` and pay the gas | redirect a payout to themselves, withdraw on behalf of a member to another address |
| Deployer | nothing after deploy (no owner, no admin, no upgrade, no fee) | pause, upgrade or take fees |
| Circle (USDC issuer) | blocklist an address, which makes that member's transfer fail | stall the other members in a batch, or reduce the blocked member's accrued balance |

Known limits: a pool owner controls the future of the stream by design; USDC sent directly to the contract is
ignored by the accounting and unrecoverable; the contract is bound to one immutable token at deploy and is not
a generic-token contract; validator timestamp skew of a few seconds moves sub-cent amounts between members of
the same pool; withdrawals below 1 USDC unit revert with `NothingToWithdraw`. Full analysis, including threats
found during the build: [docs/THREATS.md](docs/THREATS.md). The contract is **unaudited**.

## Repository

| Path | Package | What |
|---|---|---|
| [`contracts/`](contracts) | Foundry | `DripPool.sol`, `IDripPool.sol`, unit + fuzz + invariant + gas + fork tests, blocklist mock, vector export, CREATE2 deploy script |
| [`packages/sdk`](packages/sdk) | `@sharedarc/sdk` | viem actions (simulate first, typed errors), Zod schemas, the accrual mirror, rate helpers, member discovery, optional CCTP leg |
| [`apps/web`](apps/web) | `@sharedarc/web` | "Collective Payroll": static Next.js export, EN and PT-BR, wallet-only (no server, no indexer) |
| [`scripts/`](scripts) | `@sharedarc/scripts` | Idempotent testnet end-to-end run over the full lifecycle |
| [`site/`](site) | | Project page published to GitHub Pages |
| [`deployments/`](deployments) | | Addresses, deploy block and proof transaction hashes per network |

Tests, from a real `pnpm check` run on 2026-09-18 (exit 0): **191** Foundry tests passing plus 4 fork tests
skipped without an Arc RPC, invariants I1–I4 as a Foundry invariant suite at 256 runs × depth 100, I5 (never
over-pays) as a fuzz run against an exact-rational reference model, **217** SDK tests including the 39 shared
accrual vectors, **74** web tests and **36** script tests — 518 in total.

## Mainnet proof

Every hash below was re-checked with `cast receipt` (status 1). The same hashes are in
[`deployments/arc-mainnet.json`](deployments/arc-mainnet.json) `proofTxs` and on the project page. Rows 5–8 run
when proof pool 1 runs dry (it was funded with 1 USDC at 3 USDC/day on 2026-09-18 18:54 UTC, so it freezes at
2026-09-19 02:54 UTC); row 10 needs three days of streaming. Amounts are reduced from the original plan (resume
deposit 1 USDC instead of 5, sweep 0.5 USDC instead of 1, pool 2 deposit 0.2 USDC instead of 1) to fit the
wallet's balance. Pool 2 also has one extra member `withdraw` sent *before* the cancel
([`0x8d9bfc93…`](https://explorer.arc.io/tx/0x8d9bfc93a196c139babeb37c24a6b1eb862897daf7f372472b4b51b3cabc0d2e),
an operator ordering slip); the cancel and the post-cancel `withdraw` in row 9 are the proof.

| # | Proof | Tx |
|---|---|---|
| 1 | Deploy `DripPool(usdc)` with CREATE2 salt `keccak256("arcdrip.v1")`, verified on Sourcify (exact match) | [deploy `0x40bb522a…`](https://explorer.arc.io/tx/0x40bb522a145c1a0617df2b08daa1f718b8e2b08c5141844265f25fb4338fa621) |
| 2 | Create proof pool 1 "r4to collective": 3 USDC/day, shares 1 / 1 / 2; deposit 1 USDC (8 h of runway) | [createPool `0xc46ded99…`](https://explorer.arc.io/tx/0xc46ded991975902399f5592699d769428262a8b85641762f04e6180a56741e17) · [setSharesBatch `0x445a5431…`](https://explorer.arc.io/tx/0x445a5431f608871356fa3e084941523006d9fd8928a812f08c0c8dc2b3a2dafa) · [approve `0x412ecbea…`](https://explorer.arc.io/tx/0x412ecbea1cab2449cf92521ad0741c58f4f235bb68e3d7faaafa6b3956916296) · [deposit `0xdcd8771e…`](https://explorer.arc.io/tx/0xdcd8771e113fc6606a361cbe66211c3da1ef7c11c0de4aaada12368d6cdd8f77) |
| 3 | `withdraw` by a member, and `withdrawFor` for another member paid by a third wallet | [withdraw (C) `0x5fce2ef1…`](https://explorer.arc.io/tx/0x5fce2ef1183527c979be15c65fc534cacd5c843c4f678ee6ede4c7e93ed1082d) · [withdrawFor(B) sent by OPS `0x2930f93a…`](https://explorer.arc.io/tx/0x2930f93a24bd2cf1ee4fa95dbc5cc870c6987abcf9f54a939bdfde5a270853af) |
| 4 | `setShares` mid-stream (a fourth member joins) and `setPayoutAddress` to a fresh address | [setShares(OPS, 1) `0x3b6d2b97…`](https://explorer.arc.io/tx/0x3b6d2b9740f1fa1fa1054d88099ae849502cf6c4eadb1e88be323bef1a4eb3f6) · [setPayoutAddress (B) `0x6e469441…`](https://explorer.arc.io/tx/0x6e469441377aa6e126caaee64a9683041cdc7248e60b1ac67b28abe3d3e60072) |
| 5 | Pool runs dry and freezes (`claimable` stops growing); deposit 1 USDC resumes it with no back-pay | in progress — pool 1 is live at [0x92b8…A44f](https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f) ([app](https://r4topunk.github.io/sharedarc/app/pool/?id=1)) |
| 6 | `withdrawForBatch` over all four members in one transaction, sent by one member (C) for everyone | in progress — pool 1 is live at [0x92b8…A44f](https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f) ([app](https://r4topunk.github.io/sharedarc/app/pool/?id=1)) |
| 7 | `setShares(member, 0)` (leave), then `withdrawFor` still pays that member the accrued amount | in progress — pool 1 is live at [0x92b8…A44f](https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f) ([app](https://r4topunk.github.io/sharedarc/app/pool/?id=1)) |
| 8 | `setRate(0)` (pause), `setRate` back, then `withdrawUnstreamed` of 0.5 USDC | in progress — pool 1 is live at [0x92b8…A44f](https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f) ([app](https://r4topunk.github.io/sharedarc/app/pool/?id=1)) |
| 9 | Proof pool 2: create, deposit 0.2 USDC, `cancel`, and the member withdraws **after** the cancel | [createPool `0xc0bc79e3…`](https://explorer.arc.io/tx/0xc0bc79e37451b8407a85a0588eb7a9cb4cb336f72a2e2bbaa9d10b1053d5224d) · [setShares(C, 1) `0x855f0d39…`](https://explorer.arc.io/tx/0x855f0d39ee98527ad61afa169df01900562fc5005bb9b89e9b528ebd24ba7b93) · [approve `0xbc59ad32…`](https://explorer.arc.io/tx/0xbc59ad3299a0f7d7744dd13cd96b7cf7f730485c73e47c64be0c06c1d4d84599) · [deposit `0x53f20456…`](https://explorer.arc.io/tx/0x53f2045644a09be8b8dadcabbbf0a4f0527cc96730aee743a44475928ad1d365) · [cancel `0x3fa2cf07…`](https://explorer.arc.io/tx/0x3fa2cf078949abee422a5c95ab405875b21b6eaacdae3b9f050490430f6d6cd6) · [withdraw after cancel (C) `0x1b0c57b5…`](https://explorer.arc.io/tx/0x1b0c57b5857f80972bf9790c186c1ce82cfae999b0e1721ba147fa125c454457) |
| 10 | After ≥ 3 days streaming: `Σ withdrawn + Σ claimable + dust == streamed`, reconciled with the SDK | in progress — pool 1 is live at [0x92b8…A44f](https://explorer.arc.io/address/0x92b8fdB2c457b64d4510aC980A84283356D8A44f) ([app](https://r4topunk.github.io/sharedarc/app/pool/?id=1)) |

## Docs

[PRD](PRD.md) · [Spec](docs/SPEC.md) · [Threat model](docs/THREATS.md) · [Gas](docs/GAS.md) ·
[CCTP on Arc](docs/CCTP.md) · [Deployment runbook](DEPLOY.md) · [Human checklist](CHECKLIST.md) ·
[Submission text](SUBMISSION.md) · [Working in this repo (agents)](AGENTS.md) ·
Interface: [`IDripPool.sol`](contracts/src/interfaces/IDripPool.sol)

## Credits

- [Arc](https://docs.arc.io) and [Circle](https://www.circle.com) for the chain, native USDC and CCTP V2.
- [Foundry](https://github.com/foundry-rs/foundry) and [forge-std](https://github.com/foundry-rs/forge-std),
  [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts), [viem](https://viem.sh),
  [wagmi](https://wagmi.sh), [Next.js](https://nextjs.org), [Tailwind CSS](https://tailwindcss.com),
  [zod](https://zod.dev), [Vitest](https://vitest.dev), [Biome](https://biomejs.dev).
- Prior art that shaped the design: Sablier and LlamaPay (per-recipient streaming), 0xSplits (share-based
  distribution), and the accumulated-index accounting pattern used by lending markets and staking rewards.

## License

[MIT](LICENSE)
