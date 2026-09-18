# CCTP on Arc — finding and what SharedArc does with it

Research date: **2026-09-18**. Question from PRD §14: *does Bridge Kit / CCTP support Arc mainnet (chain 5042) as a
**source** chain today?*

**Answer: yes.** CCTP V2 is deployed on Arc mainnet and Arc is a burn (source) chain, not only a mint destination.
So `packages/sdk/src/bridge.ts` is in scope (PRD §2.2) and ships.

## What was verified, and how

Not from docs alone — every line below was read from Arc mainnet over `https://rpc.mainnet.arc.io`
(`eth_chainId` → `0x13b2` = 5042).

| Contract | Address on Arc mainnet | Evidence |
|---|---|---|
| `TokenMessengerV2` | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | has code; `messageBodyVersion() == 1` (V2); `localMinter()` and `localMessageTransmitter()` both resolve |
| `MessageTransmitterV2` | `0x81d40f21f12a8f0e3252bccb954d722d4c464b64` | `localDomain() == 26`, `version() == 1` |
| `TokenMinterV2` | `0xfd78ee919681417d192449715b2594ab58f5d002` | `burnLimitsPerMessage(0x3600…0000) == 10_000_000_000_000` units = 10,000,000 USDC |

- The implementation behind the `TokenMessengerV2` proxy (slot `0x3608…8bbc` → `0x1ccafdffbc1b7b5c499c97322f961b7d929a41b4`)
  contains the selectors `0x8e0250ee` (`depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)`) and
  `0x779b432d` (`depositForBurnWithHook(...)`). Burning **from** Arc is therefore live, not just minting into Arc.
- The burn token is the same native USDC ERC-20 view SharedArc uses, `0x3600000000000000000000000000000000000000`, and it
  has a non-zero per-message burn limit — the check that would be zero if Arc were mint-only.
- **Arc CCTP domain: 26**, on mainnet *and* testnet (both `MessageTransmitterV2.localDomain()` return 26). Arc testnet
  (chain 5042002) carries `TokenMessengerV2` at `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` and
  `MessageTransmitterV2` at `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275`.
- Circle's CCTP V2 mainnet contract table lists Arc among its chains, which matches what the chain reports.

## What the SDK implements

`bridge.ts`, and nothing on-chain. Decision **D6** stands: `DripPool.sol` has no bridge in its audit surface. The
bridge leg is two or three ordinary transactions from the member's own wallet.

- `withdrawAndBridge(config, poolId, { destination, recipient, ... })` — `withdraw()` from the pool, then burn
  **exactly what the withdrawal reported**, never an amount the caller guessed. If the withdrawal yields nothing, the
  contract's own `NothingToWithdraw` comes back and nothing is bridged.
- `bridgeUsdc(config, params)` — approve (only when the allowance is short) + `depositForBurn`.
- `buildDepositForBurn(params)` — pure, so the exact arguments can be asserted in a test without a network.
- `CCTP_DOMAINS`, `CCTP_TOKEN_MESSENGER`, `CCTP_MESSAGE_TRANSMITTER`, `FINALITY_THRESHOLD` (`fast` = 1000 with a
  `maxFee`, `standard` = 2000 with none).

## What the SDK deliberately does not do

- **It does not fetch or submit the attestation.** After the burn, Circle's Iris service attests the message and
  someone calls `receiveMessage` on the destination chain. That is the destination chain's business; Circle's own
  Bridge Kit does it better than a payroll SDK would, and pulling `@circle-fin/bridge-kit` in would add a dependency
  to every consumer of `@sharedarc/sdk` for a leg most of them never use.
- **It does not encode non-EVM recipients.** Solana, Sui, Aptos and Noble have CCTP domains, but their
  `mintRecipient` is not a padded EVM address. `CCTP_DOMAINS` lists EVM chains only; any `uint32` domain is still
  accepted by the functions, so a caller who knows what they are doing is not blocked.
- **No hook.** `depositForBurnWithHook` exists on Arc, but v1 has no use for a post-transfer hook.

## Open points

- The mainnet addresses above are recorded as constants. If Circle redeploys, `tokenMessenger` can be overridden per
  call; the constants are asserted in `packages/sdk/test/bridge.test.ts` so a change is loud, not silent.
- Fast transfers charge a fee that Circle quotes off-chain. The SDK requires `maxFee > 0` for `speed: 'fast'` and
  refuses a fee at or above the amount, but it does not fetch the quote.
- Nothing in this file has been exercised against Arc mainnet with real funds. The encoding is unit-tested; the burn
  itself is a human step, and it is not part of the §10.2 proof checklist.
