import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARC_MAINNET_ID,
  ARC_TESTNET_ID,
  chainFor,
  e2eEnvSchema,
  LOCAL_CHAIN_ID,
  logLevel,
  parseEnv,
  readDeployment,
  txUrl,
} from '../lib/config.js';
import { burnerFromRunTag } from '../lib/testnet.js';

describe('e2eEnvSchema', () => {
  it('falls back to the documented defaults when nothing is set', () => {
    const env = parseEnv(e2eEnvSchema, {});
    expect(env).toMatchObject({
      ARC_TESTNET_RPC: 'https://rpc.testnet.arc.io',
      WALLET1_ACCOUNT: 'arcdrip-deployer',
      WALLET2_ACCOUNT: 'arcdrip-wallet-b',
      WALLET3_ACCOUNT: 'arcdrip-wallet-c',
      E2E_DEPOSIT: 200_000n,
      E2E_RUNWAY_SECONDS: 180,
    });
    expect(env.DRIP_POOL_ADDRESS).toBeUndefined();
    expect(env.OPS_ADDRESS).toBeUndefined();
  });

  it('treats the .env.example placeholders as unset', () => {
    const env = parseEnv(e2eEnvSchema, {
      DRIP_POOL_ADDRESS: '[ADDRESS]',
      OPS_ADDRESS: '  ',
      WALLET2_ACCOUNT: '',
    });
    expect(env.DRIP_POOL_ADDRESS).toBeUndefined();
    expect(env.OPS_ADDRESS).toBeUndefined();
    expect(env.WALLET2_ACCOUNT).toBe('arcdrip-wallet-b');
  });

  it('checksums addresses and rejects bad values with one error listing every field', () => {
    const env = parseEnv(e2eEnvSchema, { OPS_ADDRESS: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' });
    expect(env.OPS_ADDRESS).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(() => parseEnv(e2eEnvSchema, { OPS_ADDRESS: '0x1234', E2E_DEPOSIT: '0' })).toThrow(
      /invalid environment/,
    );
  });

  it('bounds the timing knobs, so a run cannot be configured into a silly rate', () => {
    expect(() => parseEnv(e2eEnvSchema, { E2E_RUNWAY_SECONDS: '5' })).toThrow(/invalid environment/);
    expect(() => parseEnv(e2eEnvSchema, { E2E_STREAM_SECONDS: '999999' })).toThrow(/invalid environment/);
  });
});

describe('chainFor', () => {
  it('knows the three chains the scripts talk to and takes the PRD RPC over viem defaults', () => {
    expect(chainFor(ARC_MAINNET_ID, 'https://rpc.mainnet.arc.io').rpcUrls.default.http[0]).toBe(
      'https://rpc.mainnet.arc.io',
    );
    expect(chainFor(ARC_TESTNET_ID, 'https://rpc.testnet.arc.io').id).toBe(ARC_TESTNET_ID);
    expect(chainFor(LOCAL_CHAIN_ID, 'http://127.0.0.1:8545').id).toBe(LOCAL_CHAIN_ID);
    expect(() => chainFor(1, 'https://eth.example')).toThrow(/unsupported chain id/);
  });
});

describe('txUrl / logLevel', () => {
  it('links to the explorer only when there is one', () => {
    expect(txUrl('https://explorer.arc.io/', '0xabc')).toBe('https://explorer.arc.io/tx/0xabc');
    expect(txUrl('', '0xabc')).toBe('');
  });

  it('keeps the SDK logger quiet unless LOG_LEVEL says otherwise', () => {
    expect(logLevel({})).toBe('warn');
    expect(logLevel({ LOG_LEVEL: 'debug' })).toBe('debug');
    expect(logLevel({ LOG_LEVEL: 'nonsense' })).toBe('warn');
  });
});

describe('readDeployment', () => {
  it('returns null while the record is still a template, and the address once it is filled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'arcdrip-deploy-'));
    try {
      const file = join(dir, 'arc-testnet.json');
      const template = {
        chainId: 5_042_002,
        contracts: { DripPool: { address: null, deployBlock: null } },
      };
      writeFileSync(file, JSON.stringify(template));
      expect(readDeployment(file)).toBeNull();
      writeFileSync(
        file,
        JSON.stringify({
          chainId: 5_042_002,
          contracts: { DripPool: { address: '0xfcd410c11fbdda38ff9d4ca6ba9f612536ddfe47', deployBlock: 12 } },
        }),
      );
      expect(readDeployment(file)).toEqual({
        chainId: 5_042_002,
        pool: '0xfCD410c11FbDDa38Ff9D4Ca6Ba9f612536dDfE47',
        deployBlock: 12n,
      });
      expect(readDeployment(join(dir, 'nope.json'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('burnerFromRunTag', () => {
  it('derives a stable, key-less fourth member from the run tag', () => {
    const a = burnerFromRunTag('run-1');
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(burnerFromRunTag('run-1')).toBe(a);
    expect(burnerFromRunTag('run-2')).not.toBe(a);
  });
});
