# DEPLOY: SharedArc (DripPool) on Arc

Runbook for the **human operator**. Agents never run the testnet or mainnet steps: those need keys and spend real USDC (testnet USDC is free from the faucet). Every step that sends a transaction is marked **[SENDS]**; everything else is read-only or local.

Commands are **fish** (the operator's shell). Environment variables go on the command line with `env VAR=value cmd`, shell variables are set with `set`, and command substitution is `(cmd)`. Private keys never appear on a command line, in an environment variable or in a file in this repository: every signer is a Foundry encrypted keystore in `~/.foundry/keystores`, and the scripts only ever learn a keystore **name**.

## TL;DR

```fish
# 0. local: green build and a full rehearsal of the flow (no keys, no network)
pnpm install; and pnpm check; and pnpm e2e:dry-run

# 1. keystores: hidden prompt, paste each key once (main wallet = deployer and pool owner)
cast wallet import arcdrip-deployer --interactive
cast wallet import arcdrip-wallet-b --interactive
cast wallet import arcdrip-wallet-c --interactive
set DEPLOYER (cast wallet address --account arcdrip-deployer)
set WALLET_B (cast wallet address --account arcdrip-wallet-b)
set WALLET_C (cast wallet address --account arcdrip-wallet-c)

# 2. testnet [SENDS]: deploy, record, then the end-to-end run (idempotent; re-run it to resume)
cd contracts
forge script script/Deploy.s.sol --rpc-url arc_testnet --account arcdrip-deployer --sender $DEPLOYER --broadcast
node script/record-deployment.mjs 5042002
cd ..; and pnpm e2e:testnet

# 3. mainnet [SENDS]: deploy (CREATE2, salt keccak256("arcdrip.v1")), record, verify
cd contracts
forge script script/Deploy.s.sol --rpc-url arc --account arcdrip-deployer --sender $DEPLOYER --broadcast
node script/record-deployment.mjs 5042
set DRIP_POOL (jq -r .contracts.DripPool.address ../deployments/arc-mainnet.json)
forge verify-contract $DRIP_POOL src/DripPool.sol:DripPool --chain-id 5042 --verifier sourcify --watch
# 4. proof pools, README, site, submission: CHECKLIST.md
```

| Item | Value |
|---|---|
| Chains | Arc mainnet `5042` (Foundry alias `arc`), Arc testnet `5042002` (alias `arc_testnet`), both in `contracts/foundry.toml` |
| RPC | `https://rpc.mainnet.arc.io`, `https://rpc.testnet.arc.io` |
| Explorer | `https://explorer.arc.io` (Blockscout; its API sits behind a Cloudflare challenge, so verification goes to Sourcify) |
| USDC | `0x3600000000000000000000000000000000000000`, the 6-decimal ERC-20 view of the native gas token. The native balance is the same USDC in an 18-decimal view: never add the two |
| CREATE2 deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` (present on both Arc networks and on every anvil) |
| Salt | `keccak256("arcdrip.v1")` = `0xf565c9179457d16efba5e73e31ac6a25a183c67a440009e4dd04baf336278b6d`. The project was called ArcDrip until 2026-09-18 (renamed to SharedArc), hence the label; it stays as is because the salt fixes the address |
| Constructor | `DripPool(usdc)` — one argument, stored as an immutable. The same argument on both networks gives the same address |
| Immutable | No owner over the contract, no upgrade, no global pause (PRD D7/D14). A mistake means a new deployment with a new salt label (see Rollback) |
| Mainnet scope | The `DripPool` singleton only. Pools are created afterwards by anyone, from the site or with `cast` |
| Budget | About 8 USDC in total (PRD 10.2). Deploy is 2,291,685 gas in the local dry run, about **0.046 USDC** at the 20 gwei floor; every other call is well under 0.01 USDC |

---

## 0. Preflight (read-only)

| Check | Command | Expected |
|---|---|---|
| Toolchain | `forge --version; node -v; pnpm -v; jq --version` | forge 1.7.x, node >= 22, pnpm 11 |
| Submodules | `git submodule update --init --recursive` | `contracts/lib/forge-std` populated |
| Green build | `pnpm install; and pnpm check` | exit 0 (build, tests, typecheck, lint, forge fmt, ABI drift, gas snapshot) |
| Local rehearsal | `pnpm e2e:dry-run` | ends with `DONE: pool 1 cancelled, …` and the twelve proof transactions listed (§6) |
| RPCs | `cast chain-id --rpc-url arc; cast chain-id --rpc-url arc_testnet` | `5042`, `5042002` |
| CREATE2 deployer | `cast code 0x4e59b44847b379578588920cA78FbF26c0B4956C --rpc-url arc` | non-empty (same on `arc_testnet`) |
| USDC | `cast call 0x3600000000000000000000000000000000000000 "decimals()(uint8)" --rpc-url arc` | `6` |

Run the fish blocks below from the repository root unless a block starts with `cd contracts`.

Done when: every row matches.

## 1. Wallets and keystores

The demo collective has four members; only three of them ever sign. The fourth joins mid-stream and is paid by someone else's transaction — that is the point of `withdrawFor` (PRD D5).

| Role | Keystore name | Mainnet | Testnet |
|---|---|---|---|
| main = deployer and pool owner | `arcdrip-deployer` | deploys, creates the pool, deposits, re-weights, sweeps, cancels | the same, plus `withdrawFor` on wallet B |
| WALLET_B = member 2 | `arcdrip-wallet-b` | sets a payout address; is paid by others | is paid by `withdrawFor` and by the batch |
| WALLET_C = member 3 | `arcdrip-wallet-c` | withdraws its own balance; sends the batch | the same |
| OPS = member 4 | none (an address only) | joins mid-stream, paid by `withdrawForBatch` | same; without `OPS_ADDRESS` the script derives a burner from the run tag |

1. **Import the three keys into encrypted keystores.** Copy one value at a time into cast's hidden prompt. Never `cat`, `echo` or `grep` a file that holds a key, and never put a key on a command line.
   ```fish
   mkdir -p ~/.foundry/keystores
   cast wallet import arcdrip-deployer --interactive   # asks for the key, then a new keystore password
   cast wallet import arcdrip-wallet-b --interactive
   cast wallet import arcdrip-wallet-c --interactive
   cast wallet list                                    # the three names are listed
   ```
2. **Read the public addresses** (each command asks for that keystore's password):
   ```fish
   set DEPLOYER (cast wallet address --account arcdrip-deployer)
   set WALLET_B (cast wallet address --account arcdrip-wallet-b)
   set WALLET_C (cast wallet address --account arcdrip-wallet-c)
   echo $DEPLOYER $WALLET_B $WALLET_C
   ```
   Copy them into your local `.env` as `DEPLOYER_ADDRESS`, `WALLET_B_ADDRESS` and `WALLET_C_ADDRESS`, and put a fourth address you control in `OPS_ADDRESS`. Addresses are public; keys never go there.
3. **Optional password file**, only for an unattended `pnpm e2e:testnet --wait`. Otherwise cast prompts on the terminal whenever a keystore is first needed.
   ```fish
   read -s -P 'keystore password: ' pw; and printf '%s' $pw > ~/.foundry/arcdrip.pw; and chmod 600 ~/.foundry/arcdrip.pw; set -e pw
   rm ~/.foundry/arcdrip.pw   # delete it when the run is done
   ```
   One file serves every keystore when they share a password; otherwise use `WALLET1_PASSWORD_FILE`, `WALLET2_PASSWORD_FILE` and `WALLET3_PASSWORD_FILE`.

Done when: `cast wallet list` shows the three names and the four addresses are in `.env`.

## 2. Environment variables

Nothing here is secret: keystore **names**, addresses, RPCs and timings. Pass values per command with `env VAR=value cmd`, or keep them in a local `.env` (gitignored).

| Variable | Read by | Default | Meaning |
|---|---|---|---|
| `USDC_ADDRESS` | `Deploy.s.sol` | `0x3600…0000` | Any other value is accepted on a local chain only; on Arc the script reverts |
| `SALT_LABEL` | `Deploy.s.sol`, `record-deployment.mjs` | `arcdrip.v1` | Salt = keccak256(label). Change it only for a new deployment (Rollback) |
| `WALLET1_ACCOUNT` / `WALLET2_ACCOUNT` / `WALLET3_ACCOUNT` | `pnpm e2e:testnet` | `arcdrip-deployer` / `arcdrip-wallet-b` / `arcdrip-wallet-c` | Keystore names of the three signers |
| `KEYSTORE_PASSWORD_FILE` | `pnpm e2e:testnet` | unset: cast prompts | Password file for every keystore |
| `WALLET1_PASSWORD_FILE` … `WALLET3_PASSWORD_FILE` | `pnpm e2e:testnet` | `KEYSTORE_PASSWORD_FILE` | Per-keystore password file |
| `KEYSTORE_DIR` | `pnpm e2e:testnet` | `~/.foundry/keystores` | Keystore directory |
| `ARC_TESTNET_RPC` | `pnpm e2e:testnet` | `https://rpc.testnet.arc.io` | The run refuses any RPC that is not chain 5042002 |
| `DRIP_POOL_ADDRESS`, `DRIP_POOL_DEPLOY_BLOCK` | `pnpm e2e:testnet` | from `deployments/arc-testnet.json` | Override the recorded testnet deployment |
| `OPS_ADDRESS` | `pnpm e2e:testnet` | a burner derived from the run tag | The fourth member, which never signs |
| `E2E_DEPOSIT` | e2e | `200000` (0.2 USDC) | USDC units of each of the two deposits |
| `E2E_RUNWAY_SECONDS` | e2e | `180` | How long the first deposit is meant to last; the rate is derived from it, so the freeze lands on schedule |
| `E2E_STREAM_SECONDS` | e2e | `45` | How long the run streams before withdrawing |
| `E2E_MAX_WAIT_SECONDS` | `pnpm e2e:testnet` | `600` | A longer wait pauses the run instead of sleeping; re-run to resume |
| `LOG_LEVEL` | SDK logger | `warn` | JSON log lines on stderr, one `correlationId` per run |

## 3. Testnet (5042002): deploy, record, e2e (PRD 8.4) [SENDS]

### 3.1 Fund the wallets

Testnet USDC is free at `https://faucet.circle.com`. Gas is paid in USDC, so every signing wallet needs a little; 1 USDC each is plenty.

```fish
for a in $DEPLOYER $WALLET_B $WALLET_C
  cast call 0x3600000000000000000000000000000000000000 "balanceOf(address)(uint256)" $a --rpc-url arc_testnet
end   # 6-decimal units: 1000000 = 1 USDC
```

### 3.2 Deploy and record

```fish
cd contracts
forge script script/Deploy.s.sol --rpc-url arc_testnet --account arcdrip-deployer --sender $DEPLOYER            # simulation
forge script script/Deploy.s.sol --rpc-url arc_testnet --account arcdrip-deployer --sender $DEPLOYER --broadcast
node script/record-deployment.mjs 5042002
cd ..
```

`record-deployment.mjs` writes the address, deploy block, deploy tx, deployer, constructor argument, salt label and salt hash, and checks that the salt in the transaction really is keccak256 of the label. The script is idempotent: if the predicted CREATE2 address already has code it deploys nothing.

### 3.3 Run the end-to-end flow

```fish
pnpm e2e:testnet          # pauses at a wait longer than E2E_MAX_WAIT_SECONDS; run it again to resume
pnpm e2e:testnet --wait   # or keep the terminal open and sleep through every wait
pnpm e2e:testnet --reset  # archive the run state and start over with a new pool
```

The run is idempotent: every step is keyed in `scripts/.state/5042002.json`, a re-run skips what already landed, and the confirmed hashes are merged into `deployments/arc-testnet.json` → `proofTxs` after every transaction. It covers PRD 8.4 end to end: create a pool, shares 1/1/2, deposit, stream, `withdraw` by a member, `withdrawFor` by someone else, a fourth member joining mid-stream, the freeze (checked from chain state, not from the clock), a second deposit that resumes without back-paying the frozen seconds, `withdrawForBatch` for all four, `withdrawUnstreamed` and `cancel`.

Done when: the run prints `DONE: pool <id> cancelled, …` and `deployments/arc-testnet.json` lists twelve `proofTxs`.

## 4. Mainnet (5042): deploy, record, verify (PRD 10.2 steps 1-2) [SENDS]

### 4.1 Fund the wallets (about 8 USDC in total)

| Wallet | Pays for | Suggested |
|---|---|---|
| main (`arcdrip-deployer`) | deploy (≈ 0.046 USDC), the proof pools' deposits, owner actions | 6 USDC |
| WALLET_B | its own payout-address change | 0.05 USDC |
| WALLET_C | its own withdraw, the batch transaction | 0.05 USDC |
| OPS | one `withdrawFor` (optional: the batch can come from any wallet) | 0.05 USDC |
| buffer | retries, gas above the 20 gwei floor | 1.5 USDC |

Bridge USDC to Arc with Circle CCTP (App Kit Bridge: `https://docs.arc.io/app-kit/bridge.md`), then split it with `cast send` or a wallet.

### 4.2 Simulate, then deploy with the CREATE2 salt

```fish
cd contracts
forge script script/Deploy.s.sol --rpc-url arc --account arcdrip-deployer --sender $DEPLOYER
# check the printed "DripPool (CREATE2)" address: it equals the testnet one (same salt, same init code)
forge script script/Deploy.s.sol --rpc-url arc --account arcdrip-deployer --sender $DEPLOYER --broadcast
```

Done when: the output ends with `deployed 0x…` and `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`, and the transaction is successful on `https://explorer.arc.io/tx/<hash>`.

### 4.3 Record

```fish
node script/record-deployment.mjs 5042
set DRIP_POOL (jq -r .contracts.DripPool.address ../deployments/arc-mainnet.json)
set DEPLOY_BLOCK (jq -r .contracts.DripPool.deployBlock ../deployments/arc-mainnet.json)
cast call $DRIP_POOL "usdc()(address)" --rpc-url arc         # 0x3600…0000
cast call $DRIP_POOL "nextPoolId()(uint256)" --rpc-url arc   # 1
cast call 0x3600000000000000000000000000000000000000 "balanceOf(address)(uint256)" $DRIP_POOL --rpc-url arc   # 0
```

Commit `deployments/arc-mainnet.json` and `contracts/broadcast/Deploy.s.sol/5042/run-latest.json`. Neither contains a secret (`contracts/cache/` is gitignored). Point the web app at the deployment with `NEXT_PUBLIC_DRIP_ADDRESS=$DRIP_POOL` and `NEXT_PUBLIC_DRIP_DEPLOY_BLOCK=$DEPLOY_BLOCK` (the exact names `apps/web/src/lib/config.ts` reads; `apps/web/README.md` has the full table); the SDK reads `SharesSet` logs from the deploy block on.

### 4.4 Verify on Sourcify (exact match)

See §5 for why this is the path and why no constructor arguments are needed.

```fish
cd contracts
forge verify-contract $DRIP_POOL src/DripPool.sol:DripPool --chain-id 5042 --verifier sourcify --watch
curl -s "https://sourcify.dev/server/v2/contract/5042/$DRIP_POOL?fields=runtimeMatch,creationMatch"
# expect "runtimeMatch":"exact_match"; then set contracts.DripPool.verified to true in deployments/arc-mainnet.json
cd ..
```

The proofs themselves (PRD 10.2 steps 3-11: the two proof pools, the freeze, the batch, the three-day run) are listed in `CHECKLIST.md`.

Done when: `deployments/arc-mainnet.json` has the address, block, deploy tx and `verified: true`.

## 5. Sourcify verification with a CREATE2 salt

**The constructor argument does not have to be encoded by hand for Sourcify.** This is the procedure that produced ArcPull's exact match on Arc mainnet on 2026-09-17, and it applies unchanged here:

1. Foundry 1.7.1 `forge verify-contract --help` documents `--constructor-args` as "The ABI-encoded constructor arguments. Only for Etherscan". The Sourcify verifier does not send them. The only related Sourcify option is `--creation-transaction-hash`, which the help marks as optional.
2. ArcPull is deployed through the same CREATE2 deployer with a single constructor argument stored as an immutable — exactly `DripPool`'s shape. A read-only query of `/server/v2/contract/5042/0xEf025D3Bbf4eb7df27cB3cD62b63d65139EE2923` returns `"runtimeMatch":"exact_match"` with `"creationMatch":null` and the immutable's value recovered from the deployed code. Sourcify matched the runtime bytecode and filled the immutable itself.
3. `DripPool`'s only constructor argument, `usdc`, is an immutable, so it is recovered the same way. Nothing else is written at construction except `nextPoolId = 1`.
4. Sourcify's `/server/chains` lists Arc (`5042`) and Arc Testnet (`5042002`) as supported.

**Procedure** (run from `contracts/`; solc 0.8.30, optimizer 10,000 runs and evm `prague` come from `foundry.toml`):

```fish
# 1. The proven path:
forge verify-contract $DRIP_POOL src/DripPool.sol:DripPool --chain-id 5042 --verifier sourcify --watch
# 2. Confirm:
curl -s "https://sourcify.dev/server/v2/contract/5042/$DRIP_POOL?fields=runtimeMatch,creationMatch"
```

Use `--chain-id 5042002` for the testnet deployment; Sourcify supports it too.

**UNKNOWN: whether Sourcify also records a creation match for a factory deployment** when given the deploy transaction. It would have to trace the call into the CREATE2 deployer. A creation match is optional; the runtime exact match is what the PRD asks for. Try it only after step 1 succeeded, and ignore a failure:

```fish
forge verify-contract $DRIP_POOL src/DripPool.sol:DripPool --chain-id 5042 \
  --creation-transaction-hash (jq -r .contracts.DripPool.deployTx ../deployments/arc-mainnet.json) --verifier sourcify --watch
```

**Explorer fallback (Blockscout).** Use it only if a "Contract" tab on `explorer.arc.io` is wanted. The API sits behind Cloudflare for non-browser clients (an API verification can come back as an HTML challenge or a 403), so use the UI with Standard JSON input. Blockscout does need the ABI-encoded constructor argument:

```fish
forge verify-contract $DRIP_POOL src/DripPool.sol:DripPool --chain-id 5042 --show-standard-json-input > drippool.standard.json
cast abi-encode "constructor(address)" 0x3600000000000000000000000000000000000000
# 0x0000000000000000000000003600000000000000000000000000000000000000
# explorer.arc.io/address/<DRIP_POOL> -> Contract -> Verify & publish -> Solidity (Standard JSON input),
# compiler v0.8.30, contract DripPool; paste the encoded argument (drop the 0x if the form asks for raw hex).
# Delete drippool.standard.json afterwards; it can be regenerated any time.
```

## 6. Local dry run (no keys, no network)

```fish
pnpm e2e:dry-run                 # starts its own anvil on a free port, runs everything, stops it
pnpm e2e:dry-run --port 8600     # pin the port
tsx scripts/e2e-testnet.ts --rpc http://127.0.0.1:8545   # use an anvil that is already running
```

What it does, all locally:

1. starts `anvil --hardfork prague` (EIP-7623 calldata pricing, as on Arc) and etches `MockUSDC` at `0x3600…0000`, so the local run uses Arc's real USDC address and the same blocklist behaviour;
2. mints USDC to anvil's dev account #0 and deploys `DripPool` with the production `script/Deploy.s.sol` through the canonical CREATE2 deployer, then records it with `record-deployment.mjs 31337 --out deployments/anvil-dry-run.json` (gitignored);
3. runs the PRD 8.4 sequence with anvil's unlocked accounts (no key material anywhere) and jumps chain time instead of waiting;
4. checks the freeze and the no-back-pay rule against chain state, and refuses to finish if `owed` ever exceeds the balance;
5. prints every transaction hash with its gas and its USDC fee.

`--rpc` only accepts a loopback URL and every local helper re-checks `eth_chainId == 31337`, so a dry run cannot touch a real network. The dry run is also a test: `pnpm --filter @sharedarc/scripts test` runs it against a temporary directory and asserts the twelve proof transactions, the freeze, the batch and the idempotent re-run.

## Rollback and failure modes

| Problem | Action |
|---|---|
| Deploy transaction fails | Nothing to roll back. Fix and re-run; CREATE2 gives the same address |
| Bug found after deploy | The contract is immutable and has no owner. Stop promoting it, deploy the fix with `SALT_LABEL=arcdrip.v2`, record it and point the site at the new address. Existing pools keep working; their owners can `cancel` to take back the unstreamed funds, and members keep withdrawing what they earned |
| `record-deployment.mjs` says the salt is not keccak256 of the label | You deployed with a different `SALT_LABEL`; pass `--salt-label <label>` |
| Sourcify verification fails | Re-run §5 step 1 without `--creation-transaction-hash`; use the Blockscout Standard JSON fallback if an explorer tab is wanted |
| Blockscout verification returns HTML ("Just a moment…") or 403 | The API is behind a Cloudflare challenge for non-browser clients. Do not retry in a loop: use the browser UI |
| `pnpm e2e:testnet` pauses | Expected: the wait was longer than `E2E_MAX_WAIT_SECONDS`. Re-run the same command later, or use `--wait` |
| A run state file no longer matches the deployment | `pnpm e2e:testnet --reset` archives it and starts a new pool |
| A wallet leaks | Revoke its USDC allowance for `DripPool` (`approve(DripPool, 0)`), move the funds, transfer pool ownership (two-step) to a new wallet and create a new keystore |

## Hosting (GitHub Pages)

`.github/workflows/pages.yml` publishes `site/` at https://r4topunk.github.io/sharedarc/ and, **only once
`deployments/arc-mainnet.json` has a `DripPool.address`**, the `apps/web` static export at `/sharedarc/app/`, built
against that address and `deployBlock`. The same JSON is published as `deployment.json`; the landing reads it to
flip its status card to "Live on Arc mainnet", link the explorer address, deploy tx and Sourcify, and show the
"Open the app" buttons. So the commit that records the deployment (`node script/record-deployment.mjs 5042`) is
the one that takes the app live; before it, only the landing is served and nothing points at a null address.
