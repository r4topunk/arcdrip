// Errors the SDK throws on purpose. Switch on `code`, never on the message. Revert decoding lives here too:
// every write simulates first, and a failed simulation is turned into a typed `DecodedRevert` (PRD 5).
import {
  type Abi,
  BaseError,
  ContractFunctionRevertedError,
  decodeErrorResult,
  type Hash,
  type Hex,
} from 'viem';
import { dripPoolAbi } from './abi/DripPool.js';

export type ArcDripErrorCode =
  | 'INVALID_INPUT'
  | 'WALLET_REQUIRED'
  | 'POOL_NOT_FOUND'
  | 'CONTRACT_REVERT'
  | 'TX_REVERTED'
  | 'EVENT_NOT_FOUND';

/** Base class of every error the SDK raises deliberately. */
export class ArcDripError extends Error {
  readonly code: ArcDripErrorCode;
  constructor(code: ArcDripErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ArcDripError';
    this.code = code;
  }
}

/** An argument failed its Zod schema. Nothing was computed, sent or signed. One line per problem. */
export class InvalidInputError extends ArcDripError {
  readonly issues: readonly string[];
  constructor(what: string, issues: readonly string[], options?: { cause?: unknown }) {
    super(
      'INVALID_INPUT',
      issues.length ? `invalid ${what}: ${issues.join('; ')}` : `invalid ${what}`,
      options,
    );
    this.name = 'InvalidInputError';
    this.issues = issues;
  }
}

/** Every custom error `DripPool` can revert with (PRD 4.4), plus the two it inherits from OZ. */
export const DRIP_ERROR_NAMES = [
  'PoolNotFound',
  'NotOwner',
  'NotPendingOwner',
  'PoolCancelled',
  'ZeroAddress',
  'ZeroAmount',
  'BadRate',
  'BadShares',
  'BadStartTime',
  'BadPayout',
  'NoOp',
  'NothingToWithdraw',
  'InsufficientUnstreamed',
  'LengthMismatch',
  'TooManyItems',
  'ReentrancyGuardReentrantCall',
  'SafeERC20FailedOperation',
] as const;
export type DripErrorName = (typeof DRIP_ERROR_NAMES)[number];

export function isDripErrorName(value: unknown): value is DripErrorName {
  return typeof value === 'string' && (DRIP_ERROR_NAMES as readonly string[]).includes(value);
}

/** Coarse classification, so a UI can pick a message without switching on seventeen names. */
export type RevertKind =
  | 'not-found'
  | 'not-authorized'
  | 'cancelled'
  | 'bad-input'
  | 'no-op'
  | 'nothing-to-withdraw'
  | 'insufficient-funds'
  | 'token'
  | 'unknown';

/** A revert decoded into something typed. `name` is `Error` for revert strings and `Unknown` when opaque. */
export type DecodedRevert = {
  name: DripErrorName | 'Error' | 'Panic' | 'Unknown';
  args?: readonly unknown[];
  kind: RevertKind;
  /** One line, safe to show a user. */
  message: string;
  /** Raw revert data when the node returned any. */
  data?: Hex;
};

function classifyRevert(name: string, text: string): RevertKind {
  switch (name) {
    case 'PoolNotFound':
      return 'not-found';
    case 'NotOwner':
    case 'NotPendingOwner':
      return 'not-authorized';
    case 'PoolCancelled':
      return 'cancelled';
    case 'ZeroAddress':
    case 'ZeroAmount':
    case 'BadRate':
    case 'BadShares':
    case 'BadStartTime':
    case 'BadPayout':
    case 'LengthMismatch':
    case 'TooManyItems':
      return 'bad-input';
    case 'NoOp':
      return 'no-op';
    case 'NothingToWithdraw':
      return 'nothing-to-withdraw';
    case 'InsufficientUnstreamed':
      return 'insufficient-funds';
    case 'SafeERC20FailedOperation':
      return 'token';
  }
  const t = text.toLowerCase();
  if (t.includes('blacklist') || t.includes('blocklist')) return 'token';
  if (t.includes('allowance') || t.includes('balance')) return 'insufficient-funds';
  return 'unknown';
}

/** Human sentence per custom error. Kept here so the web app and the CLI say the same thing. */
export function explainRevert(name: string, args: readonly unknown[] | undefined): string {
  switch (name) {
    case 'PoolNotFound':
      return 'that pool does not exist';
    case 'NotOwner':
      return 'only the pool owner can do that';
    case 'NotPendingOwner':
      return 'only the pending owner can accept ownership';
    case 'PoolCancelled':
      return 'the pool is cancelled; members can still withdraw, nothing else changes';
    case 'ZeroAddress':
      return 'the zero address is not allowed here';
    case 'ZeroAmount':
      return 'the amount must be greater than zero';
    case 'BadRate':
      return 'the rate is above MAX_RATE';
    case 'BadShares':
      return 'shares are above MAX_SHARES, or the pool would exceed MAX_TOTAL_SHARES';
    case 'BadStartTime':
      return 'startTime must be zero (now) or in the future';
    case 'BadPayout':
      return 'the payout address cannot be the DripPool contract';
    case 'NoOp':
      return 'that call would change nothing';
    case 'NothingToWithdraw':
      return 'nothing to withdraw yet: less than 0.000001 USDC has accrued';
    case 'InsufficientUnstreamed':
      return 'that amount is already streamed to members and cannot be taken out';
    case 'LengthMismatch':
      return 'the two arrays must have the same length';
    case 'TooManyItems':
      return 'too many entries: the batch limit is 100';
    case 'ReentrancyGuardReentrantCall':
      return 'reentrant call';
    case 'SafeERC20FailedOperation':
      return `the USDC transfer failed${args?.[0] ? ` (token ${String(args[0])})` : ''}`;
    default:
      return name;
  }
}

function argsText(args: readonly unknown[] | undefined): string {
  if (!args || args.length === 0) return '';
  return `(${args.map((a) => (typeof a === 'bigint' ? a.toString() : String(a))).join(', ')})`;
}

function fromNameAndArgs(
  name: string,
  args: readonly unknown[] | undefined,
  data: Hex | undefined,
): DecodedRevert {
  const known = isDripErrorName(name);
  const message = known ? explainRevert(name, args) : `${name}${argsText(args)}`;
  const decoded: DecodedRevert = {
    name: known ? name : name === 'Error' || name === 'Panic' ? name : 'Unknown',
    kind: classifyRevert(name, message),
    message,
  };
  if (args) decoded.args = args;
  if (data) decoded.data = data;
  return decoded;
}

/**
 * Decodes raw revert data against the `DripPool` ABI, falling back to `Error(string)` / `Panic(uint256)`
 * (what USDC's FiatToken reverts with). Never throws.
 */
const errorStringAbi = [
  { type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] },
  { type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] },
] as const satisfies Abi;

export function decodeRevertData(
  data: Hex | undefined,
  abi: Abi = dripPoolAbi as unknown as Abi,
): DecodedRevert {
  if (!data || data === '0x') {
    return { name: 'Unknown', kind: 'unknown', message: 'the call reverted without a reason' };
  }
  for (const candidate of [abi, errorStringAbi as unknown as Abi]) {
    try {
      const result = decodeErrorResult({ abi: candidate, data });
      return fromNameAndArgs(result.errorName, result.args as readonly unknown[] | undefined, data);
    } catch {
      // try the next ABI
    }
  }
  return { name: 'Unknown', kind: 'unknown', message: `unrecognised revert data ${data.slice(0, 10)}`, data };
}

/**
 * Decodes anything viem threw (a simulation failure, a gas estimation failure, a raw revert) into a
 * `DecodedRevert`. Never throws: an unknown shape comes back as `Unknown` with the original message.
 */
export function decodeRevert(error: unknown): DecodedRevert {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError) as
      | ContractFunctionRevertedError
      | undefined;
    if (reverted) {
      if (reverted.data?.errorName) {
        return fromNameAndArgs(
          reverted.data.errorName,
          reverted.data.args as readonly unknown[] | undefined,
          reverted.raw,
        );
      }
      if (reverted.reason) {
        return fromNameAndArgs('Error', [reverted.reason], reverted.raw);
      }
      if (reverted.raw) return decodeRevertData(reverted.raw);
    }
    const withData = error.walk((e) => typeof (e as { data?: unknown }).data === 'string') as
      | { data?: Hex }
      | undefined;
    if (withData?.data) return decodeRevertData(withData.data);
    const text = error.shortMessage || error.message;
    return { name: 'Unknown', kind: classifyRevert('Unknown', text), message: text };
  }
  if (typeof error === 'object' && error !== null && typeof (error as { data?: unknown }).data === 'string') {
    return decodeRevertData((error as { data: Hex }).data);
  }
  const text = error instanceof Error ? error.message : String(error);
  return { name: 'Unknown', kind: classifyRevert('Unknown', text), message: text };
}

/** A read, a simulation or a transaction reverted. `reason` is the decoded custom error. */
export class ContractRevertError extends ArcDripError {
  readonly functionName: string;
  readonly reason: DecodedRevert;
  constructor(functionName: string, reason: DecodedRevert, options?: { cause?: unknown }) {
    super('CONTRACT_REVERT', `${functionName} reverted: ${reason.message}`, options);
    this.name = 'ContractRevertError';
    this.functionName = functionName;
    this.reason = reason;
  }
  get errorName(): DecodedRevert['name'] {
    return this.reason.name;
  }
}

/** The simulation passed but the mined transaction reverted (a race, or a state change in between). */
export class TransactionRevertedError extends ArcDripError {
  readonly hash: Hash;
  readonly functionName: string;
  /** Decoded by replaying the call at the block it landed in, when the node lets us. */
  readonly reason: DecodedRevert | undefined;
  constructor(functionName: string, hash: Hash, reason?: DecodedRevert) {
    super(
      'TX_REVERTED',
      `${functionName} transaction ${hash} reverted on-chain${reason ? `: ${reason.message}` : ''}`,
    );
    this.name = 'TransactionRevertedError';
    this.hash = hash;
    this.functionName = functionName;
    this.reason = reason;
  }
}

/** An expected event was not in the receipt (wrong address, wrong ABI, or a reorg). */
export class EventNotFoundError extends ArcDripError {
  readonly hash: Hash;
  constructor(eventName: string, hash: Hash) {
    super('EVENT_NOT_FOUND', `event ${eventName} not found in the receipt of ${hash}`);
    this.name = 'EventNotFoundError';
    this.hash = hash;
  }
}

/** A write was requested without a wallet client holding an account. Nothing was sent. */
export class WalletRequiredError extends ArcDripError {
  constructor(action: string) {
    super('WALLET_REQUIRED', `${action} needs a walletClient with an account`);
    this.name = 'WalletRequiredError';
  }
}

/** No `DripPool` address is known for this chain and none was passed. */
export class PoolAddressUnknownError extends ArcDripError {
  readonly chainId: number | undefined;
  constructor(chainId: number | undefined) {
    super(
      'POOL_NOT_FOUND',
      `no DripPool deployment known for chainId ${chainId ?? 'unknown'}; pass \`address\` explicitly`,
    );
    this.name = 'PoolAddressUnknownError';
    this.chainId = chainId;
  }
}
