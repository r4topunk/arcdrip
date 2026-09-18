// viem reads and writes against `DripPool` (PRD 5).
//
// Two rules hold for every write in this file:
//   1. It simulates first. Nothing is signed or sent until `simulateContract` succeeds, so a rejected call costs
//      the caller no gas and no wallet prompt.
//   2. A failed simulation comes back as a value, not an exception: `{ ok: false, error: DecodedRevert }` with the
//      custom error decoded (`NothingToWithdraw`, `NotOwner`, ...). A UI can render `error.message` directly.
//      Exceptions are reserved for things that are not a contract decision: a missing wallet, an invalid argument,
//      a transport failure, or a transaction that reverted *after* a green simulation.
//
// All amounts are USDC units (1e-6 USDC) at the boundary and wad inside, exactly as the contract has them.
import {
  type Account,
  type Address,
  type Chain,
  encodeFunctionData,
  type Hash,
  type Hex,
  type PublicClient,
  parseEventLogs,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { dripPoolAbi } from './abi/DripPool.js';
import { ARC_CHAIN_IDS, type ArcChainId, DRIP_POOL_ADDRESS, MAX_BATCH } from './constants.js';
import { erc20Abi } from './erc20.js';
import {
  type DecodedRevert,
  decodeRevert,
  EventNotFoundError,
  PoolAddressUnknownError,
  TransactionRevertedError,
  WalletRequiredError,
} from './errors.js';
import { createLogger, type Logger, newCorrelationId, withBindings } from './logger.js';
import {
  type AccrualPool,
  addressSchema,
  type MemberState,
  type PoolState,
  parseMemberState,
  parsePoolState,
  parseWith,
  poolIdSchema,
  rateSchema,
  sharesSchema,
  timestampSchema,
  unitsSchema,
} from './schemas.js';

export type { DecodedRevert };

/** Everything an action needs: where the contract is, who reads, who signs. */
export type DripPoolConfig = {
  publicClient: PublicClient;
  /** Required for writes only. Must carry an account (or one is passed per call). */
  walletClient?: WalletClient;
  /** `DripPool` address. Defaults to the deployment recorded for the client's chain. */
  address?: Address;
  /** Defaults to the SDK's silent logger. */
  logger?: Logger;
  /** Bound to every log line of every action made with this config. */
  correlationId?: string;
  /** Percentage of the gas estimate to send. Default `DEFAULT_GAS_BUFFER_PERCENT` (130). */
  gasBufferPercent?: number;
};

/**
 * Percentage of the gas estimate actually sent. 100 means "the estimate exactly", which is not enough here: see
 * the comment in `write`. 130 leaves room for two fresh SSTOREs without ever being close to a block limit.
 */
export const DEFAULT_GAS_BUFFER_PERCENT = 130;

/** Per-call overrides. `correlationId` here wins over the config's. */
export type ActionOptions = {
  correlationId?: string;
  /** Account to send from, when the wallet client has none bound. */
  account?: Account | Address;
  /** Wait for the receipt (default true). With `false`, `receipt` is undefined and only the hash comes back. */
  waitForReceipt?: boolean;
  /** Percentage of the gas estimate to send, for this call only. */
  gasBufferPercent?: number;
};

/** A write that made it on-chain. `T` carries what the call returned or what its event says. */
export type WriteSuccess<T> = { ok: true; hash: Hash; receipt: TransactionReceipt | undefined } & T;
/** A write the contract refused. Nothing was signed, nothing was sent. */
export type WriteFailure = { ok: false; error: DecodedRevert };
/** `{}`: a write that carries nothing beyond the hash and the receipt. */
export type NoExtra = Record<never, never>;
export type WriteResult<T = NoExtra> = WriteSuccess<T> | WriteFailure;

/** Narrowing helper, so callers can write `if (isOk(result))`. */
export function isOk<T>(result: WriteResult<T>): result is WriteSuccess<T> {
  return result.ok;
}

// ---------------------------------------------------------------------------------------------- internals

function resolveAddress(config: DripPoolConfig): Address {
  if (config.address) return config.address;
  const chainId = config.publicClient.chain?.id;
  const known = (ARC_CHAIN_IDS as readonly number[]).includes(chainId ?? -1)
    ? DRIP_POOL_ADDRESS[chainId as ArcChainId]
    : null;
  if (!known) throw new PoolAddressUnknownError(chainId);
  return known;
}

function resolveLogger(config: DripPoolConfig, action: string, options?: ActionOptions): Logger {
  const base = config.logger ?? createLogger();
  return withBindings(base, {
    action,
    correlationId: options?.correlationId ?? config.correlationId ?? newCorrelationId(),
  });
}

function resolveAccount(config: DripPoolConfig, action: string, options?: ActionOptions): Account | Address {
  const account = options?.account ?? config.walletClient?.account;
  if (!config.walletClient || !account) throw new WalletRequiredError(action);
  return account;
}

type WriteArgs = {
  functionName: string;
  args: readonly unknown[];
  address?: Address;
  abi?: typeof dripPoolAbi | typeof erc20Abi;
};

/**
 * The one path every write goes through: simulate, send, wait, hand back the receipt and the simulated return
 * value. The simulated return is safe to use because the simulation ran against the same block the tx lands on
 * or later; where that matters (`withdrawForBatch`) the caller reads the events instead.
 */
async function write(
  config: DripPoolConfig,
  action: string,
  { functionName, args, address, abi }: WriteArgs,
  options?: ActionOptions,
): Promise<
  { ok: true; hash: Hash; receipt: TransactionReceipt | undefined; result: unknown } | WriteFailure
> {
  const log = resolveLogger(config, action, options);
  const account = resolveAccount(config, action, options);
  const to = address ?? resolveAddress(config);
  const wallet = config.walletClient as WalletClient;
  let request: Parameters<WalletClient['writeContract']>[0];
  let result: unknown;
  try {
    const simulated = await config.publicClient.simulateContract({
      address: to,
      abi: (abi ?? dripPoolAbi) as typeof dripPoolAbi,
      functionName: functionName as never,
      args: args as never,
      account,
      ...(wallet.chain ? { chain: wallet.chain as Chain } : {}),
    });
    request = simulated.request as Parameters<WalletClient['writeContract']>[0];
    result = simulated.result;
    // Gas needs headroom on a contract whose storage writes depend on the clock. Estimation runs one block
    // before execution, and in that second an accrual can turn `accIndex` and `owed` from zero to non-zero,
    // which costs two fresh SSTOREs the estimate never saw. viem sends the bare estimate, so the transaction
    // would run out of gas. Arc's 0.5 s blocks make this likely rather than theoretical.
    const estimated = await config.publicClient.estimateContractGas({
      address: to,
      abi: (abi ?? dripPoolAbi) as typeof dripPoolAbi,
      functionName: functionName as never,
      args: args as never,
      account,
    });
    const percent = BigInt(
      options?.gasBufferPercent ?? config.gasBufferPercent ?? DEFAULT_GAS_BUFFER_PERCENT,
    );
    request = { ...request, gas: (estimated * percent) / 100n } as typeof request;
  } catch (cause) {
    const error = decodeRevert(cause);
    log.warn({ functionName, error }, 'simulation reverted; nothing sent');
    return { ok: false, error };
  }
  const hash = await wallet.writeContract(request);
  log.info({ functionName, hash }, 'transaction sent');
  if (options?.waitForReceipt === false) return { ok: true, hash, receipt: undefined, result };
  const receipt = await config.publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') {
    // The simulation was green, so something changed in between. Replay the call at the block it landed in to
    // get the real reason instead of a bare "reverted".
    const reason = await replayRevert(config, to, { functionName, args, abi }, account, receipt.blockNumber);
    log.error({ functionName, hash, reason }, 'transaction reverted after a green simulation');
    throw new TransactionRevertedError(action, hash, reason);
  }
  log.info({ functionName, hash, gasUsed: receipt.gasUsed }, 'transaction mined');
  return { ok: true, hash, receipt, result };
}

/** Re-runs a mined-but-reverted call at its own block, only to decode why. Never throws. */
async function replayRevert(
  config: DripPoolConfig,
  to: Address,
  call: WriteArgs,
  account: Account | Address,
  blockNumber: bigint,
): Promise<DecodedRevert | undefined> {
  try {
    const data = encodeFunctionData({
      abi: (call.abi ?? dripPoolAbi) as typeof dripPoolAbi,
      functionName: call.functionName as never,
      args: call.args as never,
    }) as Hex;
    await config.publicClient.call({ to, data, blockNumber, account });
    return undefined;
  } catch (cause) {
    return decodeRevert(cause);
  }
}

type AnyEvent = { eventName: string; args: Record<string, unknown> };

/** Decoded `DripPool` events of one name from a receipt, in log order. Args stay `unknown` until a caller casts. */
function eventsFrom(receipt: TransactionReceipt | undefined, eventName: string): AnyEvent[] {
  if (!receipt) return [];
  const logs = parseEventLogs({ abi: dripPoolAbi, logs: receipt.logs }) as unknown as AnyEvent[];
  return logs.filter((log) => log.eventName === eventName);
}

function bigintArg(event: AnyEvent | undefined, key: string): bigint | undefined {
  const value = event?.args?.[key];
  return typeof value === 'bigint' ? value : undefined;
}

const parsePoolId = (value: unknown): bigint => parseWith(poolIdSchema, 'poolId', value);
const parseAddressArg = (label: string, value: unknown): Address => parseWith(addressSchema, label, value);

// ------------------------------------------------------------------------------------------------- reads

/** `getPool(poolId)`. Throws `ContractRevertError` shape via viem when the pool does not exist. */
export async function getPool(config: DripPoolConfig, poolId: bigint | number | string): Promise<PoolState> {
  const id = parsePoolId(poolId);
  const raw = await config.publicClient.readContract({
    address: resolveAddress(config),
    abi: dripPoolAbi,
    functionName: 'getPool',
    args: [id],
  });
  return parsePoolState(raw);
}

/** `getPool`, returning `null` instead of reverting when the pool id was never created. */
export async function getPoolOrNull(
  config: DripPoolConfig,
  poolId: bigint | number | string,
): Promise<PoolState | null> {
  try {
    return await getPool(config, poolId);
  } catch (cause) {
    if (decodeRevert(cause).name === 'PoolNotFound') return null;
    throw cause;
  }
}

/** `getMember(poolId, member)`. A member that was never set comes back zeroed, which is the truth. */
export async function getMember(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  member: Address,
): Promise<MemberState> {
  const raw = await config.publicClient.readContract({
    address: resolveAddress(config),
    abi: dripPoolAbi,
    functionName: 'getMember',
    args: [parsePoolId(poolId), parseAddressArg('member', member)],
  });
  return parseMemberState(raw);
}

/** `claimable(poolId, member)` in USDC units, straight from the chain (the mirror in `math.ts` must match it). */
export async function claimableOnchain(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  member: Address,
): Promise<bigint> {
  return config.publicClient.readContract({
    address: resolveAddress(config),
    abi: dripPoolAbi,
    functionName: 'claimable',
    args: [parsePoolId(poolId), parseAddressArg('member', member)],
  });
}

/** `fundedUntil(poolId)`: the unix second the pool runs dry, or `type(uint64).max` when nothing is consumed. */
export async function fundedUntilOnchain(
  config: DripPoolConfig,
  poolId: bigint | number | string,
): Promise<bigint> {
  const value = await config.publicClient.readContract({
    address: resolveAddress(config),
    abi: dripPoolAbi,
    functionName: 'fundedUntil',
    args: [parsePoolId(poolId)],
  });
  return BigInt(value);
}

/** `unstreamed(poolId)`: USDC units the owner may still pull out. */
export async function unstreamedOnchain(
  config: DripPoolConfig,
  poolId: bigint | number | string,
): Promise<bigint> {
  return config.publicClient.readContract({
    address: resolveAddress(config),
    abi: dripPoolAbi,
    functionName: 'unstreamed',
    args: [parsePoolId(poolId)],
  });
}

/** `nextPoolId()`: the id the next `createPool` will take, so `nextPoolId - 1` is the newest pool. */
export async function getNextPoolId(config: DripPoolConfig): Promise<bigint> {
  return config.publicClient.readContract({
    address: resolveAddress(config),
    abi: dripPoolAbi,
    functionName: 'nextPoolId',
  });
}

/** The USDC address this `DripPool` was deployed against (immutable). */
export async function getUsdcAddress(config: DripPoolConfig): Promise<Address> {
  return config.publicClient.readContract({
    address: resolveAddress(config),
    abi: dripPoolAbi,
    functionName: 'usdc',
  });
}

/** Current USDC allowance from `owner` to the `DripPool` contract, in units. */
export async function getAllowance(config: DripPoolConfig, owner: Address, token?: Address): Promise<bigint> {
  const usdc = token ?? (await getUsdcAddress(config));
  return config.publicClient.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [parseAddressArg('owner', owner), resolveAddress(config)],
  });
}

// ------------------------------------------------------------------------------------------------ writes

export type CreatePoolParams = {
  owner: Address;
  /** wad per second for the whole pool. Build it with `toRatePerSecond`. */
  ratePerSecond: bigint;
  /** Unix seconds. `0` (default) means "now". Anything else must be in the future. */
  startTime?: bigint | number;
  /** Emitted only, never stored. */
  name: string;
};

/** `createPool`. The new `poolId` comes from the `PoolCreated` event, falling back to the simulated return. */
export async function createPool(
  config: DripPoolConfig,
  params: CreatePoolParams,
  options?: ActionOptions,
): Promise<WriteResult<{ poolId: bigint }>> {
  const owner = parseAddressArg('owner', params.owner);
  const rate = parseWith(rateSchema, 'ratePerSecond', params.ratePerSecond);
  const startTime = parseWith(timestampSchema, 'startTime', params.startTime ?? 0n);
  const res = await write(
    config,
    'createPool',
    { functionName: 'createPool', args: [owner, rate, startTime, params.name] },
    options,
  );
  if (!res.ok) return res;
  const fromEvent = bigintArg(eventsFrom(res.receipt, 'PoolCreated')[0], 'poolId');
  const poolId = fromEvent ?? (typeof res.result === 'bigint' ? res.result : undefined);
  if (poolId === undefined) throw new EventNotFoundError('PoolCreated', res.hash);
  return { ok: true, hash: res.hash, receipt: res.receipt, poolId };
}

/** `deposit(poolId, amount)`. The caller must already have approved `DripPool` for `amount`. */
export async function deposit(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  amount: bigint,
  options?: ActionOptions,
): Promise<WriteResult> {
  const res = await write(
    config,
    'deposit',
    { functionName: 'deposit', args: [parsePoolId(poolId), parseWith(unitsSchema, 'amount', amount)] },
    options,
  );
  return res.ok ? { ok: true, hash: res.hash, receipt: res.receipt } : res;
}

export type ApproveAndDepositResult = {
  /** The approve transaction, when one was needed. */
  approveHash?: Hash;
  /** True when the existing allowance already covered the deposit. */
  approvalSkipped: boolean;
};

/**
 * `approve` (only if the allowance is short) followed by `deposit`. Two transactions, in that order — the
 * contract has no gasless deposit path in v1 (PRD 2.2).
 */
export async function approveAndDeposit(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  amount: bigint,
  options?: ActionOptions & { token?: Address; approveExactly?: boolean },
): Promise<WriteResult<ApproveAndDepositResult>> {
  const id = parsePoolId(poolId);
  const units = parseWith(unitsSchema, 'amount', amount);
  const account = resolveAccount(config, 'approveAndDeposit', options);
  const owner = typeof account === 'string' ? account : account.address;
  const usdc = options?.token ?? (await getUsdcAddress(config));
  const allowance = await getAllowance(config, owner, usdc);
  let approveHash: Hash | undefined;
  if (allowance < units) {
    const approved = await write(
      config,
      'approve',
      { functionName: 'approve', args: [resolveAddress(config), units], address: usdc, abi: erc20Abi },
      options,
    );
    if (!approved.ok) return approved;
    approveHash = approved.hash;
  }
  const res = await write(config, 'deposit', { functionName: 'deposit', args: [id, units] }, options);
  if (!res.ok) return res;
  return {
    ok: true,
    hash: res.hash,
    receipt: res.receipt,
    approvalSkipped: approveHash === undefined,
    ...(approveHash ? { approveHash } : {}),
  };
}

/** `setRate(poolId, rate)`. `0` pauses the stream; nothing accrues and nothing is consumed while paused. */
export async function setRate(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  ratePerSecond: bigint,
  options?: ActionOptions,
): Promise<WriteResult> {
  const res = await write(
    config,
    'setRate',
    {
      functionName: 'setRate',
      args: [parsePoolId(poolId), parseWith(rateSchema, 'ratePerSecond', ratePerSecond)],
    },
    options,
  );
  return res.ok ? { ok: true, hash: res.hash, receipt: res.receipt } : res;
}

/** `setShares(poolId, member, shares)`. `0` removes the member; whatever they accrued stays withdrawable. */
export async function setShares(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  member: Address,
  shares: bigint,
  options?: ActionOptions,
): Promise<WriteResult<{ totalShares?: bigint }>> {
  const res = await write(
    config,
    'setShares',
    {
      functionName: 'setShares',
      args: [
        parsePoolId(poolId),
        parseAddressArg('member', member),
        parseWith(sharesSchema, 'shares', shares),
      ],
    },
    options,
  );
  if (!res.ok) return res;
  const total = bigintArg(eventsFrom(res.receipt, 'SharesSet')[0], 'totalShares');
  return {
    ok: true,
    hash: res.hash,
    receipt: res.receipt,
    ...(total !== undefined ? { totalShares: total } : {}),
  };
}

/**
 * `setSharesBatch(poolId, members, shares)`: one accrual for the whole re-weighting, so no member can gain or
 * lose a second because of the order inside the batch. At most `MAX_BATCH` entries.
 */
export async function setSharesBatch(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  entries: readonly { member: Address; shares: bigint }[],
  options?: ActionOptions,
): Promise<WriteResult<{ totalShares?: bigint }>> {
  if (entries.length === 0) throw new RangeError('setSharesBatch: entries must not be empty');
  if (entries.length > MAX_BATCH) throw new RangeError(`setSharesBatch: at most ${MAX_BATCH} entries`);
  const membersList = entries.map((e) => parseAddressArg('member', e.member));
  const sharesList = entries.map((e) => parseWith(sharesSchema, 'shares', e.shares));
  const res = await write(
    config,
    'setSharesBatch',
    { functionName: 'setSharesBatch', args: [parsePoolId(poolId), membersList, sharesList] },
    options,
  );
  if (!res.ok) return res;
  const logs = eventsFrom(res.receipt, 'SharesSet');
  const total = bigintArg(logs[logs.length - 1], 'totalShares');
  return {
    ok: true,
    hash: res.hash,
    receipt: res.receipt,
    ...(total !== undefined ? { totalShares: total } : {}),
  };
}

/** `setPayoutAddress(poolId, to)`. `0x0` resets to the member's own address. Callable with zero shares. */
export async function setPayoutAddress(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  to: Address,
  options?: ActionOptions,
): Promise<WriteResult> {
  const res = await write(
    config,
    'setPayoutAddress',
    { functionName: 'setPayoutAddress', args: [parsePoolId(poolId), parseAddressArg('to', to)] },
    options,
  );
  return res.ok ? { ok: true, hash: res.hash, receipt: res.receipt } : res;
}

function withdrawnAmount(receipt: TransactionReceipt | undefined, fallback: unknown): bigint {
  const fromEvent = bigintArg(eventsFrom(receipt, 'Withdrawn')[0], 'amount');
  if (fromEvent !== undefined) return fromEvent;
  return typeof fallback === 'bigint' ? fallback : 0n;
}

/** `withdraw(poolId)`: the caller pulls their own accrued USDC to their payout address. */
export async function withdraw(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  options?: ActionOptions,
): Promise<WriteResult<{ amount: bigint }>> {
  const res = await write(
    config,
    'withdraw',
    { functionName: 'withdraw', args: [parsePoolId(poolId)] },
    options,
  );
  if (!res.ok) return res;
  return { ok: true, hash: res.hash, receipt: res.receipt, amount: withdrawnAmount(res.receipt, res.result) };
}

/**
 * `withdrawFor(poolId, member)`: anyone can push a member's accrued USDC to that member's payout address. The
 * caller pays the gas and receives nothing — this is what lets a member with no USDC for gas still be paid.
 */
export async function withdrawFor(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  member: Address,
  options?: ActionOptions,
): Promise<WriteResult<{ amount: bigint }>> {
  const res = await write(
    config,
    'withdrawFor',
    { functionName: 'withdrawFor', args: [parsePoolId(poolId), parseAddressArg('member', member)] },
    options,
  );
  if (!res.ok) return res;
  return { ok: true, hash: res.hash, receipt: res.receipt, amount: withdrawnAmount(res.receipt, res.result) };
}

export type BatchPayout = { member: Address; amount: bigint };
export type WithdrawForBatchResult = {
  /** Units actually transferred. */
  total: bigint;
  paid: BatchPayout[];
  /** Members whose transfer failed (blocklist, reverting payout contract). Their state was restored. */
  skipped: BatchPayout[];
};

/**
 * `withdrawForBatch(poolId, members)`: "Pay everyone" in one transaction. The contract never reverts because of
 * one member — a failed transfer is rolled back for that member only and reported as `WithdrawSkipped`, which is
 * what makes this blocklist-safe. Members with nothing to withdraw are skipped silently and appear in neither list.
 */
export async function withdrawForBatch(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  members: readonly Address[],
  options?: ActionOptions,
): Promise<WriteResult<WithdrawForBatchResult>> {
  if (members.length === 0) throw new RangeError('withdrawForBatch: members must not be empty');
  if (members.length > MAX_BATCH) throw new RangeError(`withdrawForBatch: at most ${MAX_BATCH} members`);
  const list = members.map((m) => parseAddressArg('member', m));
  const res = await write(
    config,
    'withdrawForBatch',
    { functionName: 'withdrawForBatch', args: [parsePoolId(poolId), list] },
    options,
  );
  if (!res.ok) return res;
  const toPayout = (log: AnyEvent): BatchPayout => ({
    member: log.args.member as Address,
    amount: (log.args.amount as bigint) ?? 0n,
  });
  const paid: BatchPayout[] = eventsFrom(res.receipt, 'Withdrawn').map(toPayout);
  const skipped: BatchPayout[] = eventsFrom(res.receipt, 'WithdrawSkipped').map(toPayout);
  const total = res.receipt
    ? paid.reduce((sum, p) => sum + p.amount, 0n)
    : typeof res.result === 'bigint'
      ? res.result
      : 0n;
  return { ok: true, hash: res.hash, receipt: res.receipt, total, paid, skipped };
}

/**
 * Splits a member list into `withdrawForBatch` transactions of at most `MAX_BATCH` addresses. Pure, so the web
 * app can show "3 transactions" before asking the user to sign anything.
 */
export function chunkMembers<T>(members: readonly T[], size: number = MAX_BATCH): T[][] {
  if (!Number.isInteger(size) || size <= 0) throw new RangeError('chunk size must be a positive integer');
  const chunks: T[][] = [];
  for (let i = 0; i < members.length; i += size) chunks.push(members.slice(i, i + size));
  return chunks;
}

/** Runs `withdrawForBatch` over every chunk, in order, and merges the results. Stops at the first refusal. */
export async function payEveryone(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  members: readonly Address[],
  options?: ActionOptions & { chunkSize?: number },
): Promise<WriteResult<WithdrawForBatchResult & { hashes: Hash[] }>> {
  const chunks = chunkMembers(members, options?.chunkSize ?? MAX_BATCH);
  if (chunks.length === 0) throw new RangeError('payEveryone: members must not be empty');
  const hashes: Hash[] = [];
  const paid: BatchPayout[] = [];
  const skipped: BatchPayout[] = [];
  let total = 0n;
  let last: WriteSuccess<WithdrawForBatchResult> | undefined;
  for (const chunk of chunks) {
    const res = await withdrawForBatch(config, poolId, chunk, options);
    if (!res.ok) return res;
    hashes.push(res.hash);
    paid.push(...res.paid);
    skipped.push(...res.skipped);
    total += res.total;
    last = res;
  }
  return { ok: true, hash: last!.hash, receipt: last!.receipt, total, paid, skipped, hashes };
}

/** `withdrawUnstreamed(poolId, amount, to)`: the owner takes back funds that are not yet streamed. */
export async function withdrawUnstreamed(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  amount: bigint,
  to: Address,
  options?: ActionOptions,
): Promise<WriteResult> {
  const res = await write(
    config,
    'withdrawUnstreamed',
    {
      functionName: 'withdrawUnstreamed',
      args: [parsePoolId(poolId), parseWith(unitsSchema, 'amount', amount), parseAddressArg('to', to)],
    },
    options,
  );
  return res.ok ? { ok: true, hash: res.hash, receipt: res.receipt } : res;
}

/**
 * `cancel(poolId, to)`: stops the stream for good and refunds only what was never streamed. Members keep
 * withdrawing what they already earned, forever.
 */
export async function cancel(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  to: Address,
  options?: ActionOptions,
): Promise<WriteResult<{ refund: bigint }>> {
  const res = await write(
    config,
    'cancel',
    { functionName: 'cancel', args: [parsePoolId(poolId), parseAddressArg('to', to)] },
    options,
  );
  if (!res.ok) return res;
  const fromEvent = bigintArg(eventsFrom(res.receipt, 'Cancelled')[0], 'refund');
  const refund = fromEvent ?? (typeof res.result === 'bigint' ? res.result : 0n);
  return { ok: true, hash: res.hash, receipt: res.receipt, refund };
}

/** `transferPoolOwnership(poolId, newOwner)`: step one of two. Nothing changes until the new owner accepts. */
export async function transferPoolOwnership(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  newOwner: Address,
  options?: ActionOptions,
): Promise<WriteResult> {
  const res = await write(
    config,
    'transferPoolOwnership',
    {
      functionName: 'transferPoolOwnership',
      args: [parsePoolId(poolId), parseAddressArg('newOwner', newOwner)],
    },
    options,
  );
  return res.ok ? { ok: true, hash: res.hash, receipt: res.receipt } : res;
}

/** `acceptPoolOwnership(poolId)`: step two, sent by the pending owner. */
export async function acceptPoolOwnership(
  config: DripPoolConfig,
  poolId: bigint | number | string,
  options?: ActionOptions,
): Promise<WriteResult> {
  const res = await write(
    config,
    'acceptPoolOwnership',
    { functionName: 'acceptPoolOwnership', args: [parsePoolId(poolId)] },
    options,
  );
  return res.ok ? { ok: true, hash: res.hash, receipt: res.receipt } : res;
}

/** The accounting half of a `PoolState`, for the pure functions in `math.ts`. */
export function toAccrualPool(pool: PoolState): AccrualPool {
  const { owner: _owner, pendingOwner: _pendingOwner, ...accrual } = pool;
  return accrual;
}
