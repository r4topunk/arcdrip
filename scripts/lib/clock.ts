// Waiting for a chain timestamp. The same flow runs on two clocks:
// - RealClock (testnet): sleeps until the latest block timestamp reaches the target. A wait longer than
//   `maxWaitSeconds` is not slept through: the run pauses (state is on disk) and the operator re-runs later.
// - AnvilClock (local): jumps chain time with anvil_setNextBlockTimestamp + evm_mine instead of waiting.
import type { PublicClient, TestClient } from 'viem';
import { formatDuration, formatTime } from './format.js';

export type WaitResult = { ready: true } | { ready: false; resumeAt: number };

export interface Clock {
  /** Latest block timestamp, in unix seconds. */
  chainNow(): Promise<number>;
  /** Resolves once a block with timestamp >= `unixSeconds` exists, or reports when to resume. */
  waitUntil(unixSeconds: number, what: string): Promise<WaitResult>;
  /** True when time can be jumped (a local anvil), which the flow prints instead of "waiting". */
  readonly instant: boolean;
}

async function latestTimestamp(client: PublicClient): Promise<number> {
  const block = await client.getBlock({ blockTag: 'latest' });
  return Number(block.timestamp);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Arc makes a block about every 0.5 s; five minutes without one means the RPC or the chain is stuck. */
const STALL_MS = 5 * 60_000;

export interface RealClockOptions {
  /** Longest wait slept through inline; longer waits pause the run. Infinity = always wait. */
  maxWaitSeconds: number;
  /** Progress line printer. */
  say?: (line: string) => void;
  /** Injectable for tests. */
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class RealClock implements Clock {
  readonly instant = false;

  constructor(
    private readonly client: PublicClient,
    private readonly options: RealClockOptions,
  ) {}

  chainNow(): Promise<number> {
    return latestTimestamp(this.client);
  }

  async waitUntil(unixSeconds: number, what: string): Promise<WaitResult> {
    const nowMs = this.options.nowMs ?? Date.now;
    const sleep = this.options.sleep ?? realSleep;
    let chain = await this.chainNow();
    if (chain >= unixSeconds) return { ready: true };
    // The chain's own clock decides (the contract reads block.timestamp); on Arc it tracks the wall clock.
    if (unixSeconds - chain > this.options.maxWaitSeconds) return { ready: false, resumeAt: unixSeconds };

    this.options.say?.(
      `waiting ${formatDuration(unixSeconds - chain)} for ${what} (until ${formatTime(unixSeconds)})`,
    );
    let progressAt = nowMs();
    for (;;) {
      // Slices of at most a minute, so a long wait keeps printing progress.
      await sleep(Math.min(Math.max(unixSeconds - chain, 1) * 1_000, 60_000));
      const next = await this.chainNow();
      if (next >= unixSeconds) return { ready: true };
      if (next > chain) progressAt = nowMs();
      else if (nowMs() - progressAt > STALL_MS) {
        throw new Error(
          `the chain produced no block for ${STALL_MS / 60_000} minutes while waiting for ${what}`,
        );
      }
      chain = next;
      if (unixSeconds - chain > 60) this.options.say?.(`  ${formatDuration(unixSeconds - chain)} left`);
    }
  }
}

export class AnvilClock implements Clock {
  readonly instant = true;

  constructor(
    private readonly client: PublicClient,
    private readonly test: TestClient,
  ) {}

  chainNow(): Promise<number> {
    return latestTimestamp(this.client);
  }

  async waitUntil(unixSeconds: number): Promise<WaitResult> {
    if ((await this.chainNow()) < unixSeconds) {
      await this.test.setNextBlockTimestamp({ timestamp: BigInt(unixSeconds) });
      await this.test.mine({ blocks: 1 });
    }
    return { ready: true };
  }
}
