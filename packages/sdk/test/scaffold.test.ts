import { describe, expect, it } from 'vitest';
import { SDK_NAME } from '../src/index.js';

// Scaffold-only: keeps `vitest run` meaningful before the real suites exist. Delete with the first real test file.
describe('scaffold', () => {
  it('exposes the package entry point', () => {
    expect(SDK_NAME).toBe('@arcdrip/sdk');
  });
});
