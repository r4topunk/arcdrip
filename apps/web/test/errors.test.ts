import { type DecodedRevert, DRIP_ERROR_NAMES, decodeRevertData, InvalidInputError } from '@sharedarc/sdk';
import { UserRejectedRequestError } from 'viem';
import { describe, expect, it } from 'vitest';
import { CONTRACT_ERROR_KEYS, describeError, errorMessage, revertMessage } from '@/lib/errors';
import { MESSAGES } from '@/lib/i18n';

const revert = (over: Partial<DecodedRevert>): DecodedRevert => ({
  name: 'Unknown',
  kind: 'unknown',
  message: '',
  ...over,
});

describe('decoded custom errors', () => {
  it('has a message in both languages for every error the ABI can revert with', () => {
    for (const name of DRIP_ERROR_NAMES) {
      const key = CONTRACT_ERROR_KEYS[name];
      expect(key, name).toBeTruthy();
      expect(MESSAGES.en[key].trim(), name).not.toBe('');
      expect(MESSAGES['pt-BR'][key].trim(), name).not.toBe('');
    }
  });

  it('explains NothingToWithdraw rather than showing a selector', () => {
    const msg = revertMessage(revert({ name: 'NothingToWithdraw', kind: 'nothing-to-withdraw' }), 'en');
    expect(msg).toMatch(/0.000001 USDC/);
    expect(
      revertMessage(revert({ name: 'NothingToWithdraw', kind: 'nothing-to-withdraw' }), 'pt-BR'),
    ).toMatch(/0,000001 USDC/);
  });

  it('decodes real revert data for a DripPool error through the SDK', () => {
    // NotOwner() selector, as a node would return it.
    const data = decodeRevertData('0x30cd7471');
    expect(revertMessage(data, 'en')).toBe(MESSAGES.en['error.contract.NotOwner']);
  });

  it('turns a USDC revert string into the blocklist explanation', () => {
    const msg = revertMessage(
      revert({ name: 'Error', args: ['Blacklistable: account is blacklisted'] }),
      'en',
    );
    expect(msg).toBe(MESSAGES.en['error.usdc.blocklisted']);
  });

  it('keeps an unknown revert honest instead of inventing a cause', () => {
    expect(revertMessage(revert({}), 'en')).toBe(MESSAGES.en['error.unknownRevert']);
  });
});

describe('thrown errors', () => {
  it('names a rejected wallet request', () => {
    const err = new UserRejectedRequestError(new Error('User rejected the request.'));
    expect(describeError(err).key).toBe('error.wallet.rejected');
    expect(errorMessage(err, 'pt-BR')).toBe(MESSAGES['pt-BR']['error.wallet.rejected']);
  });

  it('lists the problems of an invalid SDK argument', () => {
    const err = new InvalidInputError('poolId', ['poolId must be in [1, 2^256 - 1], got 0']);
    expect(errorMessage(err, 'en')).toMatch(/poolId must be in/);
  });

  it('recognises an EIP-1193 rejection object from an injected wallet', () => {
    expect(describeError({ code: 4001 }).key).toBe('error.wallet.rejected');
  });

  it('falls back to the raw message rather than swallowing an unknown failure', () => {
    expect(errorMessage(new Error('boom'), 'en')).toMatch(/boom/);
  });
});
