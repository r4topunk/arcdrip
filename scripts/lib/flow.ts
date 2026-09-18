// The PRD 8.4 end-to-end sequence, written once and run on two chains: Arc testnet (three Foundry keystores,
// real waits) and a local anvil (unlocked dev accounts, time jumps). Every step is keyed in the run state, so a
// re-run skips what already landed; nothing is ever sent twice.
//
//   createPool -> shares 1/1/2 -> deposit -> stream -> withdraw (member) -> withdrawFor (anyone)
//   -> setShares (4th member joins mid-stream) -> freeze -> deposit (resume, no back-pay)
//   -> withdrawForBatch ("pay everyone") -> withdrawUnstreamed -> cancel
import {
  accrue,
  approveAndDeposit,
  cancel as cancelPool,
  claimableOnchain,
  createPool,
  type DripPoolConfig,
  dripPoolAbi,
  erc20Abi,
  fromRatePerSecond,
  fundedUntilOnchain,
  getPool,
  type Logger,
  MAX_UINT64,
  parsePoolState,
  setShares,
  setSharesBatch,
  unstreamedOnchain,
  WAD_PER_UNIT,
  type WriteResult,
  withdraw,
  withdrawFor,
  withdrawForBatch,
  withdrawUnstreamed,
} from '@sharedarc/sdk';
import type { Address, Hash, PublicClient, TransactionReceipt, WalletClient } from 'viem';
import type { Clock } from './clock.js';
import { txUrl } from './config.js';
import { feeInUsdcBaseUnits, formatDuration, formatTime, formatUsdc } from './format.js';
import type { RunState, StateStore, TxRecord } from './state.js';

/** The three signing wallets. Wallet 1 owns the pool and pays for the owner actions. */
export type WalletIndex = 1 | 2 | 3;
export type Wallet = WalletClient;

export interface FlowContext {
  chainId: number;
  client: PublicClient;
  explorer: string;
  /** The DripPool singleton. */
  pool: Address;
  usdc: Address;
  /** Loads (and memoizes) the wallet client for a keystore or unlocked account. */
  signer: (index: WalletIndex) => Promise<Wallet>;
  /** Fourth member, added mid-stream; it never signs anything (that is the point of `withdrawFor`). */
  member4: Address;
  clock: Clock;
  store: StateStore;
  logger: Logger;
  say: (line: string) => void;
  /** USDC units of each of the two deposits. */
  deposit: bigint;
  /** Seconds the first deposit is meant to last; the rate is derived from it. */
  runwaySeconds: number;
  /** Seconds streamed before the withdrawals. */
  streamSeconds: number;
  /** Called after every confirmed transaction, so proof hashes survive a crash. */
  onTx?: (state: Readonly<RunState>) => void;
}

export type FlowResult =
  | { status: 'done'; poolId: bigint; streamedWad: bigint; outstanding: bigint; held: bigint }
  | { status: 'paused'; poolId: bigint | null; what: string; resumeAt: number; waitSeconds: number }
  | { status: 'failed'; reason: string };

/** A step the contract refused, or a check the chain did not satisfy. Carries no key material. */
export class FlowError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(`${step}: ${message}`);
    this.name = 'FlowError';
  }
}

const config = (ctx: FlowContext, wallet?: Wallet): DripPoolConfig => ({
  publicClient: ctx.client,
  ...(wallet ? { walletClient: wallet } : {}),
  address: ctx.pool,
  logger: ctx.logger,
  correlationId: ctx.store.get().runTag,
});

const addressOf = (wallet: Wallet): Address => {
  const account = wallet.account;
  if (!account) throw new Error('wallet client has no account');
  return account.address;
};

/** `getPool` as of a past block, so a check can look at the exact state a transaction left behind. */
async function poolAt(ctx: FlowContext, poolId: bigint, blockNumber: bigint) {
  const raw = await ctx.client.readContract({
    address: ctx.pool,
    abi: dripPoolAbi,
    functionName: 'getPool',
    args: [poolId],
    blockNumber,
  });
  return parsePoolState(raw);
}

/** USDC balance of `owner`, in units. Takes only what it needs, so callers can use it before a flow exists. */
export async function usdcBalance(
  ctx: { client: PublicClient; usdc: Address },
  owner: Address,
): Promise<bigint> {
  return ctx.client.readContract({
    address: ctx.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  }) as Promise<bigint>;
}

function recordFrom(label: string, hash: Hash, receipt: TransactionReceipt | undefined): TxRecord {
  const base: TxRecord = { label, hash, status: receipt ? 'success' : 'pending' };
  if (!receipt) return base;
  return {
    ...base,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    costUsdc: feeInUsdcBaseUnits(receipt.gasUsed, receipt.effectiveGasPrice ?? 0n).toString(),
  };
}

/**
 * Runs one transaction step, unless the state already holds a confirmed transaction for `key`. Refusals from the
 * contract (decoded custom errors) become a `FlowError`; the hash is printed either way.
 */
async function step<T>(
  ctx: FlowContext,
  key: string,
  label: string,
  run: () => Promise<WriteResult<T>>,
): Promise<(T & { hash: Hash; receipt: TransactionReceipt | undefined }) | null> {
  const done = ctx.store.get().txs[key];
  if (done?.status === 'success') {
    ctx.say(`  ${label}: already done (${done.hash})`);
    return null;
  }
  const result = await run();
  if (!result.ok) throw new FlowError(key, result.error.message);
  const { hash, receipt, ...extra } = result;
  ctx.store.update((draft) => {
    draft.txs[key] = recordFrom(label, hash, receipt);
  });
  ctx.onTx?.(ctx.store.get());
  const link = txUrl(ctx.explorer, hash);
  ctx.say(`  ${label}: ${hash}${link ? `  ${link}` : ''}`);
  return { ...(extra as T), hash, receipt };
}

/**
 * `fundedUntil` as a number, or null when the pool can never run dry (rate or totalShares is 0, or it is
 * cancelled). The contract returns `type(uint64).max` in that case, which is not a timestamp to wait for.
 */
async function freezeTime(ctx: FlowContext, poolId: bigint): Promise<number | null> {
  const value = await fundedUntilOnchain(config(ctx), poolId);
  return value >= MAX_UINT64 ? null : Number(value);
}

/** Records a transaction the flow did not send through `step` (the approve inside `approveAndDeposit`). */
async function recordExtraTx(ctx: FlowContext, key: string, label: string, hash: Hash): Promise<void> {
  let receipt: TransactionReceipt | undefined;
  try {
    receipt = await ctx.client.getTransactionReceipt({ hash });
  } catch {
    // The receipt is only needed for the gas figures; the hash is the proof.
  }
  ctx.store.update((draft) => {
    draft.txs[key] = recordFrom(label, hash, receipt);
  });
  ctx.onTx?.(ctx.store.get());
  const link = txUrl(ctx.explorer, hash);
  ctx.say(`  ${label}: ${hash}${link ? `  ${link}` : ''}`);
}

/** Waits for a chain timestamp, or asks the caller to pause the run. */
async function waitFor(ctx: FlowContext, at: number, what: string): Promise<FlowResult | null> {
  const wait = await ctx.clock.waitUntil(at, what);
  if (wait.ready) return null;
  const now = await ctx.clock.chainNow();
  const poolId = ctx.store.get().poolId;
  return {
    status: 'paused',
    poolId: poolId ? BigInt(poolId) : null,
    what,
    resumeAt: wait.resumeAt,
    waitSeconds: Math.max(0, wait.resumeAt - now),
  };
}

/** Recovers the pool id of an interrupted run from its `PoolCreated` event (the name carries the run tag). */
async function recoverPoolId(ctx: FlowContext, name: string, fromBlock: bigint): Promise<bigint | null> {
  const logs = await ctx.client.getLogs({
    address: ctx.pool,
    event: {
      type: 'event',
      name: 'PoolCreated',
      inputs: [
        { name: 'poolId', type: 'uint256', indexed: true },
        { name: 'owner', type: 'address', indexed: true },
        { name: 'ratePerSecond', type: 'uint256', indexed: false },
        { name: 'startTime', type: 'uint64', indexed: false },
        { name: 'name', type: 'string', indexed: false },
      ],
    },
    fromBlock,
    toBlock: 'latest',
  });
  for (const log of logs) {
    const args = log.args as { poolId?: bigint; name?: string };
    if (args.name === name && args.poolId !== undefined) return args.poolId;
  }
  return null;
}

/** Runs the whole PRD 8.4 sequence. Returns `paused` when a wait is longer than the clock allows. */
export async function runFlow(ctx: FlowContext): Promise<FlowResult> {
  const { say } = ctx;
  const w1 = await ctx.signer(1);
  const owner = addressOf(w1);
  const runTag = ctx.store.get().runTag;
  const name = `SharedArc e2e ${runTag}`;
  // deposit * 1e12 wad spread over the target runway, so the freeze happens on schedule. Withdrawals do not
  // move it: they take the same amount out of `balance` and out of `owed`.
  const ratePerSecond = (ctx.deposit * WAD_PER_UNIT) / BigInt(ctx.runwaySeconds);
  if (ratePerSecond === 0n) throw new FlowError('rate', 'deposit is too small for the requested runway');

  // ------------------------------------------------------------------ 1. create the pool
  say('1. createPool (owner = wallet 1)');
  let poolId = ctx.store.get().poolId ? BigInt(ctx.store.get().poolId as string) : null;
  if (poolId === null && ctx.store.get().createFromBlock) {
    poolId = await recoverPoolId(ctx, name, BigInt(ctx.store.get().createFromBlock as string));
    if (poolId !== null) say(`  recovered pool ${poolId} from the PoolCreated log of an earlier run`);
  }
  if (poolId === null) {
    const block = await ctx.client.getBlockNumber();
    ctx.store.update((draft) => {
      draft.createFromBlock = block.toString();
      draft.ratePerSecond = ratePerSecond.toString();
      draft.deposit = ctx.deposit.toString();
      draft.wallets['1'] = owner;
    });
    const created = await step(ctx, 'createPool', 'createPool', () =>
      createPool(config(ctx, w1), { owner, ratePerSecond, startTime: 0n, name }),
    );
    if (!created) throw new FlowError('createPool', 'no pool id and no recorded transaction');
    poolId = created.poolId;
  }
  ctx.store.update((draft) => {
    draft.poolId = (poolId as bigint).toString();
    draft.ratePerSecond = ratePerSecond.toString();
    draft.deposit = ctx.deposit.toString();
  });
  say(
    `  pool ${poolId}, rate ${fromRatePerSecond(ratePerSecond, 'day')} USDC/day ` +
      `(${formatUsdc(ctx.deposit)} lasts ${formatDuration(ctx.runwaySeconds)})`,
  );

  // ------------------------------------------------------------------ 2. members 1 / 1 / 2
  const w2 = await ctx.signer(2);
  const w3 = await ctx.signer(3);
  const members: Address[] = [owner, addressOf(w2), addressOf(w3), ctx.member4];
  ctx.store.update((draft) => {
    draft.wallets['1'] = members[0] as Address;
    draft.wallets['2'] = members[1] as Address;
    draft.wallets['3'] = members[2] as Address;
    draft.member4 = ctx.member4;
  });
  say('2. setSharesBatch: wallet 1 = 1, wallet 2 = 1, wallet 3 = 2');
  await step(ctx, 'setSharesBatch', 'setSharesBatch(1,1,2)', () =>
    setSharesBatch(config(ctx, w1), poolId as bigint, [
      { member: members[0] as Address, shares: 1n },
      { member: members[1] as Address, shares: 1n },
      { member: members[2] as Address, shares: 2n },
    ]),
  );

  // ------------------------------------------------------------------ 3. fund it
  say(`3. deposit ${formatUsdc(ctx.deposit)} (approve + deposit)`);
  const funded = await step(ctx, 'deposit', 'deposit', async () => {
    const res = await approveAndDeposit(config(ctx, w1), poolId as bigint, ctx.deposit, { token: ctx.usdc });
    if (res.ok && res.approveHash) await recordExtraTx(ctx, 'approve', 'approve', res.approveHash);
    return res;
  });
  const freezeAt = await freezeTime(ctx, poolId as bigint);
  if (freezeAt !== null) {
    ctx.store.update((draft) => {
      draft.freezeAt = (freezeAt as number).toString();
    });
    if (funded) {
      say(
        `  funded until ${formatTime(freezeAt)} (freeze in ${formatDuration(freezeAt - (await ctx.clock.chainNow()))})`,
      );
    }
  } else {
    say('  nothing is streaming yet (rate or shares are 0), so the pool cannot run dry');
  }

  // ------------------------------------------------------------------ 4. stream, then withdraw two ways
  const chainNow = await ctx.clock.chainNow();
  const streamUntil =
    freezeAt === null ? chainNow + ctx.streamSeconds : Math.min(chainNow + ctx.streamSeconds, freezeAt - 1);
  const pause1 = await waitFor(ctx, streamUntil, 'the stream to build up balances');
  if (pause1) return pause1;

  say('4. withdraw: wallet 3 pulls its own balance');
  const own = await step(ctx, 'withdrawByMember', 'withdraw (wallet 3)', () =>
    withdraw(config(ctx, w3), poolId as bigint),
  );
  if (own) say(`  wallet 3 received ${formatUsdc(own.amount)}`);

  say('5. withdrawFor: wallet 1 pushes wallet 2 its balance (funds go to wallet 2, never to the caller)');
  const pushed = await step(ctx, 'withdrawFor', 'withdrawFor (wallet 2)', () =>
    withdrawFor(config(ctx, w1), poolId as bigint, members[1] as Address),
  );
  if (pushed) say(`  wallet 2 received ${formatUsdc(pushed.amount)}`);

  // ------------------------------------------------------------------ 5. a fourth member joins mid-stream
  say(`6. setShares: ${ctx.member4} joins mid-stream with 1 share`);
  await step(ctx, 'setSharesJoin', 'setShares (member 4 joins)', () =>
    setShares(config(ctx, w1), poolId as bigint, ctx.member4, 1n),
  );

  // ------------------------------------------------------------------ 6. let it freeze
  say('7. letting the pool run dry (the stream freezes by itself)');
  const frozenAt = await freezeTime(ctx, poolId as bigint);
  if (frozenAt === null) {
    // A resumed run over a pool that is already paused or cancelled: there is no freeze left to wait for.
    say('  the pool is not streaming any more (rate or shares are 0); nothing to wait for');
  } else {
    const pause2 = await waitFor(ctx, frozenAt + 1, 'the pool to run dry');
    if (pause2) return pause2;
    const beforeIdle = await getPool(config(ctx), poolId as bigint);
    const claimableFrozen = await claimableOnchain(config(ctx), poolId as bigint, members[0] as Address);
    // Give the frozen pool more time and check that nothing moved: this is the freeze, not a slow accrual.
    const idlePause = await waitFor(
      ctx,
      frozenAt + 1 + Math.min(ctx.streamSeconds, 30),
      'the frozen pool to idle',
    );
    if (idlePause) return idlePause;
    const claimableStill = await claimableOnchain(config(ctx), poolId as bigint, members[0] as Address);
    if (claimableStill !== claimableFrozen) {
      throw new FlowError('freeze', `claimable moved while frozen: ${claimableFrozen} -> ${claimableStill}`);
    }
    say(
      `  frozen: claimable of wallet 1 stays at ${formatUsdc(claimableFrozen)} (owed ${beforeIdle.owed} wad)`,
    );
  }

  // ------------------------------------------------------------------ 7. resume with a second deposit
  say(
    `8. deposit ${formatUsdc(ctx.deposit)} again: the stream resumes from this timestamp, with no back-pay`,
  );
  const poolBeforeResume = await getPool(config(ctx), poolId as bigint);
  const resumed = await step(ctx, 'depositAfterFreeze', 'deposit (resume)', async () => {
    const res = await approveAndDeposit(config(ctx, w1), poolId as bigint, ctx.deposit, { token: ctx.usdc });
    if (res.ok && res.approveHash) {
      await recordExtraTx(ctx, 'approveAfterFreeze', 'approve (resume)', res.approveHash);
    }
    return res;
  });
  if (resumed?.receipt) {
    // The deposit accrues before it adds to the balance, so it settles the frozen pool's *capped* accrual and
    // nothing more: `owed` right after the deposit must equal what the offchain mirror computes from the state
    // just before it. Anything larger would be the frozen seconds being paid for after the fact (PRD 4.2).
    const block = await ctx.client.getBlock({ blockNumber: resumed.receipt.blockNumber });
    const expected = accrue(poolBeforeResume, block.timestamp).owed;
    const owedAfter = (await poolAt(ctx, poolId as bigint, resumed.receipt.blockNumber)).owed;
    if (owedAfter !== expected) {
      throw new FlowError(
        'resume',
        `the deposit back-paid frozen time: owed ${owedAfter} wad, capped accrual says ${expected} wad`,
      );
    }
    say(`  no back-pay: the frozen pool streamed only the ${expected} wad it had funds for`);
  }

  // ------------------------------------------------------------------ 8. pay everyone
  const payAt = (await ctx.clock.chainNow()) + ctx.streamSeconds;
  const pause3 = await waitFor(ctx, payAt, 'the resumed stream to build up balances');
  if (pause3) return pause3;

  say('9. withdrawForBatch from wallet 3: one transaction pays all four members');
  const batch = await step(ctx, 'withdrawForBatch', 'withdrawForBatch (4 members)', () =>
    withdrawForBatch(config(ctx, w3), poolId as bigint, members),
  );
  if (batch) {
    say(`  paid ${formatUsdc(batch.total)} to ${batch.paid.length} member(s)`);
    for (const skipped of batch.skipped) say(`  skipped ${skipped.member} (${formatUsdc(skipped.amount)})`);
  }

  // ------------------------------------------------------------------ 9. owner sweeps and cancels
  const sweepable = await unstreamedOnchain(config(ctx), poolId as bigint);
  const sweep = sweepable / 2n;
  say(
    `10. withdrawUnstreamed: ${formatUsdc(sweepable)} is not streamed yet; the owner takes ${formatUsdc(sweep)}`,
  );
  if (sweep > 0n) {
    await step(ctx, 'withdrawUnstreamed', 'withdrawUnstreamed', () =>
      withdrawUnstreamed(config(ctx, w1), poolId as bigint, sweep, owner),
    );
  } else {
    say('  nothing unstreamed to sweep; skipped');
  }

  say('11. cancel: the stream stops for good and only the unstreamed remainder is refunded');
  const cancelled = await step(ctx, 'cancel', 'cancel', () =>
    cancelPool(config(ctx, w1), poolId as bigint, owner),
  );
  if (cancelled) say(`  refunded ${formatUsdc(cancelled.refund)} to the owner`);

  // ------------------------------------------------------------------ 10. accounting
  const finalPool = await getPool(config(ctx), poolId as bigint);
  let outstanding = 0n;
  for (const member of members) {
    const left = await claimableOnchain(config(ctx), poolId as bigint, member);
    outstanding += left;
    if (left > 0n) say(`  ${member} can still withdraw ${formatUsdc(left)} after the cancel`);
  }
  const streamedWad = finalPool.owed;
  const held = await usdcBalance(ctx, ctx.pool);
  // I2 in the small: the contract can never owe more than it holds for this pool.
  if (finalPool.owed > finalPool.balance * WAD_PER_UNIT) {
    throw new FlowError(
      'accounting',
      `owed ${finalPool.owed} wad exceeds balance ${finalPool.balance} units`,
    );
  }
  say(
    `  pool ${poolId} after cancel: owed ${streamedWad} wad still withdrawable ` +
      `(${formatUsdc(outstanding)} across members), contract holds ${formatUsdc(held)}`,
  );
  ctx.store.update((draft) => {
    draft.completedAt = new Date().toISOString();
  });
  ctx.onTx?.(ctx.store.get());
  return { status: 'done', poolId: poolId as bigint, streamedWad, outstanding, held };
}
