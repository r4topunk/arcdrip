#!/usr/bin/env node
// Records the DripPool deployment from Foundry's broadcast log into deployments/<network>.json.
// Reads only local files (no RPC, no keys). Existing fields (proofTxs, verified, e2e) are kept.
//
//   node script/record-deployment.mjs 5042                          # -> ../deployments/arc-mainnet.json
//   node script/record-deployment.mjs 5042002                       # -> ../deployments/arc-testnet.json
//   node script/record-deployment.mjs 31337                         # -> ../deployments/anvil-local.json (gitignored)
//   node script/record-deployment.mjs 31337 --out ../deployments/anvil-dry-run.json
//   node script/record-deployment.mjs 5042 --salt-label arcdrip.v2  # only after a redeploy with SALT_LABEL=arcdrip.v2
//
// The salt is read from the deploy transaction (the first 32 bytes of the input sent to the CREATE2 deployer) and
// checked against keccak256(label) with `cast keccak`, where the label is --salt-label, else $SALT_LABEL, else
// "arcdrip.v1" (the default of Deploy.s.sol).
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(here, '..');
const repoDir = resolve(contractsDir, '..');

const USDC = '0x3600000000000000000000000000000000000000';
const CREATE2_DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c';
const NETWORKS = {
  5042: { name: 'arc-mainnet', rpcUrl: 'https://rpc.mainnet.arc.io', explorer: 'https://explorer.arc.io' },
  5042002: { name: 'arc-testnet', rpcUrl: 'https://rpc.testnet.arc.io', explorer: 'https://explorer.arc.io' },
  31337: { name: 'anvil-local', rpcUrl: 'http://127.0.0.1:8545', explorer: '' },
};

const args = process.argv.slice(2);
const chainId = Number(args[0]);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const network = NETWORKS[chainId];
if (!network) {
  console.error('usage: record-deployment.mjs <5042|5042002|31337> [--out file] [--salt-label label]');
  process.exit(1);
}
const saltLabel = option('--salt-label') ?? process.env.SALT_LABEL ?? 'arcdrip.v1';

const broadcastFile = resolve(contractsDir, 'broadcast/Deploy.s.sol', String(chainId), 'run-latest.json');
if (!existsSync(broadcastFile)) {
  console.error(`no broadcast log at ${broadcastFile}; run forge script ... --broadcast first`);
  process.exit(1);
}
const run = JSON.parse(readFileSync(broadcastFile, 'utf8'));

const tx = run.transactions.find((t) => t.contractName === 'DripPool' && t.transactionType?.startsWith('CREATE'));
if (!tx) {
  console.error('no DripPool creation in the broadcast log (was it already deployed?)');
  process.exit(1);
}
const receipt = run.receipts.find((r) => r.transactionHash === tx.hash);
if (!receipt || receipt.status !== '0x1') {
  console.error(`missing or failed receipt for ${tx.hash}`);
  process.exit(1);
}

// CREATE2 through the canonical deployer: input = salt (32 bytes) ++ init code.
let saltHash = null;
if (tx.transactionType === 'CREATE2') {
  if ((tx.transaction?.to ?? '').toLowerCase() !== CREATE2_DEPLOYER) {
    console.error(`CREATE2 tx ${tx.hash} was not sent to the canonical deployer ${CREATE2_DEPLOYER}`);
    process.exit(1);
  }
  saltHash = (tx.transaction.input ?? '').slice(0, 66).toLowerCase();
  const expected = execFileSync('cast', ['keccak', saltLabel]).toString().trim().toLowerCase();
  if (saltHash !== expected) {
    console.error(`salt ${saltHash} of ${tx.hash} is not keccak256("${saltLabel}"); pass the label with --salt-label`);
    process.exit(1);
  }
}

const outFile = option('--out') ? resolve(option('--out')) : resolve(repoDir, 'deployments', `${network.name}.json`);
const base = existsSync(outFile)
  ? JSON.parse(readFileSync(outFile, 'utf8'))
  : {
      network: network.name,
      chainId,
      rpcUrl: network.rpcUrl,
      explorer: network.explorer,
      token: { symbol: 'USDC', address: USDC, decimals: 6 },
      contracts: {},
      proofTxs: {},
    };

let commit = null;
try {
  commit = execSync('git rev-parse HEAD', { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {}

const [usdcArg] = tx.arguments ?? [];
const previous = base.contracts.DripPool ?? {};
const constructorArgs = usdcArg ? { usdc: usdcArg } : previous.constructorArgs;
if (usdcArg) base.token.address = usdcArg;

base.contracts.DripPool = {
  ...previous,
  address: tx.contractAddress,
  deployBlock: Number(BigInt(receipt.blockNumber)),
  deployTx: tx.hash,
  verified: previous.verified ?? false,
  commit,
  deployer: tx.transaction?.from ?? null,
  salt: `keccak256("${saltLabel}")`,
  saltHash,
  constructorArgs,
};

const tmp = `${outFile}.tmp`;
writeFileSync(tmp, `${JSON.stringify(base, null, 2)}\n`);
renameSync(tmp, outFile);
console.log(`recorded DripPool ${tx.contractAddress} (block ${base.contracts.DripPool.deployBlock}) -> ${outFile}`);
