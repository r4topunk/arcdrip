// Cross-check of the offchain mirror against the contract: `contracts/test/vectors/accrual.json` is exported by a
// Foundry test, and every value here must match bit for bit (PRD 8.2, phase-1 gate). The two implementations are
// written independently from PRD 4.2, so an equal result is evidence and a mismatch is a real defect on one side.
//
// The file is produced by another part of the build. When it is missing this suite skips with a message instead of
// failing: `pnpm --filter '@sharedarc/sdk' test` still has to be meaningful before the contracts land.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claimable, fundedUntil, unstreamed } from '../src/math.js';
import { parseAccrualMember, parseAccrualPool, timestampSchema } from '../src/schemas.js';

const VECTORS_PATH = fileURLToPath(new URL('../../../contracts/test/vectors/accrual.json', import.meta.url));

/** Expected shape (numbers as decimal strings): the generator is free to add fields, never to rename these. */
interface RawVector {
  name?: string;
  pool: unknown;
  member: unknown;
  now: unknown;
  expected: {
    claimable: unknown;
    fundedUntil: unknown;
    unstreamed: unknown;
  };
}

function toBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) return BigInt(value.trim());
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError(
    `${label} must be a decimal string (or a safe integer); got ${JSON.stringify(value)}. ` +
      'Emit large numbers as strings so JSON never rounds them.',
  );
}

function loadVectors(): RawVector[] {
  const parsed: unknown = JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { vectors?: unknown }).vectors)
      ? ((parsed as { vectors: unknown[] }).vectors as unknown[])
      : null;
  if (!list) {
    throw new TypeError(
      `${VECTORS_PATH} must be a JSON array of vectors (or an object with a "vectors" array), got ` +
        `${Object.prototype.toString.call(parsed)}`,
    );
  }
  return list as RawVector[];
}

const present = existsSync(VECTORS_PATH);

describe('accrual vectors vs the contract', () => {
  if (!present) {
    it.skip(`skipped: ${VECTORS_PATH} is missing — run the Foundry vector export first (it is produced by the contracts package)`, () => {});
    return;
  }

  const vectors = loadVectors();

  it('exports at least the 30 vectors the test plan requires', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(30);
  });

  for (const [i, vector] of vectors.entries()) {
    const label = vector.name ? `${i}: ${vector.name}` : `vector ${i}`;
    it(`${label} matches claimable, fundedUntil and unstreamed`, () => {
      const pool = parseAccrualPool(vector.pool);
      const member = parseAccrualMember(vector.member);
      const now = timestampSchema.parse(vector.now);
      const expected = vector.expected;
      expect(expected, `${label}: missing "expected"`).toBeTruthy();

      expect(claimable(pool, member, now), `${label}: claimable`).toBe(
        toBigInt(expected.claimable, `${label}.expected.claimable`),
      );
      expect(fundedUntil(pool, now), `${label}: fundedUntil`).toBe(
        toBigInt(expected.fundedUntil, `${label}.expected.fundedUntil`),
      );
      expect(unstreamed(pool, now), `${label}: unstreamed`).toBe(
        toBigInt(expected.unstreamed, `${label}.expected.unstreamed`),
      );
    });
  }
});
