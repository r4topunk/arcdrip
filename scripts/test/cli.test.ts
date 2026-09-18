import { describe, expect, it } from 'vitest';
import { parseCli } from '../lib/cli.js';

describe('parseCli', () => {
  it('defaults to the testnet run', () => {
    expect(parseCli([])).toEqual({
      help: false,
      local: false,
      rpc: undefined,
      port: undefined,
      wait: false,
      reset: false,
    });
  });

  it('--dry-run starts a local run', () => {
    expect(parseCli(['--dry-run'])).toMatchObject({ local: true, rpc: undefined });
  });

  it('--rpc targets a running local anvil', () => {
    expect(parseCli(['--rpc', 'http://127.0.0.1:8545'])).toMatchObject({
      local: true,
      rpc: 'http://127.0.0.1:8545',
    });
    expect(parseCli(['--rpc', 'http://localhost:8600', '--reset'])).toMatchObject({
      local: true,
      reset: true,
    });
  });

  it('refuses an --rpc that is not local: this script never talks to a real network in local mode', () => {
    expect(() => parseCli(['--rpc', 'https://rpc.mainnet.arc.io'])).toThrow(/local anvil/);
    expect(() => parseCli(['--rpc', 'http://10.0.0.5:8545'])).toThrow(/local anvil/);
  });

  it('refuses flag combinations that do not apply', () => {
    expect(() => parseCli(['--dry-run', '--rpc', 'http://127.0.0.1:8545'])).toThrow(/not both/);
    expect(() => parseCli(['--dry-run', '--wait'])).toThrow(/--wait only applies/);
    expect(() => parseCli(['--port', '8545'])).toThrow(/only apply to a local run/);
    expect(() => parseCli(['--dry-run', '--port', '0'])).toThrow(/invalid --port/);
    expect(() => parseCli(['--nope'])).toThrow();
  });

  it('ignores a "--" separator forwarded by pnpm', () => {
    expect(parseCli(['--', '--dry-run'])).toMatchObject({ local: true });
  });
});
