import { BaseError, ContractFunctionRevertedError, encodeErrorResult, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { dripPoolAbi } from '../src/abi/DripPool.js';
import {
  ContractRevertError,
  DRIP_ERROR_NAMES,
  decodeRevert,
  decodeRevertData,
  EventNotFoundError,
  explainRevert,
  InvalidInputError,
  isDripErrorName,
  PoolAddressUnknownError,
  TransactionRevertedError,
  WalletRequiredError,
} from '../src/errors.js';

const encode = (errorName: string, args?: readonly unknown[]) =>
  encodeErrorResult({
    abi: dripPoolAbi,
    errorName: errorName as never,
    ...(args ? { args: args as never } : {}),
  });

describe('error names', () => {
  it('lists every custom error the contract declares', () => {
    const fromAbi = dripPoolAbi.filter((item) => item.type === 'error').map((item) => item.name);
    expect([...DRIP_ERROR_NAMES].sort()).toEqual([...fromAbi].sort());
  });

  it('recognises its own names and nothing else', () => {
    expect(isDripErrorName('NothingToWithdraw')).toBe(true);
    expect(isDripErrorName('NotAnError')).toBe(false);
    expect(isDripErrorName(undefined)).toBe(false);
  });

  it('explains every name in one human line', () => {
    for (const name of DRIP_ERROR_NAMES) {
      const text = explainRevert(name, undefined);
      expect(text.length).toBeGreaterThan(3);
      expect(text).not.toBe(name);
    }
  });
});

describe('decodeRevertData', () => {
  it('decodes an argument-less custom error', () => {
    const decoded = decodeRevertData(encode('NothingToWithdraw'));
    expect(decoded.name).toBe('NothingToWithdraw');
    expect(decoded.kind).toBe('nothing-to-withdraw');
    expect(decoded.message).toContain('0.000001');
  });

  it('decodes a custom error with arguments', () => {
    const token = '0x3600000000000000000000000000000000000000';
    const decoded = decodeRevertData(encode('SafeERC20FailedOperation', [token]));
    expect(decoded.name).toBe('SafeERC20FailedOperation');
    expect(decoded.kind).toBe('token');
    expect(decoded.args?.[0]).toBe(token);
  });

  it('classifies authorisation, cancellation and bad input separately', () => {
    expect(decodeRevertData(encode('NotOwner')).kind).toBe('not-authorized');
    expect(decodeRevertData(encode('NotPendingOwner')).kind).toBe('not-authorized');
    expect(decodeRevertData(encode('PoolCancelled')).kind).toBe('cancelled');
    expect(decodeRevertData(encode('BadStartTime')).kind).toBe('bad-input');
    expect(decodeRevertData(encode('TooManyItems')).kind).toBe('bad-input');
    expect(decodeRevertData(encode('PoolNotFound')).kind).toBe('not-found');
    expect(decodeRevertData(encode('InsufficientUnstreamed')).kind).toBe('insufficient-funds');
    expect(decodeRevertData(encode('NoOp')).kind).toBe('no-op');
  });

  it('falls back to Error(string), which is how FiatToken reverts on the blocklist', () => {
    const data = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }],
      errorName: 'Error',
      args: ['Blacklistable: account is blacklisted'],
    });
    const decoded = decodeRevertData(data);
    expect(decoded.name).toBe('Error');
    expect(decoded.kind).toBe('token');
    expect(decoded.message).toContain('blacklisted');
  });

  it('decodes Panic(uint256)', () => {
    const data = encodeErrorResult({
      abi: [{ type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] }],
      errorName: 'Panic',
      args: [0x11n],
    });
    expect(decodeRevertData(data).name).toBe('Panic');
  });

  it('never throws on empty or unrecognised data', () => {
    expect(decodeRevertData(undefined).name).toBe('Unknown');
    expect(decodeRevertData('0x').message).toContain('without a reason');
    const unknown = decodeRevertData(`${toHex(0xdeadbeef).slice(0, 10)}` as `0x${string}`);
    expect(unknown.name).toBe('Unknown');
  });
});

describe('decodeRevert', () => {
  it('walks a viem error down to the reverted contract function', () => {
    const inner = new ContractFunctionRevertedError({
      abi: dripPoolAbi as never,
      data: encode('NotOwner'),
      functionName: 'setRate',
    });
    const outer = new BaseError('simulation failed', { cause: inner });
    const decoded = decodeRevert(outer);
    expect(decoded.name).toBe('NotOwner');
    expect(decoded.kind).toBe('not-authorized');
  });

  it('reads raw revert data off a plain RPC error object', () => {
    expect(decodeRevert({ data: encode('PoolNotFound') }).name).toBe('PoolNotFound');
  });

  it('degrades to Unknown with the original message for anything else', () => {
    const decoded = decodeRevert(new Error('socket hang up'));
    expect(decoded.name).toBe('Unknown');
    expect(decoded.message).toBe('socket hang up');
  });
});

describe('error classes', () => {
  it('carries a machine-readable code on every error', () => {
    const revert = new ContractRevertError('withdraw', decodeRevertData(encode('NothingToWithdraw')));
    expect(revert.code).toBe('CONTRACT_REVERT');
    expect(revert.errorName).toBe('NothingToWithdraw');
    expect(revert.message).toContain('withdraw reverted');

    expect(new TransactionRevertedError('deposit', '0xabc').code).toBe('TX_REVERTED');
    expect(new EventNotFoundError('PoolCreated', '0xabc').code).toBe('EVENT_NOT_FOUND');
    expect(new WalletRequiredError('createPool').code).toBe('WALLET_REQUIRED');
    expect(new PoolAddressUnknownError(5042).code).toBe('POOL_NOT_FOUND');
    expect(new InvalidInputError('poolId', ['must be >= 1']).code).toBe('INVALID_INPUT');
  });

  it('names the chain in PoolAddressUnknownError so the fix is obvious', () => {
    expect(new PoolAddressUnknownError(31337).message).toContain('31337');
    expect(new PoolAddressUnknownError(undefined).message).toContain('unknown');
  });
});
