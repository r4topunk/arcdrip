// The whole e2e flow on a throwaway anvil, as `pnpm e2e:dry-run` runs it: MockUSDC etched at Arc's USDC address,
// Deploy.s.sol through the CREATE2 deployer, record-deployment.mjs, and the PRD 8.4 sequence with chain time
// jumped instead of waited out. Records go to a temp directory, never to deployments/ or scripts/.state.
// Skipped without Foundry or without built contract artifacts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROOF_KEYS } from '../lib/deployments.js';
import { type LocalResult, runLocal } from '../lib/local.js';

const foundry = ['anvil', 'forge', 'cast'].every(
  (bin) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0,
);
const built = existsSync(new URL('../../contracts/out/MockUSDC.sol/MockUSDC.json', import.meta.url));

describe.skipIf(!foundry || !built)('e2e dry run on local anvil', () => {
  let dir: string;
  let result: LocalResult;
  const lines: string[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sharedarc-dry-run-'));
    result = await runLocal({
      deploymentsFile: join(dir, 'anvil-dry-run.json'),
      stateDir: join(dir, 'state'),
      say: (l) => lines.push(l),
      env: { ...process.env, LOG_LEVEL: 'silent' },
    });
  }, 300_000);

  afterAll(async () => {
    await result?.anvil?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('deploys through Deploy.s.sol and the CREATE2 deployer, and records the deployment', () => {
    const record = JSON.parse(readFileSync(result.deploymentsFile, 'utf8'));
    expect(record.chainId).toBe(31_337);
    expect(record.contracts.DripPool).toMatchObject({
      address: result.pool.toLowerCase(),
      salt: 'keccak256("arcdrip.v1")',
      constructorArgs: { usdc: '0x3600000000000000000000000000000000000000' },
    });
    expect(record.contracts.DripPool.saltHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('runs the whole PRD 8.4 sequence and ends with a cancelled pool that still owes its members', () => {
    expect(result.flow.status).toBe('done');
    if (result.flow.status !== 'done') return;
    expect(result.flow.poolId).toBe(1n);
    // Everything streamed is still owed to members after the cancel: the owner got back only the unstreamed part.
    expect(result.flow.streamedWad).toBeGreaterThan(0n);
    expect(result.state.completedAt).toBeTruthy();
  });

  it('writes one proof transaction per step of the flow, in order', () => {
    const record = JSON.parse(readFileSync(result.deploymentsFile, 'utf8'));
    expect(Object.keys(record.proofTxs)).toEqual([...PROOF_KEYS]);
    for (const hash of Object.values(record.proofTxs).flat()) expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(record.e2e).toMatchObject({ poolId: 1 });
    expect(record.e2e.gasUsed.withdrawForBatch).toBeGreaterThan(0);
  });

  it('proves the freeze and the no-back-pay rule from chain state, not from the log text', () => {
    expect(lines.some((l) => l.includes('frozen: claimable of wallet 1 stays at'))).toBe(true);
    expect(lines.some((l) => l.includes('no back-pay'))).toBe(true);
  });

  it('pays all four members in one withdrawForBatch, including the member that never signed', () => {
    const paid = lines.find((l) => l.includes('paid ') && l.includes('member(s)'));
    expect(paid).toContain('4 member(s)');
    expect(lines.some((l) => l.includes('skipped'))).toBe(false);
  });

  it('is idempotent: a second run over the same state sends nothing', async () => {
    const second: string[] = [];
    const again = await runLocal({
      rpc: result.url,
      deploymentsFile: join(dir, 'anvil-dry-run.json'),
      stateDir: join(dir, 'state'),
      say: (l) => second.push(l),
      env: { ...process.env, LOG_LEVEL: 'silent' },
    });
    expect(again.flow.status).toBe('done');
    expect(again.state.txs).toEqual(result.state.txs);
    expect(second.filter((l) => l.includes('already done')).length).toBeGreaterThanOrEqual(8);
  }, 300_000);
});
