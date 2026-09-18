// @sharedarc/sdk — public entry point (PRD 5).
//
//   constants.ts  chain ids, USDC, DripPool addresses, scales
//   schemas.ts    Zod, bigint-safe parsing of pools, members and events
//   math.ts       the offchain accrual mirror: claimable, runway, status, previews
//   rate.ts       "1000 USDC / month" <-> wad per second
//   actions.ts    viem reads and writes (simulate first, custom errors decoded into typed results)
//   members.ts    member discovery from SharesSet logs, chunked at 10,000 blocks + one multicall
//   bridge.ts     optional CCTP V2 leg: withdraw on Arc, burn, mint elsewhere
//   logger.ts     pino with a correlationId per action
//   abi/          generated from the Foundry artifact; `pnpm sdk:check-abi` keeps it honest
export const SDK_NAME = '@sharedarc/sdk' as const;

export * from './abi/DripPool.js';
export * from './actions.js';
export * from './bridge.js';
export * from './constants.js';
export * from './erc20.js';
export * from './errors.js';
export * from './logger.js';
export * from './math.js';
export * from './members.js';
export * from './rate.js';
export * from './schemas.js';
