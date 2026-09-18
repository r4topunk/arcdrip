// CCTP V2 encoding and guard rails. No network: these assert the arguments `depositForBurn` would be called
// with, plus the addresses verified against Arc mainnet on 2026-09-18 (see docs/CCTP.md).
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ANY_DESTINATION_CALLER,
  ARC_CCTP_DOMAIN,
  addressToBytes32,
  buildDepositForBurn,
  bytes32ToAddress,
  CCTP_DOMAINS,
  CCTP_MESSAGE_TRANSMITTER,
  CCTP_TOKEN_MESSENGER,
  FINALITY_THRESHOLD,
  resolveDomain,
  tokenMessengerV2Abi,
} from '../src/bridge.js';
import { ARC_MAINNET_CHAIN_ID, ARC_TESTNET_CHAIN_ID } from '../src/constants.js';

const USDC = '0x3600000000000000000000000000000000000000' as Address;
const RECIPIENT = '0x00000000000000000000000000000000000000Aa' as Address;

describe('CCTP constants', () => {
  it('uses Arc domain 26 on both networks, as localDomain() reports on-chain', () => {
    expect(ARC_CCTP_DOMAIN).toBe(26);
    expect(CCTP_DOMAINS.arc).toBe(ARC_CCTP_DOMAIN);
  });

  it('knows the TokenMessengerV2 and MessageTransmitterV2 for both Arc networks', () => {
    expect(CCTP_TOKEN_MESSENGER[ARC_MAINNET_CHAIN_ID]).toBe('0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d');
    expect(CCTP_TOKEN_MESSENGER[ARC_TESTNET_CHAIN_ID]).toBe('0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA');
    expect(CCTP_MESSAGE_TRANSMITTER[ARC_MAINNET_CHAIN_ID]).toBe('0x81d40f21f12a8f0e3252bccb954d722d4c464b64');
    expect(CCTP_MESSAGE_TRANSMITTER[ARC_TESTNET_CHAIN_ID]).toBe('0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275');
  });

  it('exposes depositForBurn with the seven V2 parameters', () => {
    const fn = tokenMessengerV2Abi.find((item) => item.name === 'depositForBurn');
    expect(fn?.inputs.map((input) => input.type)).toEqual([
      'uint256',
      'uint32',
      'bytes32',
      'address',
      'bytes32',
      'uint256',
      'uint32',
    ]);
  });

  it('uses CCTP V2 finality thresholds', () => {
    expect(FINALITY_THRESHOLD.standard).toBe(2000);
    expect(FINALITY_THRESHOLD.fast).toBe(1000);
  });
});

describe('address <-> bytes32', () => {
  it('left-pads an address to 32 bytes and back', () => {
    const padded = addressToBytes32(RECIPIENT);
    expect(padded).toHaveLength(66);
    expect(padded.slice(0, 26)).toBe(`0x${'0'.repeat(24)}`);
    expect(bytes32ToAddress(padded).toLowerCase()).toBe(RECIPIENT.toLowerCase());
  });

  it('has an all-zero sentinel for "any destination caller"', () => {
    expect(ANY_DESTINATION_CALLER).toBe(`0x${'0'.repeat(64)}`);
  });
});

describe('resolveDomain', () => {
  it('accepts a known chain name or a raw uint32', () => {
    expect(resolveDomain('base')).toBe(6);
    expect(resolveDomain('ethereum')).toBe(0);
    expect(resolveDomain(7)).toBe(7);
  });

  it('refuses an unknown name, a non-uint32 and Arc itself', () => {
    expect(() => resolveDomain('mars' as never)).toThrow(/unknown CCTP destination/);
    expect(() => resolveDomain(-1)).toThrow(RangeError);
    expect(() => resolveDomain(1.5)).toThrow(RangeError);
    expect(() => resolveDomain('arc')).toThrow(/Arc itself/);
  });
});

describe('buildDepositForBurn', () => {
  const base = { amount: 1_000_000n, destination: 'base' as const, recipient: RECIPIENT, token: USDC };

  it('builds a standard transfer with no fee and the standard threshold', () => {
    const args = buildDepositForBurn(base);
    expect(args).toEqual([
      1_000_000n,
      6,
      addressToBytes32(RECIPIENT),
      USDC,
      ANY_DESTINATION_CALLER,
      0n,
      2000,
    ]);
  });

  it('forces maxFee to zero for a standard transfer even if one is passed', () => {
    expect(buildDepositForBurn({ ...base, maxFee: 500n })[5]).toBe(0n);
  });

  it('carries the fee and the fast threshold for a fast transfer', () => {
    const args = buildDepositForBurn({ ...base, speed: 'fast', maxFee: 500n });
    expect(args[5]).toBe(500n);
    expect(args[6]).toBe(1000);
  });

  it('restricts the destination caller when one is given', () => {
    const args = buildDepositForBurn({ ...base, destinationCaller: RECIPIENT });
    expect(args[4]).toBe(addressToBytes32(RECIPIENT));
  });

  it('refuses a zero amount, a fast transfer with no fee, and a fee above the amount', () => {
    expect(() => buildDepositForBurn({ ...base, amount: 0n })).toThrow(/must be > 0/);
    expect(() => buildDepositForBurn({ ...base, speed: 'fast' })).toThrow(/maxFee > 0/);
    expect(() => buildDepositForBurn({ ...base, speed: 'fast', maxFee: 1_000_000n })).toThrow(
      /below the amount/,
    );
  });
});
