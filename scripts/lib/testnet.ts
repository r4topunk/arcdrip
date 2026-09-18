// Arc testnet (chain 5042002) e2e run, PRD 8.4. The three signers are Foundry encrypted keystores, named by the
// env variables WALLET1_ACCOUNT / WALLET2_ACCOUNT / WALLET3_ACCOUNT and decrypted with `cast` on first use: this
// file never sees, stores or prints key material. Waits up to E2E_MAX_WAIT_SECONDS inline; anything longer pauses
// the run, and a re-run resumes from scripts/.state/5042002.json.
import { existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLogger, getUsdcAddress, newCorrelationId } from '@sharedarc/sdk';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  toHex,
} from 'viem';
import { RealClock } from './clock.js';
import {
  ARC_TESTNET_ID,
  ARC_USDC,
  chainFor,
  DEPLOYMENT_FILES,
  e2eEnvSchema,
  httpWithGasMargin,
  logLevel,
  NETWORKS,
  parseEnv,
  readDeployment,
  STATE_DIR,
} from './config.js';
import { writeRunRecord } from './deployments.js';
import { type FlowResult, runFlow, usdcBalance, type Wallet, type WalletIndex } from './flow.js';
import { formatUsdc } from './format.js';
import { keystoreAccount, lazy } from './signers.js';
import { newState, type RunState, StateStore } from './state.js';

export interface TestnetOptions {
  /** Sleep through every wait instead of pausing the run. */
  wait?: boolean | undefined;
  /** Archive the state file and start over with a new pool. */
  reset?: boolean | undefined;
  say?: ((line: string) => void) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** Where proofTxs go. Default deployments/arc-testnet.json. */
  deploymentsFile?: string | undefined;
  stateDir?: string | undefined;
}

/** Below this USDC balance a wallet probably cannot pay gas for its own transactions (gas is USDC on Arc). */
const LOW_GAS_BALANCE = 50_000n; // 0.05 USDC

export interface TestnetResult {
  flow: FlowResult;
  pool: Address;
  deployBlock: bigint;
  state: Readonly<RunState>;
  stateFile: string;
  deploymentsFile: string;
}

export async function runTestnet(options: TestnetOptions = {}): Promise<TestnetResult> {
  const say = options.say ?? ((line: string) => console.log(line));
  const env = parseEnv(e2eEnvSchema, options.env ?? process.env);
  const net = NETWORKS.testnet;
  const rpcUrl = env.ARC_TESTNET_RPC;
  const chain = chainFor(ARC_TESTNET_ID, rpcUrl, net.explorer);
  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  const chainId = await client.getChainId();
  if (chainId !== ARC_TESTNET_ID) {
    throw new Error(
      `refusing: ${rpcUrl} is chain ${chainId}; this run is for Arc testnet (${ARC_TESTNET_ID}) only`,
    );
  }
  const deploymentsFile = options.deploymentsFile ?? DEPLOYMENT_FILES.testnet;
  if (deploymentsFile === DEPLOYMENT_FILES.mainnet)
    throw new Error('this run never writes the mainnet record');
  const recorded = readDeployment(deploymentsFile);
  const pool = env.DRIP_POOL_ADDRESS ?? recorded?.pool;
  const deployBlock = env.DRIP_POOL_DEPLOY_BLOCK ?? recorded?.deployBlock;
  if (!pool || deployBlock === undefined) {
    throw new Error(
      'no DripPool on testnet: deploy it and run `node script/record-deployment.mjs 5042002` (DEPLOY.md), ' +
        'or set DRIP_POOL_ADDRESS and DRIP_POOL_DEPLOY_BLOCK',
    );
  }
  if ((await client.getCode({ address: pool })) === undefined)
    throw new Error(`no contract at ${pool} on testnet`);
  const usdc = await getUsdcAddress({ publicClient: client, address: pool });
  if (usdc !== ARC_USDC) throw new Error(`DripPool ${pool} streams ${usdc}, expected Arc USDC ${ARC_USDC}`);

  const stateFile = resolve(options.stateDir ?? STATE_DIR, `${ARC_TESTNET_ID}.json`);
  if (options.reset && existsSync(stateFile)) {
    const archived = stateFile.replace(/\.json$/, `.${Date.now()}.json`);
    renameSync(stateFile, archived);
    say(`archived the previous run state to ${archived}`);
  }
  const store = StateStore.open(stateFile, () => newState(ARC_TESTNET_ID, pool, newCorrelationId()));
  if (store.get().pool !== pool) {
    throw new Error(`${stateFile} belongs to DripPool ${store.get().pool}, not ${pool}; run with --reset`);
  }
  const logger = createLogger({
    level: logLevel(options.env ?? process.env),
    destination: process.stderr,
    bindings: { runTag: store.get().runTag },
  });

  say(
    `SharedArc e2e on Arc testnet (chain ${ARC_TESTNET_ID}), DripPool ${pool} (deploy block ${deployBlock})`,
  );
  say(`run ${store.get().runTag}, state ${stateFile}, proofs ${deploymentsFile}`);
  say(
    'Testnet USDC comes from https://faucet.circle.com; gas is paid in USDC, so every wallet needs a little.',
  );

  const accounts = { 1: env.WALLET1_ACCOUNT, 2: env.WALLET2_ACCOUNT, 3: env.WALLET3_ACCOUNT } as const;
  const passwords = {
    1: env.WALLET1_PASSWORD_FILE ?? env.KEYSTORE_PASSWORD_FILE,
    2: env.WALLET2_PASSWORD_FILE ?? env.KEYSTORE_PASSWORD_FILE,
    3: env.WALLET3_PASSWORD_FILE ?? env.KEYSTORE_PASSWORD_FILE,
  } as const;
  const signer = lazy(async (index: WalletIndex): Promise<Wallet> => {
    say(
      `decrypting keystore "${accounts[index]}" (wallet ${index}) with cast` +
        `${passwords[index] ? '' : '; enter its password'}`,
    );
    const account = await keystoreAccount(accounts[index], {
      passwordFile: passwords[index],
      keystoreDir: env.KEYSTORE_DIR,
    });
    const balance = await usdcBalance({ client, usdc }, account.address);
    say(`wallet ${index}: ${account.address}, ${formatUsdc(balance)}`);
    if (balance < LOW_GAS_BALANCE) say('  low balance: get testnet USDC at https://faucet.circle.com');
    return createWalletClient({ account, chain, transport: httpWithGasMargin(rpcUrl) }) as Wallet;
  });

  // The fourth member only receives (it never signs), which is exactly what `withdrawFor` is for. Without an
  // OPS_ADDRESS it is a deterministic burner derived from the run tag: fine for testnet USDC, never for mainnet.
  const member4 = env.OPS_ADDRESS ?? burnerFromRunTag(store.get().runTag);
  if (!env.OPS_ADDRESS) {
    say(`member 4 is the burner ${member4} derived from the run tag; set OPS_ADDRESS to use a real wallet`);
  }

  const flow = await runFlow({
    chainId: ARC_TESTNET_ID,
    client,
    explorer: net.explorer,
    pool,
    usdc,
    signer,
    member4,
    clock: new RealClock(client, {
      maxWaitSeconds: options.wait ? Number.POSITIVE_INFINITY : env.E2E_MAX_WAIT_SECONDS,
      say,
    }),
    store,
    logger,
    say,
    deposit: env.E2E_DEPOSIT,
    runwaySeconds: env.E2E_RUNWAY_SECONDS,
    streamSeconds: env.E2E_STREAM_SECONDS,
    onTx: (state) => writeRunRecord(deploymentsFile, state),
  });
  writeRunRecord(deploymentsFile, store.get());
  return { flow, pool, deployBlock, state: store.get(), stateFile, deploymentsFile };
}

/** Deterministic, key-less address for the fourth member: the last 20 bytes of keccak256(runTag). */
export function burnerFromRunTag(runTag: string): Address {
  return getAddress(`0x${keccak256(toHex(`sharedarc/member4/${runTag}`)).slice(-40)}`);
}
