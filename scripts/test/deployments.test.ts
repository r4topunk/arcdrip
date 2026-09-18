import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEPLOYMENT_FILES } from '../lib/config.js';
import { proofTxsFromState, summaryLines, writeRunRecord } from '../lib/deployments.js';
import { newState, type RunState } from '../lib/state.js';

const POOL = '0xfCD410c11FbDDa38Ff9D4Ca6Ba9f612536dDfE47';
const hash = (n: number) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;

function stateWith(txs: RunState['txs']): RunState {
  return { ...newState(31_337, POOL, 'run-1'), poolId: '1', txs };
}

describe('proofTxsFromState', () => {
  it('keeps the flow order and only confirmed transactions', () => {
    const state = stateWith({
      cancel: { label: 'cancel', hash: hash(3), status: 'success' },
      createPool: { label: 'createPool', hash: hash(1), status: 'success' },
      deposit: { label: 'deposit', hash: hash(2), status: 'pending' },
    });
    expect(proofTxsFromState(state)).toEqual({ createPool: hash(1), cancel: hash(3) });
  });

  it('collapses "<key>.<n>" steps into an array, in order', () => {
    const state = stateWith({
      'withdrawForBatch.2': { label: 'batch 2', hash: hash(2), status: 'success' },
      'withdrawForBatch.1': { label: 'batch 1', hash: hash(1), status: 'success' },
    });
    expect(proofTxsFromState(state).withdrawForBatch).toEqual([hash(1), hash(2)]);
  });
});

describe('writeRunRecord', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sharedarc-record-'));
    file = join(dir, 'anvil-dry-run.json');
    writeFileSync(
      file,
      JSON.stringify({ network: 'anvil-local', chainId: 31_337, contracts: {}, proofTxs: {} }),
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('merges proof hashes and the run summary while keeping the rest of the record', () => {
    const state = stateWith({
      createPool: { label: 'createPool', hash: hash(1), status: 'success', gasUsed: '78644' },
    });
    writeRunRecord(file, state);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    expect(record.network).toBe('anvil-local');
    expect(record.proofTxs).toEqual({ createPool: hash(1) });
    expect(record.e2e).toMatchObject({ runTag: 'run-1', poolId: 1, gasUsed: { createPool: 78_644 } });
  });

  it('never writes the mainnet record', () => {
    expect(() => writeRunRecord(DEPLOYMENT_FILES.mainnet, stateWith({}))).toThrow(/refusing/);
  });

  it('refuses a record that does not exist yet', () => {
    expect(() => writeRunRecord(join(dir, 'missing.json'), stateWith({}))).toThrow(/missing/);
  });
});

describe('summaryLines', () => {
  it('prints one line per confirmed transaction, with the explorer link when there is one', () => {
    const state = stateWith({
      createPool: {
        label: 'createPool',
        hash: hash(1),
        status: 'success',
        gasUsed: '78644',
        costUsdc: '140',
      },
      deposit: { label: 'deposit', hash: hash(2), status: 'pending' },
    });
    const [line, ...rest] = summaryLines(state, 'https://explorer.arc.io/');
    expect(rest).toHaveLength(0);
    expect(line).toContain('createPool');
    expect(line).toContain('gas 78,644');
    expect(line).toContain('fee 0.000140 USDC');
    expect(line).toContain(`https://explorer.arc.io/tx/${hash(1)}`);
    expect(summaryLines(state, '')[0]).not.toContain('http');
  });
});
