// Playwright smoke over the static export (PRD 8.3). Local chain only: an injected EIP-1193 provider forwards to
// anvil's unlocked dev accounts, so no key is ever handled, nothing is deployed anywhere but a throwaway node.
//
// Two modes, picked automatically:
//   chain   anvil and contracts/out are both present: deploy MockUSDC + DripPool, create a funded pool with three
//           members, build the export against it, then drive the real UI (ticking table, Pay everyone, deposit).
//   static  otherwise: build the unconfigured export and check the three pages, the nav and the PT-BR toggle.
//
// It exits 0 with SKIP when Chromium cannot be installed, so `pnpm test` stays usable on a fresh machine.
//   pnpm --filter @sharedarc/web e2e:smoke
//   env SHOTS_DIR=/tmp/sharedarc-shots pnpm --filter @sharedarc/web e2e:smoke
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveStatic } from './static-server.mjs';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(WEB, '../..');
const SHOTS = process.env.SHOTS_DIR;
const log = (...a) => console.log(`[smoke ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ------------------------------------------------------------------------------------------- chromium
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('SKIP: playwright is not installed');
  process.exit(0);
}
async function browserOrSkip() {
  try {
    return await chromium.launch();
  } catch {
    log('chromium is missing; installing it once');
    const install = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit' });
    if (install.status !== 0) return null;
    try {
      return await chromium.launch();
    } catch {
      return null;
    }
  }
}

// ----------------------------------------------------------------------------------------------- chain
const hasAnvil = spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;
const artifactDir = path.join(REPO, 'contracts/out');
const hasArtifacts =
  existsSync(path.join(artifactDir, 'DripPool.sol/DripPool.json')) &&
  existsSync(path.join(artifactDir, 'MockUSDC.sol/MockUSDC.json'));
// SMOKE_MODE=static forces the chainless path, which is how CI exercises it on a machine that does have anvil.
const MODE = process.env.SMOKE_MODE === 'static' || !hasAnvil || !hasArtifacts ? 'static' : 'chain';
log(
  `mode: ${MODE}${MODE === 'static' && (!hasAnvil || !hasArtifacts) ? ' (no anvil or no contracts/out)' : ''}`,
);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let anvil = null;
let env = { NEXT_PUBLIC_BASE_PATH: '' };
let chain = null;

if (MODE === 'chain') {
  const { createPublicClient, createWalletClient, http, parseAbi } = await import('viem');
  const port = await freePort();
  const RPC = `http://127.0.0.1:${port}`;
  // `--block-time 1`: a bare anvil only advances `block.timestamp` when a transaction mines a block, so the
  // contract would think no time had passed while the UI ticked. One block per second mirrors Arc (0.5 s blocks)
  // and is what makes the on-chain accrual real during the run.
  anvil = spawn(
    'anvil',
    ['--port', String(port), '--silent', '--block-time', '1', '--hardfork', 'cancun', '--prune-history'],
    { stdio: 'ignore' },
  );
  anvil.on('error', (e) => {
    console.error(`cannot start anvil: ${e.message}`);
    process.exit(1);
  });
  process.on('exit', () => anvil?.kill('SIGTERM'));

  const rpc = async (method, params = []) => {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  for (let i = 0; ; i++) {
    try {
      await rpc('eth_chainId');
      break;
    } catch (e) {
      if (i > 150) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const viemChain = {
    id: 31337,
    name: 'anvil',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  };
  const pub = createPublicClient({ chain: viemChain, transport: http(RPC) });
  const accounts = await rpc('eth_accounts');
  const [A0, A1, A2] = accounts;
  const wallet = (account) => createWalletClient({ account, chain: viemChain, transport: http(RPC) });
  const artifact = (dir, name) =>
    JSON.parse(readFileSync(path.join(artifactDir, dir, `${name}.json`), 'utf8'));
  const mined = (hash) => pub.waitForTransactionReceipt({ hash });

  const usdcArtifact = artifact('MockUSDC.sol', 'MockUSDC');
  const dripArtifact = artifact('DripPool.sol', 'DripPool');
  const USDC = (
    await mined(
      await wallet(A0).deployContract({ abi: usdcArtifact.abi, bytecode: usdcArtifact.bytecode.object }),
    )
  ).contractAddress;
  const dripReceipt = await mined(
    await wallet(A0).deployContract({
      abi: dripArtifact.abi,
      bytecode: dripArtifact.bytecode.object,
      args: [USDC],
    }),
  );
  const DRIP = dripReceipt.contractAddress;

  const usdcAbi = parseAbi([
    'function mint(address,uint256)',
    'function approve(address,uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ]);
  const send = async (account, address, abi, functionName, args) =>
    mined(await wallet(account).writeContract({ address, abi, functionName, args }));

  await send(A0, USDC, usdcAbi, 'mint', [A0, 1_000_000_000n]);
  // 86,400 USDC/day = 1 USDC per second in wad, so the table visibly ticks during the run.
  const ratePerSecond = 1_000_000_000_000n;
  await send(A0, DRIP, dripArtifact.abi, 'createPool', [A0, ratePerSecond, 0n, 'smoke collective']);
  await send(A0, USDC, usdcAbi, 'approve', [DRIP, 1_000_000_000n]);
  await send(A0, DRIP, dripArtifact.abi, 'deposit', [1n, 500_000_000n]);
  await send(A0, DRIP, dripArtifact.abi, 'setSharesBatch', [1n, [A0, A1, A2], [1n, 1n, 2n]]);
  log(`deployed MockUSDC ${USDC} and DripPool ${DRIP}; pool #1 funded`);

  chain = { RPC, DRIP, USDC, A0, A1, A2, pub, usdcAbi };
  env = {
    NEXT_PUBLIC_CHAIN_ID: '31337',
    NEXT_PUBLIC_RPC_URL: RPC,
    NEXT_PUBLIC_DRIP_ADDRESS: DRIP,
    NEXT_PUBLIC_USDC_ADDRESS: USDC,
    NEXT_PUBLIC_DRIP_DEPLOY_BLOCK: dripReceipt.blockNumber.toString(),
    NEXT_PUBLIC_BASE_PATH: '',
  };
}

// ------------------------------------------------------------------------------------------ build + serve
log('building the static export');
const build = spawnSync('pnpm', ['build'], { cwd: WEB, encoding: 'utf8', env: { ...process.env, ...env } });
if (build.status !== 0) {
  console.error(build.stdout, build.stderr);
  anvil?.kill('SIGTERM');
  process.exit(1);
}
const { server, url: SITE } = await serveStatic(path.join(WEB, 'out'));

const browser = await browserOrSkip();
if (!browser) {
  console.log('SKIP: chromium could not be installed; the static export was still built');
  server.close();
  anvil?.kill('SIGTERM');
  process.exit(0);
}

// --------------------------------------------------------------------------------------------- browser
const consoleErrors = [];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** A page whose injected wallet is `account` (null: no wallet), forwarding to anvil. */
async function openAs(account) {
  const context = await browser.newContext();
  if (account) {
    await context.addInitScript(
      ({ account, rpcUrl }) => {
        let id = 0;
        const call = async (method, params) => {
          const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }),
          });
          const body = await res.json();
          if (body.error) throw Object.assign(new Error(body.error.message), body.error);
          return body.result;
        };
        window.ethereum = {
          request: async ({ method, params }) => {
            switch (method) {
              case 'eth_requestAccounts':
              case 'eth_accounts':
                return [account];
              case 'eth_chainId':
                return '0x7a69';
              case 'wallet_switchEthereumChain':
              case 'wallet_addEthereumChain':
                return null;
              case 'wallet_requestPermissions':
              case 'wallet_getPermissions':
                return [{ parentCapability: 'eth_accounts' }];
              case 'eth_sendTransaction':
                return call(method, [{ ...params[0], from: account }]);
              default:
                return call(method, params);
            }
          },
          on() {},
          removeListener() {},
        };
      },
      { account, rpcUrl: chain.RPC },
    );
  }
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`${page.url()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${page.url()}: ${e.message}`));
  return page;
}

const see = (page, text, timeout = 20_000) =>
  page.getByText(text, { exact: false }).first().waitFor({ timeout });
const shot = async (page, name) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};
async function step(name, fn) {
  await fn();
  log('ok:', name);
}

try {
  const page = await openAs(null);

  await step('the home page states what SharedArc is and links to the docs', async () => {
    await page.goto(`${SITE}/`);
    await see(page, 'One rate, N shares, live runway');
    await see(page, 'Create a pool');
    await shot(page, 'home');
  });

  await step('the docs page renders the accrual and the comparison table', async () => {
    await page.goto(`${SITE}/docs/`);
    await see(page, 'How SharedArc works');
    await see(page, 'accIndex');
    await see(page, 'Sablier');
    await shot(page, 'docs');
  });

  await step('the docs page switches to Portuguese and back', async () => {
    await page.getByRole('button', { name: 'PT-BR' }).click();
    await see(page, 'Como o SharedArc funciona');
    await page.getByRole('button', { name: 'EN' }).click();
    await see(page, 'How SharedArc works');
  });

  await step('a pool page without an id explains what is missing', async () => {
    await page.goto(`${SITE}/pool/`);
    // Without a DripPool address the build cannot read anything, so that is the honest message to show first.
    await see(page, MODE === 'chain' ? '/pool/?id=1' : 'No DripPool configured');
  });

  if (MODE === 'chain') {
    await step('the pool page shows the live pool, its runway and the member table', async () => {
      await page.goto(`${SITE}/pool/?id=1`);
      await see(page, 'smoke collective');
      await see(page, 'Streaming');
      await see(page, 'Members');
      await shot(page, 'pool');
    });

    await step('the claimable column ticks every second without an RPC call', async () => {
      // The SDK checksums addresses, so match the attribute case-insensitively rather than on anvil's lowercase.
      const cell = page.locator('tbody [data-claimable]').first();
      const first = await cell.textContent();
      await page.waitForTimeout(2_500);
      const second = await cell.textContent();
      if (first === second) throw new Error(`claimable did not tick: still ${first}`);
    });

    const owner = await openAs(chain.A0);
    await step('the owner connects and sees the owner panel', async () => {
      await owner.goto(`${SITE}/pool/?id=1`);
      await owner.getByRole('button', { name: 'Connect wallet' }).first().click();
      await owner
        .getByText(/^0x[0-9a-fA-F]{4}…/)
        .first()
        .waitFor();
      await owner.getByTestId('owner-panel').waitFor();
      await shot(owner, 'owner');
    });

    await step('"Pay everyone" pays every member in one transaction', async () => {
      const before = await chain.pub.readContract({
        address: chain.USDC,
        abi: chain.usdcAbi,
        functionName: 'balanceOf',
        args: [chain.A2],
      });
      await owner.getByRole('button', { name: 'Pay everyone' }).click();
      // A regex, not a substring: Playwright's text matching ignores case, and the table says "paid to ...".
      await owner
        .getByText(/Paid [\d.,]+ USDC to \d+ member/)
        .first()
        .waitFor({ timeout: 30_000 });
      const after = await chain.pub.readContract({
        address: chain.USDC,
        abi: chain.usdcAbi,
        functionName: 'balanceOf',
        args: [chain.A2],
      });
      if (!(after > before)) throw new Error(`member C was not paid (${before} -> ${after})`);
    });

    await step('a deposit tops the pool up through approve + deposit', async () => {
      await owner.getByLabel('Amount (USDC)').first().fill('10');
      await owner.getByRole('button', { name: 'Deposit', exact: true }).click();
      await see(owner, 'Deposited');
    });

    const member = await openAs(chain.A1);
    await step('a member sees their own row and their member panel', async () => {
      await member.goto(`${SITE}/pool/?id=1`);
      await member.getByRole('button', { name: 'Connect wallet' }).first().click();
      await member.getByTestId('member-panel').waitFor();
      await see(member, 'You can withdraw');
      if (await member.getByTestId('owner-panel').count())
        throw new Error('a non-owner was shown the owner panel');
      await shot(member, 'member');
    });
  }

  if (consoleErrors.length > 0) throw new Error(`${consoleErrors.length} console error(s)`);
  log(`PASS (${MODE} mode): every step, zero console errors`);
} catch (e) {
  console.error('[smoke] FAIL:', e.message);
  for (const c of consoleErrors) console.error('  console:', c);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  anvil?.kill('SIGTERM');
}
