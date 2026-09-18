// Local anvil for the dry run: start and stop the process, etch MockUSDC at Arc's USDC address, and deploy
// DripPool through the real contracts/script/Deploy.s.sol (CREATE2 via 0x4e59...) plus record-deployment.mjs.
// Anvil's unlocked dev accounts sign through eth_sendTransaction, so no key material is involved anywhere here.
// Local chain only: every entry point refuses a chain id other than 31337.
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { type Address, getAddress, type Hex } from 'viem';
import { ARC_USDC, CONTRACTS_DIR, LOCAL_CHAIN_ID, readDeployment } from './config.js';

export interface Anvil {
  url: string;
  port: number;
  stop: () => Promise<void>;
}

/** A free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

/** True when something already listens on 127.0.0.1:`port`. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolveUse) => {
    const srv = createServer();
    srv.once('error', () => resolveUse(true));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolveUse(false)));
  });
}

export async function rpc(url: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/**
 * Starts `anvil --hardfork prague` (EIP-7623 calldata pricing, as on Arc). `--prune-history` keeps anvil from
 * writing per-block state to ~/.foundry/anvil/tmp.
 */
export async function startAnvil(options: { port: number; accounts?: number }): Promise<Anvil> {
  const { port } = options;
  if (await portInUse(port)) throw new Error(`port ${port} is in use (another anvil?); pass --port <n>`);
  const args = ['--port', String(port), '--hardfork', 'prague'];
  args.push('--prune-history', '--silent', '--accounts', String(options.accounts ?? 10));
  const proc: ChildProcess = spawn('anvil', args, { stdio: 'ignore' });
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  proc.once('error', () => undefined);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (proc.exitCode !== null)
      throw new Error(`anvil exited with code ${proc.exitCode}; is Foundry installed?`);
    try {
      await requireLocalChain(url);
      break;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('refusing')) throw err;
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('anvil did not start within 20 s');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    port,
    stop: async () => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
      await exited;
    },
  };
}

/** Throws unless `url` answers as chain 31337. The guard that keeps local-only helpers off a real network. */
export async function requireLocalChain(url: string): Promise<void> {
  const chainId = Number(await rpc(url, 'eth_chainId'));
  if (chainId !== LOCAL_CHAIN_ID) throw new Error(`refusing: ${url} is chain ${chainId}, not a local anvil`);
}

/** ABI-less view of a Foundry artifact in contracts/out. */
export function artifact(file: string, name: string): { bytecode: Hex; deployedBytecode: Hex } {
  const path = resolve(CONTRACTS_DIR, 'out', file, `${name}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}: run \`pnpm contracts:build\` first`);
  const json = JSON.parse(readFileSync(path, 'utf8')) as {
    bytecode: { object: Hex };
    deployedBytecode: { object: Hex };
  };
  return { bytecode: json.bytecode.object, deployedBytecode: json.deployedBytecode.object };
}

/** Unlocked dev accounts of a local anvil. */
export async function devAccounts(url: string): Promise<Address[]> {
  await requireLocalChain(url);
  const accounts = (await rpc(url, 'eth_accounts')) as string[];
  return accounts.map((a) => getAddress(a));
}

/**
 * Puts MockUSDC's runtime code at 0x3600...0000 (Arc's USDC address), so the local run exercises the same
 * addresses and the same blocklist behaviour as Arc. Idempotent.
 */
export async function etchMockUsdc(url: string): Promise<Address> {
  await requireLocalChain(url);
  const { deployedBytecode } = artifact('MockUSDC.sol', 'MockUSDC');
  const current = (await rpc(url, 'eth_getCode', [ARC_USDC, 'latest'])) as string;
  if (current.toLowerCase() !== deployedBytecode.toLowerCase()) {
    await rpc(url, 'anvil_setCode', [ARC_USDC, deployedBytecode]);
  }
  return ARC_USDC;
}

/** Runs a command and collects its output. */
export function exec(
  cmd: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env ?? process.env });
    let output = '';
    child.stdout.on('data', (d: Buffer) => {
      output += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      output += d.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolveRun({ code, output }));
  });
}

/**
 * Deploys DripPool with the production path: `forge script script/Deploy.s.sol --broadcast` from an unlocked dev
 * account (salt "arcdrip.v1", USDC 0x3600...0000), then `record-deployment.mjs 31337 --out <file>`. Returns what
 * the record says, which is also what the rest of the run reads.
 */
export async function deployWithForgeScript(params: {
  url: string;
  sender: Address;
  deploymentsFile: string;
}): Promise<{ pool: Address; deployBlock: bigint; predicted: Address }> {
  await requireLocalChain(params.url);
  const env = { ...process.env, SALT_LABEL: 'arcdrip.v1', USDC_ADDRESS: ARC_USDC };
  const script = await exec(
    'forge',
    [
      'script',
      'script/Deploy.s.sol',
      '--rpc-url',
      params.url,
      '--unlocked',
      '--sender',
      params.sender,
      '--broadcast',
    ],
    { cwd: CONTRACTS_DIR, env },
  );
  if (script.code !== 0)
    throw new Error(`forge script failed (exit ${script.code}):\n${script.output.slice(-3_000)}`);
  const predicted = /DripPool \(CREATE2\) (0x[0-9a-fA-F]{40})/.exec(script.output)?.[1];
  if (!predicted)
    throw new Error(`forge script did not print the predicted address:\n${script.output.slice(-2_000)}`);

  rmSync(params.deploymentsFile, { force: true });
  const record = await exec(
    'node',
    ['script/record-deployment.mjs', String(LOCAL_CHAIN_ID), '--out', params.deploymentsFile],
    { cwd: CONTRACTS_DIR, env },
  );
  if (record.code !== 0) throw new Error(`record-deployment.mjs failed:\n${record.output}`);
  const recorded = readDeployment(params.deploymentsFile);
  if (!recorded) throw new Error(`${params.deploymentsFile} has no DripPool address after recording`);
  return { pool: recorded.pool, deployBlock: recorded.deployBlock, predicted: getAddress(predicted) };
}
