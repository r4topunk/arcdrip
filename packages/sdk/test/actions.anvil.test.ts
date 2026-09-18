// End to end against a throwaway local anvil: the real compiled `DripPool` plus the FiatToken-like `MockUSDC`.
// Anvil's unlocked dev accounts sign through `eth_sendTransaction`, so no key material is handled anywhere.
// The whole suite is skipped when `anvil` is not installed.
//
// What these tests are really for: the SDK's offchain accrual mirror (`math.ts`) must agree with the contract to
// the unit, and every write must simulate first and hand back a decoded custom error instead of throwing.
import {
  type Address,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dripPoolAbi, dripPoolBytecode } from '../src/abi/DripPool.js';
import { mockUsdcAbi, mockUsdcBytecode } from '../src/abi/MockUSDC.js';
import {
  acceptPoolOwnership,
  approveAndDeposit,
  cancel,
  chunkMembers,
  claimableOnchain,
  createPool,
  type DripPoolConfig,
  deposit,
  fundedUntilOnchain,
  getAllowance,
  getMember,
  getNextPoolId,
  getPool,
  getPoolOrNull,
  getUsdcAddress,
  isOk,
  payEveryone,
  setPayoutAddress,
  setRate,
  setShares,
  setSharesBatch,
  toAccrualPool,
  transferPoolOwnership,
  unstreamedOnchain,
  withdraw,
  withdrawFor,
  withdrawForBatch,
  withdrawUnstreamed,
} from '../src/actions.js';
import { MAX_BATCH, WAD_PER_UNIT } from '../src/constants.js';
import { erc20Abi } from '../src/erc20.js';
import { WalletRequiredError } from '../src/errors.js';
import { createLogger } from '../src/logger.js';
import { claimable, fundedUntil, poolStatus, unstreamed } from '../src/math.js';
import { getPoolMembers, getSharesSetLogs } from '../src/members.js';
import { parseUsdc } from '../src/rate.js';
import { anvilAvailable, localChain, startAnvil } from './helpers/anvil.js';

/** 100 USDC units per second (0.0001 USDC/s), in wad. Small enough to keep every number readable. */
const RATE = 100n * WAD_PER_UNIT;

describe.skipIf(!anvilAvailable)('@arcdrip/sdk against a local anvil', () => {
  let stop: () => Promise<void>;
  let url: string;
  let publicClient: PublicClient;
  let accounts: Address[];
  let usdc: Address;
  let dripPool: Address;
  let owner: Address;
  let alice: Address;
  let bob: Address;
  let carol: Address;
  let ops: Address;

  const wallet = (account: Address): WalletClient =>
    createWalletClient({ account, chain: localChain, transport: http(url) });
  const config = (account?: Address): DripPoolConfig => ({
    publicClient,
    ...(account ? { walletClient: wallet(account) } : {}),
    address: dripPool,
  });
  const testClient = () => createTestClient({ chain: localChain, mode: 'anvil', transport: http(url) });
  const warp = async (seconds: number) => {
    await testClient().increaseTime({ seconds });
    await testClient().mine({ blocks: 1 });
  };
  const now = async () => (await publicClient.getBlock()).timestamp;
  const usdcBalance = (who: Address) =>
    publicClient.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [who] });
  const setBlocklist = async (who: Address, value: boolean) => {
    const hash = await wallet(owner).writeContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: 'blacklist',
      args: [who, value],
      chain: localChain,
      account: owner,
    });
    await publicClient.waitForTransactionReceipt({ hash });
  };

  /** A funded pool with the given shares, ready to stream. Returns its id. */
  const freshPool = async (shares: readonly [Address, bigint][], funding = parseUsdc('10')) => {
    const created = await createPool(config(owner), { owner, ratePerSecond: RATE, name: 'payroll' });
    if (!isOk(created)) throw new Error(`createPool failed: ${created.error.message}`);
    const id = created.poolId;
    await setSharesBatch(
      config(owner),
      id,
      shares.map(([member, value]) => ({ member, shares: value })),
    );
    const funded = await approveAndDeposit(config(owner), id, funding);
    if (!isOk(funded)) throw new Error(`deposit failed: ${funded.error.message}`);
    return id;
  };

  beforeAll(async () => {
    ({ url, stop } = await startAnvil());
    publicClient = createPublicClient({ chain: localChain, transport: http(url) }) as PublicClient;
    accounts = (await createWalletClient({
      chain: localChain,
      transport: http(url),
    }).getAddresses()) as Address[];
    [owner, alice, bob, carol, ops] = [accounts[0]!, accounts[1]!, accounts[2]!, accounts[3]!, accounts[4]!];

    const deployer = wallet(owner);
    const usdcHash = await deployer.deployContract({
      abi: mockUsdcAbi,
      bytecode: mockUsdcBytecode,
      chain: localChain,
      account: owner,
    });
    usdc = (await publicClient.waitForTransactionReceipt({ hash: usdcHash })).contractAddress!;
    const poolHash = await deployer.deployContract({
      abi: dripPoolAbi,
      bytecode: dripPoolBytecode,
      args: [usdc],
      chain: localChain,
      account: owner,
    });
    dripPool = (await publicClient.waitForTransactionReceipt({ hash: poolHash })).contractAddress!;
    const mint = await deployer.writeContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [owner, parseUsdc('1000000')],
      chain: localChain,
      account: owner,
    });
    await publicClient.waitForTransactionReceipt({ hash: mint });
  }, 60_000);

  afterAll(async () => {
    await stop?.();
  });

  describe('reads', () => {
    it('reports the USDC the singleton was deployed against', async () => {
      expect((await getUsdcAddress(config())).toLowerCase()).toBe(usdc.toLowerCase());
    });

    it('starts pool ids at 1', async () => {
      expect(await getNextPoolId(config())).toBeGreaterThanOrEqual(1n);
    });

    it('returns null for a pool id that was never created', async () => {
      expect(await getPoolOrNull(config(), 999_999n)).toBeNull();
    });

    it('rejects pool id 0 before touching the chain', async () => {
      await expect(getPool(config(), 0n)).rejects.toThrow(/poolId/);
    });
  });

  describe('createPool', () => {
    it('returns the new id from the PoolCreated event and stores the owner and rate', async () => {
      const expected = await getNextPoolId(config());
      const result = await createPool(config(owner), { owner, ratePerSecond: RATE, name: 'r4to collective' });
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.poolId).toBe(expected);
      const pool = await getPool(config(), result.poolId);
      expect(pool.owner.toLowerCase()).toBe(owner.toLowerCase());
      expect(pool.ratePerSecond).toBe(RATE);
      expect(pool.totalShares).toBe(0n);
      expect(pool.cancelled).toBe(false);
    });

    it('refuses a start time in the past as BadStartTime, without sending anything', async () => {
      const result = await createPool(config(owner), {
        owner,
        ratePerSecond: RATE,
        startTime: 1n,
        name: 'late',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.name).toBe('BadStartTime');
      expect(result.error.kind).toBe('bad-input');
    });

    it('refuses the zero address as owner', async () => {
      const result = await createPool(config(owner), {
        owner: '0x0000000000000000000000000000000000000000',
        ratePerSecond: RATE,
        name: 'nobody',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.name).toBe('ZeroAddress');
    });

    it('needs a wallet, and says so before any RPC call', async () => {
      await expect(
        createPool(config(), { owner, ratePerSecond: RATE, name: 'no wallet' }),
      ).rejects.toBeInstanceOf(WalletRequiredError);
    });
  });

  describe('funding', () => {
    it('approves then deposits, and skips the approval when the allowance already covers it', async () => {
      const id = await freshPool([[alice, 1n]], parseUsdc('5'));
      const first = await getPool(config(), id);
      expect(first.balance).toBe(parseUsdc('5'));

      const approve = await wallet(owner).writeContract({
        address: usdc,
        abi: erc20Abi,
        functionName: 'approve',
        args: [dripPool, parseUsdc('1000')],
        chain: localChain,
        account: owner,
      });
      await publicClient.waitForTransactionReceipt({ hash: approve });
      expect(await getAllowance(config(), owner, usdc)).toBe(parseUsdc('1000'));

      const second = await approveAndDeposit(config(owner), id, parseUsdc('1'));
      expect(isOk(second)).toBe(true);
      if (!isOk(second)) return;
      expect(second.approvalSkipped).toBe(true);
      expect(second.approveHash).toBeUndefined();
      expect((await getPool(config(), id)).balance).toBe(parseUsdc('6'));
    });

    it('refuses a zero deposit as ZeroAmount', async () => {
      const id = await freshPool([[alice, 1n]]);
      const result = await deposit(config(owner), id, 0n);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.name).toBe('ZeroAmount');
    });

    it('refuses a deposit into a pool that does not exist', async () => {
      const result = await deposit(config(owner), 999_999n, parseUsdc('1'));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.name).toBe('PoolNotFound');
    });
  });

  describe('shares', () => {
    it('sets shares and reports the new totalShares from the event', async () => {
      const id = await freshPool([[alice, 1n]]);
      const result = await setShares(config(owner), id, bob, 3n);
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.totalShares).toBe(4n);
      expect((await getMember(config(), id, bob)).shares).toBe(3n);
    });

    it('re-weights several members in one accrual', async () => {
      const id = await freshPool([
        [alice, 1n],
        [bob, 1n],
      ]);
      const result = await setSharesBatch(config(owner), id, [
        { member: alice, shares: 5n },
        { member: carol, shares: 2n },
      ]);
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.totalShares).toBe(8n);
    });

    it('rejects a no-op re-set with NoOp', async () => {
      const id = await freshPool([[alice, 1n]]);
      const result = await setShares(config(owner), id, alice, 1n);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.name).toBe('NoOp');
    });

    it('lets only the owner set shares', async () => {
      const id = await freshPool([[alice, 1n]]);
      const result = await setShares(config(bob), id, bob, 1n);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.name).toBe('NotOwner');
        expect(result.error.kind).toBe('not-authorized');
      }
    });

    it('validates the batch size offchain, before a wallet prompt', async () => {
      const id = await freshPool([[alice, 1n]]);
      const many = Array.from({ length: MAX_BATCH + 1 }, () => ({ member: alice, shares: 1n }));
      await expect(setSharesBatch(config(owner), id, many)).rejects.toThrow(/at most 100/);
      await expect(setSharesBatch(config(owner), id, [])).rejects.toThrow(/must not be empty/);
    });
  });

  describe('the offchain mirror agrees with the chain', () => {
    it('matches claimable() to the unit for every member', async () => {
      const id = await freshPool([
        [alice, 3n],
        [bob, 1n],
      ]);
      await warp(1_000);
      const pool = toAccrualPool(await getPool(config(), id));
      const timestamp = await now();
      for (const member of [alice, bob]) {
        const state = await getMember(config(), id, member);
        expect(claimable(pool, state, timestamp)).toBe(await claimableOnchain(config(), id, member));
      }
    });

    it('matches fundedUntil() and unstreamed()', async () => {
      const id = await freshPool([[alice, 1n]], parseUsdc('1'));
      await warp(500);
      const pool = toAccrualPool(await getPool(config(), id));
      const timestamp = await now();
      expect(fundedUntil(pool, timestamp)).toBe(await fundedUntilOnchain(config(), id));
      expect(unstreamed(pool, timestamp)).toBe(await unstreamedOnchain(config(), id));
    });

    it('agrees that a drained pool is frozen, and that a deposit resumes it without back-pay', async () => {
      // 1 USDC of funding at 100 units/s runs dry after 10,000 s.
      const id = await freshPool([[alice, 1n]], parseUsdc('1'));
      await warp(20_000);
      const frozen = toAccrualPool(await getPool(config(), id));
      expect(poolStatus(frozen, await now())).toBe('frozen');
      const atFreeze = await claimableOnchain(config(), id, alice);
      expect(atFreeze).toBe(parseUsdc('1'));

      await warp(10_000);
      expect(await claimableOnchain(config(), id, alice)).toBe(atFreeze);

      await approveAndDeposit(config(owner), id, parseUsdc('1'));
      expect(await claimableOnchain(config(), id, alice)).toBe(atFreeze);
      await warp(100);
      const resumed = await claimableOnchain(config(), id, alice);
      expect(resumed).toBeGreaterThan(atFreeze);
      expect(resumed - atFreeze).toBeLessThanOrEqual(101n * 100n);
    });

    it('agrees that a paused pool consumes nothing', async () => {
      const id = await freshPool([[alice, 1n]]);
      await setRate(config(owner), id, 0n);
      const paused = toAccrualPool(await getPool(config(), id));
      expect(poolStatus(paused, await now())).toBe('paused');
      const before = await claimableOnchain(config(), id, alice);
      await warp(5_000);
      expect(await claimableOnchain(config(), id, alice)).toBe(before);
      expect(await fundedUntilOnchain(config(), id)).toBe(2n ** 64n - 1n);
    });
  });

  describe('withdrawals', () => {
    it('pays the member and reports the amount from the Withdrawn event', async () => {
      const id = await freshPool([[alice, 1n]]);
      await warp(1_000);
      const before = await usdcBalance(alice);
      const result = await withdraw(config(alice), id);
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.amount).toBeGreaterThan(0n);
      expect(await usdcBalance(alice)).toBe(before + result.amount);
      expect((await getMember(config(), id, alice)).pending).toBeLessThan(WAD_PER_UNIT);
    });

    it('reverts NothingToWithdraw below one USDC unit, as a typed result', async () => {
      const id = await freshPool([[alice, 1n]]);
      const result = await withdraw(config(alice), id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.name).toBe('NothingToWithdraw');
        expect(result.error.kind).toBe('nothing-to-withdraw');
      }
    });

    it('sends withdrawFor proceeds to the member, never to the caller who paid the gas', async () => {
      const id = await freshPool([[alice, 1n]]);
      await warp(1_000);
      const aliceBefore = await usdcBalance(alice);
      const opsBefore = await usdcBalance(ops);
      const result = await withdrawFor(config(ops), id, alice);
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(await usdcBalance(alice)).toBe(aliceBefore + result.amount);
      expect(await usdcBalance(ops)).toBe(opsBefore);
    });

    it('honours a payout address set by the member', async () => {
      const id = await freshPool([[alice, 1n]]);
      const payout = carol;
      const set = await setPayoutAddress(config(alice), id, payout);
      expect(isOk(set)).toBe(true);
      await warp(1_000);
      const before = await usdcBalance(payout);
      const result = await withdrawFor(config(ops), id, alice);
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(await usdcBalance(payout)).toBe(before + result.amount);
    });

    it('refuses the contract itself as a payout address', async () => {
      const id = await freshPool([[alice, 1n]]);
      const result = await setPayoutAddress(config(alice), id, dripPool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.name).toBe('BadPayout');
    });
  });

  describe('withdrawForBatch: pay everyone', () => {
    it('pays several members in one transaction and reports each payout', async () => {
      const id = await freshPool([
        [alice, 1n],
        [bob, 1n],
        [carol, 2n],
      ]);
      await warp(1_000);
      const result = await withdrawForBatch(config(ops), id, [alice, bob, carol]);
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.paid).toHaveLength(3);
      expect(result.skipped).toHaveLength(0);
      expect(result.total).toBe(result.paid.reduce((sum, p) => sum + p.amount, 0n));
      const byMember = Object.fromEntries(result.paid.map((p) => [p.member.toLowerCase(), p.amount]));
      expect(byMember[carol.toLowerCase()]).toBe(byMember[alice.toLowerCase()]! * 2n);
    });

    it('skips a blocklisted member instead of reverting, and leaves their balance intact', async () => {
      const id = await freshPool([
        [alice, 1n],
        [bob, 1n],
      ]);
      await warp(1_000);
      await setBlocklist(bob, true);
      const owedToBob = await claimableOnchain(config(), id, bob);
      const result = await withdrawForBatch(config(ops), id, [alice, bob]);
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.paid.map((p) => p.member.toLowerCase())).toEqual([alice.toLowerCase()]);
      expect(result.skipped.map((p) => p.member.toLowerCase())).toEqual([bob.toLowerCase()]);
      expect(await claimableOnchain(config(), id, bob)).toBeGreaterThanOrEqual(owedToBob);

      await setBlocklist(bob, false);
      const retry = await withdrawFor(config(ops), id, bob);
      expect(isOk(retry)).toBe(true);
      if (isOk(retry)) expect(retry.amount).toBeGreaterThanOrEqual(owedToBob);
    });

    it('skips a member with nothing to withdraw without listing them anywhere', async () => {
      const id = await freshPool([
        [alice, 1n],
        [bob, 1n],
      ]);
      await warp(1_000);
      const result = await withdrawForBatch(config(ops), id, [alice, ops]);
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.paid.map((p) => p.member.toLowerCase())).toEqual([alice.toLowerCase()]);
      expect(result.skipped).toHaveLength(0);
    });

    it('chunks a long member list into one transaction per 100 addresses', () => {
      const many = Array.from({ length: 250 }, (_, i) => `0x${String(i).padStart(40, '0')}` as Address);
      const chunks = chunkMembers(many);
      expect(chunks.map((c) => c.length)).toEqual([100, 100, 50]);
      expect(chunkMembers([], 10)).toEqual([]);
      expect(() => chunkMembers(many, 0)).toThrow(RangeError);
    });

    it('sends one transaction per chunk through payEveryone', async () => {
      const id = await freshPool([
        [alice, 1n],
        [bob, 1n],
        [carol, 1n],
      ]);
      await warp(1_000);
      const result = await payEveryone(config(ops), id, [alice, bob, carol], { chunkSize: 2 });
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.hashes).toHaveLength(2);
      expect(result.paid).toHaveLength(3);
      expect(result.total).toBeGreaterThan(0n);
    });
  });

  describe('owner funds', () => {
    it('lets the owner take back only what is not yet streamed', async () => {
      const id = await freshPool([[alice, 1n]], parseUsdc('10'));
      await warp(1_000);
      const free = await unstreamedOnchain(config(), id);
      const tooMuch = await withdrawUnstreamed(config(owner), id, free + parseUsdc('1'), owner);
      expect(tooMuch.ok).toBe(false);
      if (!tooMuch.ok) expect(tooMuch.error.name).toBe('InsufficientUnstreamed');

      const before = await usdcBalance(owner);
      const ok = await withdrawUnstreamed(config(owner), id, parseUsdc('1'), owner);
      expect(isOk(ok)).toBe(true);
      expect(await usdcBalance(owner)).toBe(before + parseUsdc('1'));
    });

    it('cancels, refunds the unstreamed part, and still lets members withdraw afterwards', async () => {
      const id = await freshPool([[alice, 1n]], parseUsdc('10'));
      await warp(1_000);
      const owedToAlice = await claimableOnchain(config(), id, alice);
      const result = await cancel(config(owner), id, owner);
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) return;
      expect(result.refund).toBeGreaterThan(0n);

      const pool = await getPool(config(), id);
      expect(pool.cancelled).toBe(true);
      expect(pool.ratePerSecond).toBe(0n);
      expect(poolStatus(toAccrualPool(pool), await now())).toBe('cancelled');

      const paid = await withdraw(config(alice), id);
      expect(isOk(paid)).toBe(true);
      if (isOk(paid)) expect(paid.amount).toBeGreaterThanOrEqual(owedToAlice);
    });

    it('refuses further deposits into a cancelled pool', async () => {
      const id = await freshPool([[alice, 1n]]);
      await cancel(config(owner), id, owner);
      const result = await deposit(config(owner), id, parseUsdc('1'));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.name).toBe('PoolCancelled');
        expect(result.error.kind).toBe('cancelled');
      }
    });
  });

  describe('ownership', () => {
    it('transfers in two steps', async () => {
      const id = await freshPool([[alice, 1n]]);
      const started = await transferPoolOwnership(config(owner), id, bob);
      expect(isOk(started)).toBe(true);
      expect((await getPool(config(), id)).owner.toLowerCase()).toBe(owner.toLowerCase());
      expect((await getPool(config(), id)).pendingOwner.toLowerCase()).toBe(bob.toLowerCase());

      const wrong = await acceptPoolOwnership(config(carol), id);
      expect(wrong.ok).toBe(false);
      if (!wrong.ok) expect(wrong.error.name).toBe('NotPendingOwner');

      const accepted = await acceptPoolOwnership(config(bob), id);
      expect(isOk(accepted)).toBe(true);
      const after = await getPool(config(), id);
      expect(after.owner.toLowerCase()).toBe(bob.toLowerCase());
      expect(after.pendingOwner).toBe('0x0000000000000000000000000000000000000000');
    });
  });

  describe('member discovery', () => {
    it('finds current members and keeps a removed member who still holds funds', async () => {
      const id = await freshPool([
        [alice, 2n],
        [bob, 1n],
      ]);
      await warp(1_000);
      await setShares(config(owner), id, bob, 0n); // bob leaves, keeping what he earned

      const members = await getPoolMembers(publicClient, { address: dripPool, poolId: id });
      const byAddress = Object.fromEntries(members.map((m) => [m.address.toLowerCase(), m]));
      expect(members).toHaveLength(2);
      expect(byAddress[alice.toLowerCase()]!.shares).toBe(2n);
      expect(byAddress[alice.toLowerCase()]!.formerMember).toBe(false);
      expect(byAddress[bob.toLowerCase()]!.shares).toBe(0n);
      expect(byAddress[bob.toLowerCase()]!.formerMember).toBe(true);
      expect(byAddress[bob.toLowerCase()]!.pending).toBeGreaterThan(0n);
    });

    it('drops a removed member once they have withdrawn everything', async () => {
      const id = await freshPool([
        [alice, 1n],
        [bob, 1n],
      ]);
      await warp(1_000);
      await setShares(config(owner), id, bob, 0n);
      await withdrawFor(config(ops), id, bob);
      const members = await getPoolMembers(publicClient, { address: dripPool, poolId: id });
      const addresses = members.map((m) => m.address.toLowerCase());
      expect(addresses).toContain(alice.toLowerCase());
      // bob keeps only sub-unit dust, so he is settled for every practical purpose
      const bobRow = members.find((m) => m.address.toLowerCase() === bob.toLowerCase());
      expect(bobRow === undefined || bobRow.pending < WAD_PER_UNIT).toBe(true);
    });

    it('keeps a settled member when asked to', async () => {
      const id = await freshPool([[alice, 1n]]);
      await setShares(config(owner), id, bob, 1n);
      await setShares(config(owner), id, bob, 0n);
      const kept = await getPoolMembers(publicClient, {
        address: dripPool,
        poolId: id,
        includeSettled: true,
      });
      expect(kept.map((m) => m.address.toLowerCase())).toContain(bob.toLowerCase());
    });

    it('reads the same logs through many small windows as through one big one', async () => {
      const id = await freshPool([
        [alice, 1n],
        [bob, 1n],
        [carol, 1n],
      ]);
      await setShares(config(owner), id, ops, 1n);
      const wide = await getSharesSetLogs(publicClient, { address: dripPool, poolId: id });
      const narrow = await getSharesSetLogs(publicClient, {
        address: dripPool,
        poolId: id,
        chunkSize: 1n,
      });
      expect(narrow).toEqual(wide);
      expect(wide.length).toBeGreaterThanOrEqual(4);
      expect(wide.every((log) => log.poolId === id)).toBe(true);
    });

    it('reports progress per window and never returns another pool logs', async () => {
      const first = await freshPool([[alice, 1n]]);
      const second = await freshPool([[bob, 1n]]);
      const windows: number[] = [];
      const logs = await getSharesSetLogs(publicClient, {
        address: dripPool,
        poolId: second,
        chunkSize: 2n,
        onWindow: (_window, count) => windows.push(count),
      });
      expect(windows.length).toBeGreaterThan(0);
      expect(logs.every((log) => log.poolId === second)).toBe(true);
      expect(logs.every((log) => log.member.toLowerCase() === bob.toLowerCase())).toBe(true);
      expect(first).not.toBe(second);
    });
  });

  describe('logging', () => {
    it('binds the caller correlationId to every line of an action', async () => {
      const lines: Record<string, unknown>[] = [];
      const logger = createLogger({
        level: 'info',
        destination: {
          write(chunk: string) {
            lines.push(JSON.parse(chunk));
          },
        },
      });
      const id = await freshPool([[alice, 1n]]);
      await warp(1_000);
      const result = await withdraw({ ...config(alice), logger }, id, { correlationId: 'payroll-run-42' });
      expect(isOk(result)).toBe(true);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.every((line) => line.correlationId === 'payroll-run-42')).toBe(true);
      expect(lines.every((line) => line.action === 'withdraw')).toBe(true);
    });

    it('logs a refused simulation as a warning and sends nothing', async () => {
      const lines: Record<string, unknown>[] = [];
      const logger = createLogger({
        level: 'info',
        destination: {
          write(chunk: string) {
            lines.push(JSON.parse(chunk));
          },
        },
      });
      const id = await freshPool([[alice, 1n]]);
      const result = await setShares({ ...config(bob), logger }, id, bob, 1n);
      expect(result.ok).toBe(false);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.level).toBe(40);
      expect(lines[0]!.msg).toContain('nothing sent');
    });
  });
});
