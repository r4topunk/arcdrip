# @sharedarc/web — Collective Payroll

The SharedArc reference app: create a pool, set members and shares, deposit, watch the balances fill, press
"Pay everyone". Static Next.js export (`output: 'export'`), no server and no backend, wagmi + viem, EN/PT-BR.
`pnpm build` writes `./out`.

## Pages

| Route | What it does |
|---|---|
| `/` | What SharedArc is in three lines, the "Create a pool" form (name, amount per period → rate, optional start), the pools created on this deployment, and an "open by id" box. |
| `/pool/?id=N` | Rate, balance, **runway**, status, and the member table ticking every second. Deposit (approve + deposit), "Pay everyone", the owner panel and the member panel. A static export cannot pre-render unknown ids, so the id is a query string, not a route. |
| `/docs/` | How the accrual works, the guarantees, plugging a Safe or a DAO as owner, the comparison table and the FAQ — rendered at build time from `content/{en,pt-BR}/docs.md`. |

## How the ticking works

Every claimable on the page comes from `@sharedarc/sdk`'s `math.ts`, which mirrors the contract's `_accrue` /
`_settle` bit for bit. The page reads the chain **every 30 seconds and after every transaction**; in between it
advances the same arithmetic locally once a second, with `requestAnimationFrame` throttled to 1 Hz (`useNow`).
The number on screen is therefore what the chain would pay this second, not an animation.

Accrual is decided by `block.timestamp`, so `useClockOffset` measures the chain's clock once a minute and shifts
the local one when the two disagree by more than ten seconds.

Statuses come from `poolStatus`: `scheduled`, `streaming`, `paused`, `frozen`, `cancelled`. Runway turns red
under three days and reads "frozen" at zero.

## Writes

Every write goes through `useTx`, which makes sure a wallet is connected on the configured chain and hands the
SDK action a `DripPoolConfig`. The SDK simulates before signing, so a call the contract would refuse costs no
gas and comes back as a value with the **custom error already decoded** (`NotOwner`, `NothingToWithdraw`,
`InsufficientUnstreamed`, …); `src/lib/errors.ts` maps each one to a sentence in the active language. A wallet
on the wrong chain gets a banner and a switch button.

"Pay everyone" plans the batch first (`planBatch`): members with nothing to withdraw are dropped, and the rest
are chunked at 100, the contract's `MAX_BATCH`. The contract skips a member whose USDC transfer fails instead
of reverting the batch, and those members are reported back in the UI.

## Build configuration

All optional; the defaults target Arc mainnet with no deployment configured (the app then says so instead of
reading the chain).

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_CHAIN_ID` | `5042` (default), `5042002` or `31337`. |
| `NEXT_PUBLIC_RPC_URL` | Overrides the chain's default RPC. |
| `NEXT_PUBLIC_DRIP_ADDRESS` | The `DripPool` singleton. Unset or a placeholder means "not configured". |
| `NEXT_PUBLIC_DRIP_DEPLOY_BLOCK` | First block scanned for logs. Unset means block 0, and a warning banner. |
| `NEXT_PUBLIC_USDC_ADDRESS` | Only for a local chain; on Arc it is the native USDC at `0x3600…0000`. |
| `NEXT_PUBLIC_EXPLORER_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_REPO_URL`, `NEXT_PUBLIC_BASE_PATH` | Links and the GitHub Pages sub-path. |

## Commands

```bash
pnpm dev          # next dev
pnpm build        # static export into ./out
pnpm test         # Vitest + Testing Library
pnpm typecheck
pnpm lint         # biome
pnpm e2e:smoke    # Playwright smoke over the static export
```

`e2e:smoke` picks its own mode. With anvil and `contracts/out` present it deploys `MockUSDC` + `DripPool` on a
throwaway node (one block per second, so the chain clock advances like Arc's), funds a pool with three members,
builds the export against it and drives the real UI: the ticking table, the owner panel, "Pay everyone" (checked
against the member's USDC balance), a deposit and the member panel. Without them it builds the unconfigured
export and checks the three pages and the language toggle. It installs Chromium if needed and exits 0 with
`SKIP` if it cannot. `SMOKE_MODE=static` forces the chainless path; `SHOTS_DIR=/tmp/shots` saves screenshots.

## Layout

```
src/lib/        config, i18n (EN + PT-BR), format (USDC, runway), errors, pool (status tone, batch plan), hooks, wagmi
src/components/ site chrome, providers, queries, tx; pool/ holds the table and the four panels
src/app/        /, /pool, /docs, 404
content/        docs.md per locale, rendered at build time
test/           Vitest suites; scripts/ holds the Playwright smoke and its static server
```
