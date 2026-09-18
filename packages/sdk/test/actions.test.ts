// The parts of `actions.ts` that need no chain: argument validation, chunking, result narrowing and the gas
// buffer. Everything that talks to a node is in `actions.anvil.test.ts`.
import { type Address, createPublicClient, http, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  chunkMembers,
  createPool,
  DEFAULT_GAS_BUFFER_PERCENT,
  deposit,
  getPool,
  isOk,
  toAccrualPool,
  type WriteResult,
} from '../src/actions.js';
import { ARC_MAINNET_CHAIN_ID, MAX_BATCH } from '../src/constants.js';
import { PoolAddressUnknownError, WalletRequiredError } from '../src/errors.js';
import type { PoolState } from '../src/schemas.js';

const ALICE = '0x1111111111111111111111111111111111111111' as Address;

/** A client that must never be called: every assertion below fails before any RPC round trip. */
const offline = (chainId?: number): PublicClient =>
  createPublicClient({
    ...(chainId
      ? {
          chain: {
            id: chainId,
            name: 'Arc',
            nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
            rpcUrls: { default: { http: ['http://127.0.0.1:1'] } },
          },
        }
      : {}),
    transport: http('http://127.0.0.1:1'),
  }) as PublicClient;

describe('chunkMembers', () => {
  it('defaults to the contract batch limit', () => {
    expect(MAX_BATCH).toBe(100);
    expect(chunkMembers(Array.from({ length: 100 }, () => ALICE))).toHaveLength(1);
    expect(chunkMembers(Array.from({ length: 101 }, () => ALICE))).toHaveLength(2);
  });

  it('keeps order and loses nothing', () => {
    const items = [1, 2, 3, 4, 5];
    expect(chunkMembers(items, 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkMembers(items, 2).flat()).toEqual(items);
  });

  it('rejects a size that is not a positive integer', () => {
    expect(() => chunkMembers([1], 0)).toThrow(RangeError);
    expect(() => chunkMembers([1], -1)).toThrow(RangeError);
    expect(() => chunkMembers([1], 1.5)).toThrow(RangeError);
  });
});

describe('isOk', () => {
  it('narrows a success and a failure', () => {
    const good = { ok: true, hash: '0x1', receipt: undefined, amount: 5n } as WriteResult<{
      amount: bigint;
    }>;
    const bad = {
      ok: false,
      error: { name: 'NotOwner', kind: 'not-authorized', message: 'nope' },
    } as WriteResult<{ amount: bigint }>;
    expect(isOk(good)).toBe(true);
    expect(isOk(bad)).toBe(false);
    if (isOk(good)) expect(good.amount).toBe(5n);
    if (!isOk(bad)) expect(bad.error.name).toBe('NotOwner');
  });
});

describe('the gas buffer', () => {
  it('sends more than the estimate, because an accrual can add fresh SSTOREs a second later', () => {
    expect(DEFAULT_GAS_BUFFER_PERCENT).toBeGreaterThan(100);
    expect(DEFAULT_GAS_BUFFER_PERCENT).toBeLessThanOrEqual(200);
  });
});

describe('guard rails before any RPC call', () => {
  it('needs a wallet for a write', async () => {
    await expect(
      createPool({ publicClient: offline(), address: ALICE }, { owner: ALICE, ratePerSecond: 1n, name: 'x' }),
    ).rejects.toBeInstanceOf(WalletRequiredError);
  });

  it('needs an address on a chain with no recorded deployment', async () => {
    await expect(getPool({ publicClient: offline(31337) }, 1n)).rejects.toBeInstanceOf(
      PoolAddressUnknownError,
    );
  });

  it('refuses pool id 0, since ids start at 1', async () => {
    await expect(getPool({ publicClient: offline(), address: ALICE }, 0n)).rejects.toThrow(/poolId/);
  });

  it('refuses a malformed address', async () => {
    await expect(
      createPool(
        { publicClient: offline(), address: ALICE, walletClient: undefined },
        { owner: 'not-an-address' as Address, ratePerSecond: 1n, name: 'x' },
      ),
    ).rejects.toThrow(/address/);
  });

  it('refuses a negative amount before simulating anything', async () => {
    await expect(
      deposit({ publicClient: offline(), address: ALICE }, 1n, -1n as unknown as bigint),
    ).rejects.toThrow(/amount/);
  });

  it('still has no DripPool address recorded for Arc mainnet (filled at deployment)', async () => {
    await expect(getPool({ publicClient: offline(ARC_MAINNET_CHAIN_ID) }, 1n)).rejects.toBeInstanceOf(
      PoolAddressUnknownError,
    );
  });
});

describe('toAccrualPool', () => {
  it('drops ownership, which accrual never looks at', () => {
    const pool: PoolState = {
      owner: ALICE,
      pendingOwner: '0x0000000000000000000000000000000000000000',
      startTime: 0n,
      lastAccrual: 10n,
      cancelled: false,
      ratePerSecond: 1n,
      totalShares: 1n,
      balance: 1n,
      owed: 0n,
      accIndex: 0n,
    };
    const accrual = toAccrualPool(pool);
    expect(accrual).not.toHaveProperty('owner');
    expect(accrual).not.toHaveProperty('pendingOwner');
    expect(accrual.lastAccrual).toBe(10n);
  });
});
