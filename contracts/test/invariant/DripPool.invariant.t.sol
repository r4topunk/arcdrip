// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {DripPool} from "../../src/DripPool.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {DripPoolHandler} from "./DripPoolHandler.sol";

/// @notice PRD 4.5 I1-I4, checked on a handler campaign with six actors and three pools (PRD 4.5 asks for
///         >= 5 and >= 3). Runs and depth come from `foundry.toml` (`invariant.runs = 256`, `depth = 100`).
///
///         The three pools differ where the accrual paths differ: pool 1 streams immediately, pool 2 starts in
///         the future (the `startTime` branch of `_from`), pool 3 starts paused at rate 0 and can be cancelled.
///
/// forge-config: default.invariant.fail-on-revert = true
contract DripPoolInvariantTest is Test {
    uint256 internal constant WAD = 1e12;
    uint256 internal constant INDEX_SCALE = 1e18;
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant POOLS = 3;

    MockUSDC internal usdc;
    DripPool internal drip;
    DripPoolHandler internal handler;

    function setUp() public {
        vm.warp(T0);
        usdc = new MockUSDC();
        drip = new DripPool(address(usdc));

        address[] memory actors = new address[](6);
        for (uint256 i; i < actors.length; ++i) {
            actors[i] = makeAddr(string.concat("inv-actor-", vm.toString(i)));
        }
        handler = new DripPoolHandler(drip, usdc, actors);

        // Pools are owned by the handler, which rotates ownership through the actors and back.
        drip.createPool(address(handler), 1e12, 0, "streaming now");
        drip.createPool(address(handler), 5e11, uint64(block.timestamp + 3 days), "starts later");
        drip.createPool(address(handler), 0, 0, "starts paused");

        targetContract(address(handler));
    }

    // ------------------------------------------------------------------
    // Invariants
    // ------------------------------------------------------------------

    /// @notice I1: members can never collectively claim more than the pool owes, and the gap (dust left behind
    ///         by the flooring) stays inside the budget of one wad per accrual and one wad per settle.
    function invariant_I1_owedCoversEveryMember() public view {
        uint256 n = handler.actorCount();
        for (uint256 poolId = 1; poolId <= POOLS; ++poolId) {
            (uint256 accIndex, uint256 owed) = _simulate(poolId);
            uint256 sum;
            for (uint256 i; i < n; ++i) {
                sum += _entitlement(poolId, handler.actors(i), accIndex);
            }
            assertLe(sum, owed, "I1: members claim more than the pool owes");

            // +n+1: the floors this very check performs (one simulated accrual, one settle per member).
            uint256 budget = handler.ghostAccruals(poolId) + handler.ghostSettles(poolId) + n + 1;
            assertLe(owed - sum, budget, "I1: dust exceeds the flooring budget");
        }
    }

    /// @notice I2: a pool never owes more than it holds. This is what makes insolvency impossible (PRD D3).
    function invariant_I2_owedWithinBalance() public view {
        for (uint256 poolId = 1; poolId <= POOLS; ++poolId) {
            IDripPool.Pool memory p = drip.getPool(poolId);
            assertLe(p.owed, p.balance * WAD, "I2: stored owed exceeds balance");
            (, uint256 owed) = _simulate(poolId);
            assertLe(owed, p.balance * WAD, "I2: simulated owed exceeds balance");
        }
    }

    /// @notice I3: the pools' accounted balances are backed by real tokens. Direct donations make it a strict
    ///         `<` (PRD 7: they are ignored by the accounting and unrecoverable).
    function invariant_I3_backedByTokens() public view {
        uint256 sum;
        for (uint256 poolId = 1; poolId <= POOLS; ++poolId) {
            sum += drip.getPool(poolId).balance;
        }
        assertLe(sum, usdc.balanceOf(address(drip)), "I3: accounted balance exceeds the token balance");
    }

    /// @notice I4: no owner action ever reduces a member's claimable. Checked inside the handler, before and
    ///         after every `setRate`, `setShares`, `setSharesBatch`, `withdrawUnstreamed`, `cancel` and
    ///         ownership transfer, at a fixed timestamp.
    function invariant_I4_ownerNeverReducesClaimable() public view {
        assertFalse(handler.ghostClaimableDecreased(), "I4: an owner action reduced a member's claimable");
    }

    /// @notice The campaign is only meaningful if it actually moved money; a guard that silently returned on
    ///         every action would satisfy I1-I4 vacuously.
    function afterInvariant() public view {
        assertGt(handler.totalCalls(), 0, "no handler calls");
        console.log(
            "calls %s deposits %s withdrawals %s", handler.totalCalls(), handler.deposits(), handler.withdrawals()
        );
        console.log(
            "batches %s skipped %s cancels %s", handler.batches(), handler.skippedWithdrawals(), handler.cancels()
        );
        console.log("units paid to members %s", handler.paidUnits());
    }

    // ------------------------------------------------------------------
    // Helpers (PRD 4.2, reimplemented read-only)
    // ------------------------------------------------------------------

    function _simulate(uint256 poolId) internal view returns (uint256 accIndex, uint256 owed) {
        IDripPool.Pool memory p = drip.getPool(poolId);
        (accIndex, owed) = (p.accIndex, p.owed);
        uint256 from = p.lastAccrual > p.startTime ? p.lastAccrual : p.startTime;
        if (block.timestamp > from && p.ratePerSecond > 0 && p.totalShares > 0) {
            uint256 available = p.balance * WAD - owed;
            uint256 dt = block.timestamp - from;
            uint256 funded = available / p.ratePerSecond;
            if (funded < dt) dt = funded;
            uint256 streamed = uint256(p.ratePerSecond) * dt;
            accIndex += (streamed * INDEX_SCALE) / p.totalShares;
            owed += streamed;
        }
    }

    function _entitlement(uint256 poolId, address member, uint256 accIndex) internal view returns (uint256) {
        IDripPool.Member memory m = drip.getMember(poolId, member);
        return m.pending + (uint256(m.shares) * (accIndex - m.index)) / INDEX_SCALE;
    }
}
