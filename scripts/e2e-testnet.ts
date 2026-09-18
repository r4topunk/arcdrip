// End-to-end run of DripPool (PRD 8.4) on Arc testnet, and its local anvil dry run. See DEPLOY.md.
//
//   pnpm e2e:testnet                Arc testnet (chain 5042002) with three Foundry keystores. Idempotent: a long
//                                   wait pauses the run and re-running it resumes from scripts/.state/5042002.json
//   pnpm e2e:testnet --wait         same, but sleeps through every wait
//   pnpm e2e:testnet --reset        archive the state file and start over with a new pool
//   pnpm e2e:dry-run                start a local anvil with the USDC mock, deploy, run the whole flow, jump time
//   pnpm e2e:dry-run --port 8600    use a specific port for that anvil
//   tsx e2e-testnet.ts --rpc http://127.0.0.1:8545   run against an anvil that is already up
//
// The testnet run never sees a private key: WALLET1_ACCOUNT / WALLET2_ACCOUNT / WALLET3_ACCOUNT name Foundry
// encrypted keystores, which `cast wallet private-key` decrypts in a child process (scripts/lib/signers.ts).
import { parseCli } from './lib/cli.js';
import { ARC_TESTNET_ID, LOCAL_CHAIN_ID, NETWORKS } from './lib/config.js';
import { summaryLines } from './lib/deployments.js';
import type { FlowResult } from './lib/flow.js';
import { formatDuration, formatTime, formatUsdc } from './lib/format.js';
import { runLocal } from './lib/local.js';
import { runTestnet } from './lib/testnet.js';

const USAGE = `usage:
  pnpm e2e:testnet [--wait] [--reset]
  pnpm e2e:dry-run [--port <n>] [--reset]
  tsx e2e-testnet.ts --rpc http://127.0.0.1:<port> [--reset]

The testnet run needs DripPool deployed and recorded (DEPLOY.md) and three Foundry keystores named by
WALLET1_ACCOUNT, WALLET2_ACCOUNT and WALLET3_ACCOUNT (password from KEYSTORE_PASSWORD_FILE /
WALLETn_PASSWORD_FILE, or a prompt). No private key is ever read from env or from the repository.`;

function outcome(flow: FlowResult): number {
  if (flow.status === 'done') {
    console.log(
      `\nDONE: pool ${flow.poolId} cancelled, ${flow.streamedWad} wad still owed to members ` +
        `(${formatUsdc(flow.outstanding)} claimable, contract holds ${formatUsdc(flow.held)})`,
    );
    return 0;
  }
  if (flow.status === 'paused') {
    console.log(
      `\nPAUSED at pool ${flow.poolId ?? '?'}: waiting for ${flow.what} until ${formatTime(flow.resumeAt)} ` +
        `(in ${formatDuration(flow.waitSeconds)}).`,
    );
    console.log('Resume with the same command, or keep a terminal waiting through it:');
    console.log('  pnpm e2e:testnet --wait');
    return 0;
  }
  console.error(`\nFAILED: ${flow.reason}`);
  return 1;
}

async function local(opts: ReturnType<typeof parseCli>): Promise<number> {
  const r = await runLocal({ rpc: opts.rpc, port: opts.port, reset: opts.reset });
  console.log(`\nTransactions (local anvil, chain ${LOCAL_CHAIN_ID}):`);
  for (const line of summaryLines(r.state, '')) console.log(line);
  console.log(`\nproofTxs written to ${r.deploymentsFile} (gitignored; never the testnet or mainnet file)`);
  console.log(
    'On Arc testnet the same flow waits out the stream and the freeze in real time, so `pnpm e2e:testnet` ' +
      'may pause and resume (DEPLOY.md).',
  );
  const code = outcome(r.flow);
  await r.anvil?.stop();
  if (r.anvil) console.log('anvil stopped');
  return code;
}

async function testnet(opts: ReturnType<typeof parseCli>): Promise<number> {
  const r = await runTestnet({ wait: opts.wait, reset: opts.reset });
  const lines = summaryLines(r.state, NETWORKS.testnet.explorer);
  if (lines.length) {
    console.log(`\nTransactions so far (chain ${ARC_TESTNET_ID}):`);
    for (const line of lines) console.log(line);
  }
  console.log(`\nproofTxs recorded in ${r.deploymentsFile}; run state in ${r.stateFile}`);
  return outcome(r.flow);
}

async function main(): Promise<number> {
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  return opts.local ? local(opts) : testnet(opts);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`e2e: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
