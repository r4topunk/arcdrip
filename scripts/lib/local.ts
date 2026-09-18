// The same PRD 8.4 flow against a local anvil: the dry run. Nothing here touches a real network or a real key.
// Anvil's unlocked dev accounts sign through eth_sendTransaction, MockUSDC is etched at Arc's USDC address and
// minted for wallet 1, DripPool is deployed by the production forge script, and chain time is jumped instead of
// waited out. Proof hashes go to deployments/anvil-dry-run.json (gitignored), never to a real record.
import { existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger, getPoolOrNull, newCorrelationId } from '@sharedarc/sdk';
import { type Address, createPublicClient, createTestClient, createWalletClient, http } from 'viem';
import {
  type Anvil,
  deployWithForgeScript,
  devAccounts,
  etchMockUsdc,
  freePort,
  requireLocalChain,
  startAnvil,
} from './anvil.js';
import { AnvilClock } from './clock.js';
import {
  chainFor,
  DEPLOYMENT_FILES,
  e2eEnvSchema,
  httpWithGasMargin,
  LOCAL_CHAIN_ID,
  logLevel,
  parseEnv,
  STATE_DIR,
} from './config.js';
import { writeRunRecord } from './deployments.js';
import { type FlowResult, runFlow, usdcBalance, type Wallet, type WalletIndex } from './flow.js';
import { formatUsdc } from './format.js';
import { newState, type RunState, StateStore } from './state.js';

/** Just the MockUSDC entry point the dry run needs; the mock is a test double, not part of the SDK surface. */
const mintAbi = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

export interface LocalOptions {
  /** Target an anvil that is already running (must be chain 31337). Without it the run starts its own. */
  rpc?: string | undefined;
  /** Port for the anvil this run starts. Default: a free one. */
  port?: number | undefined;
  /** Archive the state file and start a new pool. Implied when this run starts its own anvil. */
  reset?: boolean | undefined;
  say?: ((line: string) => void) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Where proofTxs go. Default deployments/anvil-dry-run.json. */
  deploymentsFile?: string | undefined;
  stateDir?: string | undefined;
}

export interface LocalResult {
  flow: FlowResult;
  url: string;
  pool: Address;
  deployBlock: bigint;
  members: Address[];
  state: Readonly<RunState>;
  stateFile: string;
  deploymentsFile: string;
  /** The anvil this run started, when it started one (the caller stops it). */
  anvil: Anvil | null;
}

/** Runs the flow against a local anvil, starting one unless `--rpc` points at an existing chain 31337. */
export async function runLocal(options: LocalOptions = {}): Promise<LocalResult> {
  const say = options.say ?? ((line: string) => console.log(line));
  const env = parseEnv(e2eEnvSchema, options.env ?? process.env);
  const deploymentsFile = options.deploymentsFile ?? DEPLOYMENT_FILES.dryRun;
  if (deploymentsFile === DEPLOYMENT_FILES.mainnet || deploymentsFile === DEPLOYMENT_FILES.testnet) {
    throw new Error('the local run never writes a real deployment record');
  }

  let anvil: Anvil | null = null;
  let url: string;
  let fresh = false;
  if (options.rpc) {
    url = options.rpc;
    await requireLocalChain(url);
    say(`using the anvil already running at ${url} (chain ${LOCAL_CHAIN_ID})`);
  } else {
    anvil = await startAnvil({ port: options.port ?? (await freePort()) });
    url = anvil.url;
    fresh = true;
    say(`started anvil at ${url} (chain ${LOCAL_CHAIN_ID})`);
  }

  try {
    const chain = chainFor(LOCAL_CHAIN_ID, url);
    const client = createPublicClient({ chain, transport: http(url) });
    const test = createTestClient({ chain, mode: 'anvil', transport: http(url) });

    const accounts = await devAccounts(url);
    if (accounts.length < 4) throw new Error(`anvil at ${url} exposes ${accounts.length} accounts, need 4`);
    const [a1, a2, a3, member4] = accounts as [Address, Address, Address, Address];

    const usdc = await etchMockUsdc(url);
    say(`MockUSDC etched at ${usdc} (Arc's USDC address, 6 decimals, with the FiatToken blocklist)`);
    const funding = env.E2E_DEPOSIT * 4n;
    const wallet1 = createWalletClient({ account: a1, chain, transport: httpWithGasMargin(url) }) as Wallet;
    if ((await usdcBalance({ client, usdc }, a1)) < funding) {
      const mintHash = await wallet1.writeContract({
        address: usdc,
        abi: mintAbi,
        functionName: 'mint',
        args: [a1, funding],
        account: a1,
        chain,
      });
      await client.waitForTransactionReceipt({ hash: mintHash });
      say(`minted ${formatUsdc(funding)} to wallet 1 (${a1}): ${mintHash}`);
    }

    const deployed = await deployWithForgeScript({ url, sender: a1, deploymentsFile });
    say(
      `DripPool ${deployed.pool} (CREATE2 salt keccak256("arcdrip.v1")), deploy block ${deployed.deployBlock}`,
    );

    const stateFile = resolve(options.stateDir ?? STATE_DIR, `${LOCAL_CHAIN_ID}.json`);
    if ((fresh || options.reset) && existsSync(stateFile)) {
      const archived = stateFile.replace(/\.json$/, `.${Date.now()}.json`);
      renameSync(stateFile, archived);
      say(`archived the previous local run state to ${archived}`);
    }
    const store = StateStore.open(stateFile, () =>
      newState(LOCAL_CHAIN_ID, deployed.pool, newCorrelationId()),
    );
    if (store.get().pool !== deployed.pool) {
      throw new Error(
        `${stateFile} belongs to DripPool ${store.get().pool}, not ${deployed.pool}; pass --reset`,
      );
    }

    const logger = createLogger({
      level: logLevel(options.env ?? process.env),
      destination: process.stderr,
      bindings: { runTag: store.get().runTag },
    });

    const wallets: Record<WalletIndex, Wallet> = {
      1: wallet1,
      2: createWalletClient({ account: a2, chain, transport: httpWithGasMargin(url) }) as Wallet,
      3: createWalletClient({ account: a3, chain, transport: httpWithGasMargin(url) }) as Wallet,
    };
    say(
      `members: 1 ${a1}, 2 ${a2}, 3 ${a3}, 4 ${member4} ` +
        "(anvil's public dev accounts; local only, never fund them)",
    );

    const flow = await runFlow({
      chainId: LOCAL_CHAIN_ID,
      client,
      explorer: '',
      pool: deployed.pool,
      usdc,
      signer: async (index) => wallets[index],
      member4,
      clock: new AnvilClock(client, test),
      store,
      logger,
      say,
      deposit: env.E2E_DEPOSIT,
      runwaySeconds: env.E2E_RUNWAY_SECONDS,
      streamSeconds: env.E2E_STREAM_SECONDS,
      onTx: (state) => writeRunRecord(deploymentsFile, state),
    });
    writeRunRecord(deploymentsFile, store.get());

    // A last read that proves the pool survives the run: it exists, it is cancelled, it still owes its members.
    const finalPool = store.get().poolId
      ? await getPoolOrNull(
          { publicClient: client, address: deployed.pool, logger },
          BigInt(store.get().poolId as string),
        )
      : null;
    if (finalPool && !finalPool.cancelled) say('note: the pool is not cancelled; the flow stopped early');

    return {
      flow,
      url,
      pool: deployed.pool,
      deployBlock: deployed.deployBlock,
      members: [a1, a2, a3, member4],
      state: store.get(),
      stateFile,
      deploymentsFile,
      anvil,
    };
  } catch (err) {
    await anvil?.stop();
    throw err;
  }
}
