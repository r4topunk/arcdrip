// Chain, token and accounting constants. The scales mirror DripPool (PRD 4.1) exactly: every internal amount
// the SDK computes is in `wad` (USDC units x 1e12, i.e. 18 decimals) and every public amount is in USDC units
// (1e-6 USDC), because that is what the contract transfers.

/** Arc mainnet chain id. */
export const ARC_MAINNET_CHAIN_ID = 5042 as const;
/** Arc testnet chain id. */
export const ARC_TESTNET_CHAIN_ID = 5042002 as const;

/** Chain ids the SDK knows about. */
export const ARC_CHAIN_IDS = [ARC_MAINNET_CHAIN_ID, ARC_TESTNET_CHAIN_ID] as const;
export type ArcChainId = (typeof ARC_CHAIN_IDS)[number];

/** Public RPC endpoints. `eth_getLogs` is capped at 10,000 blocks per call on both (PRD 9). */
export const ARC_RPC_URLS: Readonly<Record<ArcChainId, string>> = {
  [ARC_MAINNET_CHAIN_ID]: 'https://rpc.mainnet.arc.io',
  [ARC_TESTNET_CHAIN_ID]: 'https://rpc.testnet.arc.io',
};

/** Block explorer, same host for both networks. */
export const ARC_EXPLORER_URL = 'https://explorer.arc.io' as const;

/** Largest `eth_getLogs` range the public RPCs accept, in blocks. */
export const MAX_LOG_RANGE_BLOCKS = 10_000n;

/** Native USDC on Arc, exposed as an ERC-20 at a fixed address on both networks. */
export const USDC_ADDRESS = '0x3600000000000000000000000000000000000000' as const;
/** USDC decimals on Arc. */
export const USDC_DECIMALS = 6 as const;

/**
 * Deployed `DripPool` singleton per chain. `null` until the deployment is recorded in
 * `deployments/arc-{mainnet,testnet}.json`; keep both in sync with those files.
 */
export const DRIP_POOL_ADDRESS: Readonly<Record<ArcChainId, `0x${string}` | null>> = {
  [ARC_MAINNET_CHAIN_ID]: null,
  [ARC_TESTNET_CHAIN_ID]: null,
};

/** 1 USDC unit (1e-6 USDC) expressed in wad. All internal amounts are wad. */
export const WAD_PER_UNIT = 1_000_000_000_000n; // 1e12
/** Fixed-point scale of `accIndex` (wad per share, scaled). */
export const INDEX_SCALE = 1_000_000_000_000_000_000n; // 1e18
/** Largest `ratePerSecond` the contract accepts, in wad/s (= 1e12 USDC/s). Overflow guard. */
export const MAX_RATE = 10n ** 30n;
/** Largest share count for a single member. */
export const MAX_SHARES = 10n ** 15n;
/** Largest `totalShares` for a pool; keeps per-accrual dust below 1 wad. */
export const MAX_TOTAL_SHARES = 10n ** 18n;
/** Largest number of entries accepted by `setSharesBatch` / `withdrawForBatch`. */
export const MAX_BATCH = 100;

/** `type(uint64).max`: what `fundedUntil` returns when a pool can never run dry (rate or shares are 0). */
export const MAX_UINT64 = 2n ** 64n - 1n;
/** `type(uint128).max`. */
export const MAX_UINT128 = 2n ** 128n - 1n;
/** `type(uint256).max`. */
export const MAX_UINT256 = 2n ** 256n - 1n;

/** Sentinel returned by `runwaySeconds` when the stream is not consuming funds (rate or shares are 0). */
export const UNBOUNDED_RUNWAY = MAX_UINT64;
