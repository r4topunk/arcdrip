// Command-line flags of e2e-testnet.ts.
import { parseArgs } from 'node:util';

export interface CliOptions {
  help: boolean;
  /** Run against a local anvil: start one (`--dry-run`) or use the one at `--rpc`. */
  local: boolean;
  /** An already-running local anvil (chain 31337). Implies the local run. */
  rpc: string | undefined;
  /** Port for the anvil a dry run starts. */
  port: number | undefined;
  /** Sleep through every wait instead of pausing (testnet only). */
  wait: boolean;
  /** Archive the run state and start a new pool. */
  reset: boolean;
}

/** Parses the flags; throws on unknown flags and on flags that do not apply to the chosen mode. */
export function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    // pnpm may forward a literal "--" separator
    args: argv.filter((a) => a !== '--'),
    options: {
      'dry-run': { type: 'boolean', default: false },
      rpc: { type: 'string' },
      port: { type: 'string' },
      wait: { type: 'boolean', default: false },
      reset: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const local = values['dry-run'] || values.rpc !== undefined;
  if (values.rpc !== undefined && values['dry-run']) {
    throw new Error('pass --dry-run (start an anvil) or --rpc <url> (use a running one), not both');
  }
  if (!local && (values.port !== undefined || values.rpc !== undefined)) {
    throw new Error('--port and --rpc only apply to a local run');
  }
  if (local && values.wait)
    throw new Error('--wait only applies to the testnet run (a local run jumps time)');
  if (
    values.rpc !== undefined &&
    !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(values.rpc)
  ) {
    throw new Error(`--rpc must point at a local anvil (http://127.0.0.1:<port>), got ${values.rpc}`);
  }
  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error(`invalid --port ${values.port}`);
  }
  return {
    help: values.help,
    local,
    rpc: values.rpc,
    port,
    wait: values.wait,
    reset: values.reset,
  };
}
