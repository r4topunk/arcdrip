// Network constants, env parsing and deployment records shared by the e2e run and its local dry run.
// Nothing here reads key material: keystores are named by env variable and decrypted by `cast` in signers.ts.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  type Chain,
  defineChain,
  getAddress,
  type Hex,
  http,
  isAddress,
  type Transport,
  toHex,
} from 'viem';
import { arc, arcTestnet, foundry } from 'viem/chains';
import { z } from 'zod';

/** Repository root (scripts/lib/ is two levels down). */
export const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const CONTRACTS_DIR = resolve(REPO_DIR, 'contracts');
export const DEPLOYMENTS_DIR = resolve(REPO_DIR, 'deployments');
/** Resumable run state, one file per chain id (gitignored). */
export const STATE_DIR = resolve(REPO_DIR, 'scripts/.state');

/** Arc USDC, ERC-20 view (6 decimals). Gas is paid in the same asset. */
export const ARC_USDC: Address = '0x3600000000000000000000000000000000000000';
export const USDC_DECIMALS = 6;

export const ARC_MAINNET_ID = 5042;
export const ARC_TESTNET_ID = 5042002;
export const LOCAL_CHAIN_ID = 31337;

/** Where each network's deployment record lives. A local run never writes the testnet or mainnet files. */
export const DEPLOYMENT_FILES = {
  mainnet: resolve(DEPLOYMENTS_DIR, 'arc-mainnet.json'),
  testnet: resolve(DEPLOYMENTS_DIR, 'arc-testnet.json'),
  dryRun: resolve(DEPLOYMENTS_DIR, 'anvil-dry-run.json'),
} as const;

export interface NetworkInfo {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorer: string;
}

/** PRD 9 network facts. viem ships `arc` and `arcTestnet`; the PRD's RPC and explorer URLs win over its defaults. */
export const NETWORKS: Record<'mainnet' | 'testnet', NetworkInfo> = {
  mainnet: {
    chainId: ARC_MAINNET_ID,
    name: 'arc-mainnet',
    rpcUrl: 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
  },
  testnet: {
    chainId: ARC_TESTNET_ID,
    name: 'arc-testnet',
    rpcUrl: 'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.arc.io',
  },
};

/** viem chain for `chainId` with the given RPC (and explorer, when there is one). */
export function chainFor(chainId: number, rpcUrl: string, explorer = ''): Chain {
  const base = chainId === ARC_MAINNET_ID ? arc : chainId === ARC_TESTNET_ID ? arcTestnet : foundry;
  if (base.id !== chainId) throw new Error(`unsupported chain id ${chainId}`);
  return defineChain({
    ...base,
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: explorer ? { default: { name: 'Explorer', url: explorer } } : undefined,
  });
}

/**
 * HTTP transport that adds a 20 % margin to every gas figure, as a browser wallet does. An exact estimate can run
 * out of gas onchain when state moves between the estimate and inclusion: `withdrawForBatch` costs more when a
 * member's transfer succeeds than when it is skipped, and `setShares` costs more when it writes a fresh slot.
 * @arcdrip/sdk applies its own buffer to local accounts; this transport also covers anvil's unlocked accounts,
 * which send through `eth_sendTransaction` and let the node fill the gas. Unused gas is not charged.
 */
export function httpWithGasMargin(url: string): Transport {
  const base = http(url);
  const pad = (gas: Hex) => toHex((BigInt(gas) * 120n) / 100n);
  return ((options) => {
    const transport = base(options);
    const send = transport.request as (args: { method: string; params?: unknown }) => Promise<unknown>;
    const request = (async (args: { method: string; params?: unknown }) => {
      if (args.method === 'eth_sendTransaction') {
        const [tx] = args.params as [Record<string, unknown>];
        if (tx.gas === undefined) {
          const gas = (await send({ method: 'eth_estimateGas', params: [tx] })) as Hex;
          return send({ method: args.method, params: [{ ...tx, gas: pad(gas) }] });
        }
      }
      const result = await send(args);
      if (args.method === 'eth_estimateGas') return pad(result as Hex);
      if (args.method === 'eth_fillTransaction') {
        const filled = result as { tx?: { gas?: Hex } };
        if (filled.tx?.gas) return { ...filled, tx: { ...filled.tx, gas: pad(filled.tx.gas) } };
      }
      return result;
    }) as typeof transport.request;
    return { ...transport, request };
  }) as Transport;
}

/** `<explorer>/tx/<hash>`, or '' on a chain without an explorer (anvil). */
export function txUrl(explorer: string, hash: string): string {
  return explorer ? `${explorer.replace(/\/+$/, '')}/tx/${hash}` : '';
}

// ------------------------------------------------------------------------------------------------ env

/** .env.example ships placeholders such as `[ADDRESS]`; a value that is still a placeholder counts as unset. */
const unsetIfPlaceholder = (value: unknown) =>
  typeof value === 'string' && (value.trim() === '' || /^\[.*\]$/.test(value.trim())) ? undefined : value;

const optionalString = z.preprocess(unsetIfPlaceholder, z.string().optional());
const optionalAddress = z.preprocess(
  unsetIfPlaceholder,
  z
    .string()
    .refine((s) => isAddress(s, { strict: false }), { error: 'not an address' })
    .transform((s) => getAddress(s))
    .optional(),
);
const optionalUint = (fallback: number) =>
  z.preprocess(unsetIfPlaceholder, z.coerce.number().int().nonnegative().optional().default(fallback));

/**
 * Env of the e2e run. Every variable is optional and defaults to what .env.example documents. The three
 * WALLETn_ACCOUNT variables hold Foundry **keystore names**, never key material.
 */
export const e2eEnvSchema = z.object({
  ARC_TESTNET_RPC: z.preprocess(unsetIfPlaceholder, z.url().default(NETWORKS.testnet.rpcUrl)),
  DRIP_POOL_ADDRESS: optionalAddress,
  DRIP_POOL_DEPLOY_BLOCK: z.preprocess(unsetIfPlaceholder, z.coerce.bigint().nonnegative().optional()),
  WALLET1_ACCOUNT: z.preprocess(unsetIfPlaceholder, z.string().default('arcdrip-deployer')),
  WALLET2_ACCOUNT: z.preprocess(unsetIfPlaceholder, z.string().default('arcdrip-wallet-b')),
  WALLET3_ACCOUNT: z.preprocess(unsetIfPlaceholder, z.string().default('arcdrip-wallet-c')),
  KEYSTORE_DIR: optionalString,
  KEYSTORE_PASSWORD_FILE: optionalString,
  WALLET1_PASSWORD_FILE: optionalString,
  WALLET2_PASSWORD_FILE: optionalString,
  WALLET3_PASSWORD_FILE: optionalString,
  /** Fourth member, added mid-stream. It never signs: it only receives through `withdrawForBatch`. */
  OPS_ADDRESS: optionalAddress,
  /** USDC units deposited by the first deposit (default 0.2 USDC). The second deposit is the same amount. */
  E2E_DEPOSIT: z.preprocess(unsetIfPlaceholder, z.coerce.bigint().positive().default(200_000n)),
  /** Seconds the first deposit is meant to last; the rate is derived from it, so the freeze is on schedule. */
  E2E_RUNWAY_SECONDS: optionalUint(180).pipe(z.number().min(30).max(86_400)),
  /** How long to stream before the first withdrawals. */
  E2E_STREAM_SECONDS: optionalUint(45).pipe(z.number().min(5).max(3_600)),
  /** Longest wait this run performs inline; anything longer pauses the run (re-run it to resume). */
  E2E_MAX_WAIT_SECONDS: optionalUint(600),
});
export type E2eEnv = z.output<typeof e2eEnvSchema>;

/** Parses `env` or throws one error that lists every bad variable. */
export function parseEnv<S extends z.ZodType>(schema: S, env: NodeJS.ProcessEnv = process.env): z.output<S> {
  const result = schema.safeParse(env);
  if (result.success) return result.data;
  const lines = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
  throw new Error(`invalid environment:\n${lines.join('\n')}`);
}

/** LOG_LEVEL for the SDK's pino logger (stderr). CLIs default to 'warn' so the human-readable output stays clean. */
export function logLevel(env: NodeJS.ProcessEnv = process.env) {
  const levels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
  const value = env.LOG_LEVEL as (typeof levels)[number] | undefined;
  return value && levels.includes(value) ? value : 'warn';
}

// ------------------------------------------------------------------------------------------------ deployments

const deploymentSchema = z.object({
  chainId: z.number().int(),
  contracts: z.object({
    DripPool: z.object({
      address: z.string().nullable(),
      deployBlock: z.number().int().nonnegative().nullable(),
    }),
  }),
});

/** The DripPool address and deploy block recorded in a deployments JSON, or null while it is still a template. */
export function readDeployment(file: string): { chainId: number; pool: Address; deployBlock: bigint } | null {
  if (!existsSync(file)) return null;
  const parsed = deploymentSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const { address, deployBlock } = parsed.contracts.DripPool;
  if (!address || deployBlock === null || !isAddress(address, { strict: false })) return null;
  return { chainId: parsed.chainId, pool: getAddress(address), deployBlock: BigInt(deployBlock) };
}
