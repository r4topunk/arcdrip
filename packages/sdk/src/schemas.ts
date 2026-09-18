// Zod schemas for the SDK's public data shapes. Every numeric field is bigint-safe: it accepts a bigint, a safe
// integer number or a decimal string (the JSON form used by vector files, log dumps and query strings) and always
// parses out a bigint, so nothing ever silently goes through a float.
import { type Address, getAddress, isAddress } from 'viem';
import { z } from 'zod';
import { MAX_RATE, MAX_SHARES, MAX_TOTAL_SHARES, MAX_UINT64, MAX_UINT256 } from './constants.js';
import { InvalidInputError } from './errors.js';

const DECIMAL_RE = /^[0-9]+$/;

/** Unsigned integer from a bigint, a safe-integer number or a decimal string, parsed as bigint. */
export function uintSchema(label: string, min: bigint, max: bigint, range = `[${min}, ${max}]`) {
  return z
    .union([z.bigint(), z.number(), z.string()], {
      error: `${label} must be a bigint, an integer number or a decimal string`,
    })
    .transform((value, ctx) => {
      let n: bigint | undefined;
      if (typeof value === 'bigint') n = value;
      else if (typeof value === 'number') n = Number.isSafeInteger(value) ? BigInt(value) : undefined;
      else n = DECIMAL_RE.test(value.trim()) ? BigInt(value.trim()) : undefined;
      if (n === undefined) {
        ctx.issues.push({
          code: 'custom',
          message: `${label} must be an integer, got ${String(value)}`,
          input: value,
        });
        return z.NEVER;
      }
      if (n < min || n > max) {
        ctx.issues.push({ code: 'custom', message: `${label} must be in ${range}, got ${n}`, input: value });
        return z.NEVER;
      }
      return n;
    });
}

/** EVM address, lowercase or EIP-55 checksummed (a bad checksum is a typo, not an address). Checksummed out. */
export const addressSchema = z
  .string({ error: 'address must be a 0x-prefixed hex string' })
  .check((ctx) => {
    if (!isAddress(ctx.value, { strict: false })) {
      ctx.issues.push({ code: 'custom', message: `not an EVM address: ${ctx.value}`, input: ctx.value });
    }
  })
  .transform((value) => getAddress(value) as Address);

/** Unix seconds, uint64 like the contract's `startTime` / `lastAccrual`. */
export const timestampSchema = uintSchema('timestamp', 0n, MAX_UINT64, '[0, 2^64 - 1]');
/** USDC units (1e-6 USDC), uint256. */
export const unitsSchema = uintSchema('units', 0n, MAX_UINT256, '[0, 2^256 - 1]');
/** wad amount (USDC units x 1e12), uint256. */
export const wadSchema = uintSchema('wad', 0n, MAX_UINT256, '[0, 2^256 - 1]');
/** Pool id: ids start at 1, id 0 never exists. */
export const poolIdSchema = uintSchema('poolId', 1n, MAX_UINT256, '[1, 2^256 - 1]');
/** `ratePerSecond` in wad/s, capped by `MAX_RATE`. */
export const rateSchema = uintSchema('ratePerSecond', 0n, MAX_RATE, `[0, ${MAX_RATE}]`);
/** Per-member shares, capped by `MAX_SHARES`. */
export const sharesSchema = uintSchema('shares', 0n, MAX_SHARES, `[0, ${MAX_SHARES}]`);
/** Pool-wide shares, capped by `MAX_TOTAL_SHARES`. */
export const totalSharesSchema = uintSchema('totalShares', 0n, MAX_TOTAL_SHARES, `[0, ${MAX_TOTAL_SHARES}]`);

/**
 * The accounting half of a pool: everything `math.ts` needs and nothing else. Ownership is irrelevant to accrual,
 * so vectors and simulations can be written without it.
 */
export const accrualPoolSchema = z.object({
  startTime: timestampSchema,
  lastAccrual: timestampSchema,
  cancelled: z.boolean().default(false),
  ratePerSecond: rateSchema,
  totalShares: totalSharesSchema,
  balance: unitsSchema,
  owed: wadSchema,
  accIndex: wadSchema,
});
export type AccrualPool = z.output<typeof accrualPoolSchema>;

/** A full pool as `getPool` returns it. */
export const poolStateSchema = accrualPoolSchema.extend({
  owner: addressSchema,
  pendingOwner: addressSchema,
});
export type PoolState = z.output<typeof poolStateSchema>;

/** The accounting half of a member. */
export const accrualMemberSchema = z.object({
  shares: sharesSchema,
  index: wadSchema,
  pending: wadSchema,
});
export type AccrualMember = z.output<typeof accrualMemberSchema>;

/** A full member as `getMember` returns it. `payout` is the zero address when the member never set one. */
export const memberStateSchema = accrualMemberSchema.extend({
  payout: addressSchema,
});
export type MemberState = z.output<typeof memberStateSchema>;

const eventBase = { poolId: poolIdSchema };

/** Every `DripPool` event (PRD 4.4), as a discriminated union on `type`. An indexer can replay these into state. */
export const poolEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...eventBase,
    type: z.literal('PoolCreated'),
    owner: addressSchema,
    ratePerSecond: rateSchema,
    startTime: timestampSchema,
    name: z.string(),
  }),
  z.object({ ...eventBase, type: z.literal('Deposited'), from: addressSchema, amount: unitsSchema }),
  z.object({ ...eventBase, type: z.literal('RateSet'), oldRate: rateSchema, newRate: rateSchema }),
  z.object({
    ...eventBase,
    type: z.literal('SharesSet'),
    member: addressSchema,
    oldShares: sharesSchema,
    newShares: sharesSchema,
    totalShares: totalSharesSchema,
  }),
  z.object({ ...eventBase, type: z.literal('PayoutAddressSet'), member: addressSchema, to: addressSchema }),
  z.object({
    ...eventBase,
    type: z.literal('Withdrawn'),
    member: addressSchema,
    to: addressSchema,
    amount: unitsSchema,
    caller: addressSchema,
  }),
  z.object({ ...eventBase, type: z.literal('WithdrawSkipped'), member: addressSchema, amount: unitsSchema }),
  z.object({ ...eventBase, type: z.literal('UnstreamedWithdrawn'), to: addressSchema, amount: unitsSchema }),
  z.object({ ...eventBase, type: z.literal('Cancelled'), to: addressSchema, refund: unitsSchema }),
  z.object({
    ...eventBase,
    type: z.literal('OwnershipTransferStarted'),
    owner: addressSchema,
    pendingOwner: addressSchema,
  }),
  z.object({
    ...eventBase,
    type: z.literal('OwnershipTransferred'),
    oldOwner: addressSchema,
    newOwner: addressSchema,
  }),
]);
export type PoolEvent = z.output<typeof poolEventSchema>;

/** Runs a schema and throws `InvalidInputError` (never a raw ZodError) with one readable line per problem. */
export function parseWith<T extends z.ZodType>(schema: T, what: string, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    });
    throw new InvalidInputError(what, issues, { cause: result.error });
  }
  return result.data;
}

export const parseAccrualPool = (input: unknown): AccrualPool => parseWith(accrualPoolSchema, 'pool', input);
export const parsePoolState = (input: unknown): PoolState => parseWith(poolStateSchema, 'pool', input);
export const parseAccrualMember = (input: unknown): AccrualMember =>
  parseWith(accrualMemberSchema, 'member', input);
export const parseMemberState = (input: unknown): MemberState =>
  parseWith(memberStateSchema, 'member', input);
export const parsePoolEvent = (input: unknown): PoolEvent => parseWith(poolEventSchema, 'event', input);
