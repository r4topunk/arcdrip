// A throwaway local anvil per test file. Uses anvil's unlocked dev accounts through `eth_sendTransaction`, so no
// key material is ever handled, read or written by the tests. Every suite that needs it is skipped cleanly when
// `anvil` is not installed (`describe.skipIf(!anvilAvailable)`).
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { defineChain } from 'viem';

export const anvilAvailable = spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;

export const localChain = defineChain({
  id: 31337,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } },
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export type Anvil = { url: string; stop: () => Promise<void> };

/** Starts anvil on a free port and resolves once it answers `eth_chainId`. Kill it in `afterAll`. */
export async function startAnvil(accounts = 8): Promise<Anvil> {
  const port = await freePort();
  const proc: ChildProcess = spawn(
    'anvil',
    ['--port', String(port), '--silent', '--accounts', String(accounts)],
    { stdio: 'ignore' },
  );
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error('anvil did not start within 20s');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return {
    url,
    stop: () =>
      new Promise((resolve) => {
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
      }),
  };
}
