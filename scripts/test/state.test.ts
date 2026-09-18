import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newState, StateStore } from '../lib/state.js';

const POOL = '0xfCD410c11FbDDa38Ff9D4Ca6Ba9f612536dDfE47';
const HASH = `0x${'ab'.repeat(32)}`;

describe('StateStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'arcdrip-state-'));
    file = join(dir, '31337.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates and reloads a run state', () => {
    const store = StateStore.open(file, () => newState(31_337, POOL, 'run-1'));
    expect(store.get()).toMatchObject({ version: 1, chainId: 31_337, pool: POOL, runTag: 'run-1' });
    const reopened = StateStore.open(file, () => {
      throw new Error('should not re-initialise an existing file');
    });
    expect(reopened.get().runTag).toBe('run-1');
  });

  it('writes every update to disk, so a crash cannot lose a sent transaction', () => {
    const store = StateStore.open(file, () => newState(31_337, POOL, 'run-1'));
    store.update((draft) => {
      draft.poolId = '7';
      draft.txs.createPool = { label: 'createPool', hash: HASH, status: 'success', gasUsed: '78644' };
    });
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.poolId).toBe('7');
    expect(onDisk.txs.createPool.hash).toBe(HASH);
    expect(StateStore.open(file, () => newState(31_337, POOL, 'other')).get().poolId).toBe('7');
  });

  it('refuses values that are not bigint-safe strings or addresses', () => {
    const store = StateStore.open(file, () => newState(31_337, POOL, 'run-1'));
    expect(() => store.update((draft) => ((draft as { poolId?: string }).poolId = '-1'))).toThrow();
    expect(() =>
      store.update((draft) => {
        draft.txs.bad = { label: 'bad', hash: '0x1234', status: 'success' };
      }),
    ).toThrow();
  });

  it('refuses a state file it cannot parse instead of silently starting over', () => {
    writeFileSync(file, '{"version":2}');
    expect(() => StateStore.open(file, () => newState(31_337, POOL, 'run-1'))).toThrow(/not valid/);
  });
});
