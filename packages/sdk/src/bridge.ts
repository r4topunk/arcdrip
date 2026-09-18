// Optional: withdraw payroll on Arc and bridge it out with CCTP V2 (PRD 2.2, 5, 14).
//
// This module is in scope because Arc mainnet IS a CCTP V2 source chain today. Verified on 2026-09-18 by reading
// Arc mainnet (chain 5042) directly, not only the docs:
//   TokenMessengerV2      0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d  (messageBodyVersion() == 1)
//   MessageTransmitterV2  0x81d40f21f12a8f0e3252bccb954d722d4c464b64  (localDomain() == 26, version() == 1)
//   TokenMinterV2         0xfd78ee919681417d192449715b2594ab58f5d002  (burnLimitsPerMessage(USDC) == 1e13 units)
// and the implementation behind the TokenMessengerV2 proxy carries both `depositForBurn(...)` and
// `depositForBurnWithHook(...)` selectors. See docs/CCTP.md.
//
// Nothing about CCTP touches `DripPool`: the contract has no bridge in its audit surface (decision D6). This is
// two ordinary transactions from the member's own wallet — withdraw, then burn — and it lives here so the web app
// and scripts do not each re-derive the encoding.
import type { Address, Hash, Hex, PublicClient } from 'viem';
import { pad } from 'viem';
import {
  type ActionOptions,
  type DripPoolConfig,
  getUsdcAddress,
  isOk,
  type WriteResult,
  withdraw,
} from './actions.js';
import { ARC_MAINNET_CHAIN_ID, ARC_TESTNET_CHAIN_ID, type ArcChainId } from './constants.js';
import { erc20Abi } from './erc20.js';
import { type DecodedRevert, decodeRevert, TransactionRevertedError, WalletRequiredError } from './errors.js';

/** Arc's CCTP domain. Mainnet and testnet share it (both `localDomain() == 26`). */
export const ARC_CCTP_DOMAIN = 26 as const;

/** `TokenMessengerV2` per Arc chain: the contract that burns USDC on the source chain. */
export const CCTP_TOKEN_MESSENGER: Readonly<Record<ArcChainId, Address>> = {
  [ARC_MAINNET_CHAIN_ID]: '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d',
  [ARC_TESTNET_CHAIN_ID]: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
};

/** `MessageTransmitterV2` per Arc chain: where the attested message is received (and where burns are emitted). */
export const CCTP_MESSAGE_TRANSMITTER: Readonly<Record<ArcChainId, Address>> = {
  [ARC_MAINNET_CHAIN_ID]: '0x81d40f21f12a8f0e3252bccb954d722d4c464b64',
  [ARC_TESTNET_CHAIN_ID]: '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
};

/**
 * Destination domains, from Circle's CCTP V2 mainnet contract table (2026-09-18). EVM chains only: Solana, Sui,
 * Aptos and Noble have domains too, but their `mintRecipient` is not an EVM address, so this SDK does not pretend
 * to encode them. Any `uint32` is accepted by the functions below; this map is only a convenience.
 */
export const CCTP_DOMAINS = {
  ethereum: 0,
  avalanche: 1,
  optimism: 2,
  arbitrum: 3,
  base: 6,
  polygon: 7,
  unichain: 10,
  linea: 11,
  codex: 12,
  sonic: 13,
  worldchain: 14,
  monad: 15,
  sei: 16,
  xdc: 18,
  hyperevm: 19,
  ink: 21,
  plume: 22,
  arc: 26,
} as const satisfies Record<string, number>;
export type CctpChainName = keyof typeof CCTP_DOMAINS;

/**
 * `minFinalityThreshold` values CCTP V2 defines. `standard` waits for source-chain finality; `fast` settles in
 * seconds but charges a fee, so it needs a non-zero `maxFee`.
 */
export const FINALITY_THRESHOLD = { fast: 1000, standard: 2000 } as const;
export type TransferSpeed = keyof typeof FINALITY_THRESHOLD;

/** The slice of `TokenMessengerV2` this SDK calls. */
export const tokenMessengerV2Abi = [
  {
    type: 'function',
    name: 'depositForBurn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'localMessageTransmitter',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'messageBodyVersion',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint32' }],
  },
] as const;

/** EVM address as the left-padded `bytes32` CCTP expects for `mintRecipient` / `destinationCaller`. */
export function addressToBytes32(address: Address): Hex {
  return pad(address, { size: 32 });
}

/** `bytes32` back to an EVM address (the last 20 bytes). */
export function bytes32ToAddress(value: Hex): Address {
  return `0x${value.slice(-40)}` as Address;
}

/** The `bytes32` meaning "anyone may call receiveMessage on the destination chain". */
export const ANY_DESTINATION_CALLER: Hex = `0x${'00'.repeat(32)}`;

export type BridgeParams = {
  /** USDC units (1e-6 USDC) to burn on Arc. */
  amount: bigint;
  /** CCTP domain of the destination chain, or a name from `CCTP_DOMAINS`. */
  destination: number | CctpChainName;
  /** Who receives the minted USDC on the destination chain. */
  recipient: Address;
  /** `fast` costs a fee and settles in seconds; `standard` is free and waits for finality. Default `standard`. */
  speed?: TransferSpeed;
  /** Maximum fee in USDC units. Must be > 0 for `fast`, and is forced to 0 for `standard`. */
  maxFee?: bigint;
  /** Restrict who may call `receiveMessage` on the destination chain. Default: anyone. */
  destinationCaller?: Address;
  /** Override the `TokenMessengerV2` address (tests, a new deployment). */
  tokenMessenger?: Address;
  /** Override the burn token. Defaults to the USDC this `DripPool` was deployed against. */
  token?: Address;
};

/** The exact arguments `depositForBurn` will be called with. Pure, so it can be asserted without a chain. */
export type DepositForBurnArgs = readonly [bigint, number, Hex, Address, Hex, bigint, number];

export function resolveDomain(destination: number | CctpChainName): number {
  const domain = typeof destination === 'number' ? destination : CCTP_DOMAINS[destination];
  if (domain === undefined) throw new RangeError(`unknown CCTP destination: ${String(destination)}`);
  if (!Number.isInteger(domain) || domain < 0 || domain > 0xffffffff) {
    throw new RangeError(`CCTP domain must be a uint32, got ${domain}`);
  }
  if (domain === ARC_CCTP_DOMAIN) throw new RangeError('destination domain is Arc itself; nothing to bridge');
  return domain;
}

/** Builds (and validates) the `depositForBurn` arguments. Throws on an argument the contract would reject. */
export function buildDepositForBurn(params: BridgeParams & { token: Address }): DepositForBurnArgs {
  if (params.amount <= 0n) throw new RangeError('bridge amount must be > 0');
  const speed = params.speed ?? 'standard';
  const maxFee = speed === 'fast' ? (params.maxFee ?? 0n) : 0n;
  if (speed === 'fast' && maxFee <= 0n) throw new RangeError('a fast transfer needs maxFee > 0');
  if (maxFee >= params.amount) throw new RangeError('maxFee must be below the amount');
  return [
    params.amount,
    resolveDomain(params.destination),
    addressToBytes32(params.recipient),
    params.token,
    params.destinationCaller ? addressToBytes32(params.destinationCaller) : ANY_DESTINATION_CALLER,
    maxFee,
    FINALITY_THRESHOLD[speed],
  ] as const;
}

function resolveTokenMessenger(client: PublicClient, override?: Address): Address {
  if (override) return override;
  const chainId = client.chain?.id;
  const known = chainId === ARC_MAINNET_CHAIN_ID || chainId === ARC_TESTNET_CHAIN_ID;
  if (!known) {
    throw new RangeError(
      `no CCTP TokenMessengerV2 known for chainId ${chainId ?? 'unknown'}; pass \`tokenMessenger\``,
    );
  }
  return CCTP_TOKEN_MESSENGER[chainId as ArcChainId];
}

export type BridgeResult = { approveHash?: Hash; burnHash: Hash; args: DepositForBurnArgs };

/**
 * Approve (when short) and `depositForBurn`: USDC is burned on Arc and Circle's attestation lets the recipient
 * mint it on the destination chain. This SDK does not fetch the attestation or submit it — that is the
 * destination chain's job, and Circle's Iris API or Bridge Kit does it better than a payroll SDK would.
 */
export async function bridgeUsdc(
  config: DripPoolConfig,
  params: BridgeParams,
  options?: ActionOptions,
): Promise<WriteResult<BridgeResult>> {
  const account = options?.account ?? config.walletClient?.account;
  if (!config.walletClient || !account) throw new WalletRequiredError('bridgeUsdc');
  const owner = typeof account === 'string' ? account : account.address;
  const token = params.token ?? (await getUsdcAddress(config));
  const messenger = resolveTokenMessenger(config.publicClient, params.tokenMessenger);
  const args = buildDepositForBurn({ ...params, token });

  const allowance = await config.publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, messenger],
  });
  let approveHash: Hash | undefined;
  if (allowance < params.amount) {
    const approved = await sendSimulated(config, messenger, token, params.amount, account, options);
    if (typeof approved !== 'string') return approved;
    approveHash = approved;
  }
  try {
    const simulated = await config.publicClient.simulateContract({
      address: messenger,
      abi: tokenMessengerV2Abi,
      functionName: 'depositForBurn',
      args,
      account,
      ...(config.walletClient.chain ? { chain: config.walletClient.chain } : {}),
    });
    const burnHash = await config.walletClient.writeContract(simulated.request as never);
    const receipt =
      options?.waitForReceipt === false
        ? undefined
        : await config.publicClient.waitForTransactionReceipt({ hash: burnHash });
    if (receipt && receipt.status !== 'success')
      throw new TransactionRevertedError('depositForBurn', burnHash);
    return {
      ok: true,
      hash: burnHash,
      receipt,
      burnHash,
      args,
      ...(approveHash ? { approveHash } : {}),
    };
  } catch (cause) {
    if (cause instanceof TransactionRevertedError) throw cause;
    return { ok: false, error: decodeRevert(cause) };
  }
}

/** approve(token, messenger, amount) through the same simulate-first path. Returns the hash or a failure value. */
async function sendSimulated(
  config: DripPoolConfig,
  messenger: Address,
  token: Address,
  amount: bigint,
  account: NonNullable<ActionOptions['account']>,
  options?: ActionOptions,
): Promise<Hash | { ok: false; error: DecodedRevert }> {
  try {
    const simulated = await config.publicClient.simulateContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [messenger, amount],
      account,
      ...(config.walletClient?.chain ? { chain: config.walletClient.chain } : {}),
    });
    const hash = await config.walletClient!.writeContract(simulated.request as never);
    if (options?.waitForReceipt !== false) {
      const receipt = await config.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new TransactionRevertedError('approve', hash);
    }
    return hash;
  } catch (cause) {
    if (cause instanceof TransactionRevertedError) throw cause;
    return { ok: false, error: decodeRevert(cause) };
  }
}

export type WithdrawAndBridgeResult = BridgeResult & {
  withdrawHash: Hash;
  /** USDC units the withdrawal actually moved; this is what gets burned. */
  amount: bigint;
};

/**
 * `withdraw` from a pool and immediately bridge the proceeds out of Arc. Two or three transactions from the
 * member's own wallet; the pool never learns a bridge exists.
 *
 * The amount burned is what the withdrawal reported, not an amount the caller guessed, so a rate change or a
 * competing `withdrawFor` in between cannot make this try to burn more than arrived. A withdrawal that yields
 * nothing comes back as the contract's own `NothingToWithdraw`, and nothing is bridged.
 */
export async function withdrawAndBridge(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  params: Omit<BridgeParams, 'amount'> & { amount?: bigint },
  options?: ActionOptions,
): Promise<WriteResult<WithdrawAndBridgeResult>> {
  const withdrawn = await withdraw(config, poolId, options);
  if (!isOk(withdrawn)) return withdrawn;
  const amount = params.amount ?? withdrawn.amount;
  if (amount <= 0n) throw new RangeError('withdrawAndBridge: the withdrawal produced no USDC to bridge');
  const bridged = await bridgeUsdc(config, { ...params, amount }, options);
  if (!isOk(bridged)) return bridged;
  return { ...bridged, withdrawHash: withdrawn.hash, amount };
}
