// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";

contract DripPoolViewsTest is BaseTest {
    uint256 internal poolId;

    function setUp() public override {
        super.setUp();
        poolId = _standardPool(); // 1 unit/s, 1 USDC funded -> 1e6 s of runway
    }

    // ------------------------------------------------------------------
    // claimable
    // ------------------------------------------------------------------

    function test_Claimable_MatchesWithdraw() public {
        skip(4321);
        uint256 expected = drip.claimable(poolId, carol);
        vm.prank(carol);
        assertEq(drip.withdraw(poolId), expected);
    }

    function test_Claimable_FloorsToWholeUnits() public {
        skip(3); // 0.75 units for a 1-share member
        assertEq(drip.claimable(poolId, alice), 0);
        skip(1);
        assertEq(drip.claimable(poolId, alice), 1);
    }

    function test_Claimable_IsZeroForNonMember() public {
        skip(400);
        assertEq(drip.claimable(poolId, stranger), 0);
    }

    function test_Claimable_StopsGrowingAtTheFreeze() public {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _deposit(id, 100);

        skip(50);
        assertEq(drip.claimable(id, alice), 50);
        skip(50);
        assertEq(drip.claimable(id, alice), 100);
        skip(1_000_000);
        assertEq(drip.claimable(id, alice), 100, "frozen");
    }

    function test_Claimable_IncludesWithdrawnRemainder() public {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _setShares(id, bob, 2);
        _deposit(id, ONE_USDC);

        skip(10);
        vm.prank(alice);
        drip.withdraw(id); // 3 units, 0.333 unit stays pending
        skip(2); // + 0.666 unit -> 0.999, still below one unit
        assertEq(drip.claimable(id, alice), 0);
        skip(1);
        assertEq(drip.claimable(id, alice), 1);
    }

    // ------------------------------------------------------------------
    // fundedUntil / unstreamed
    // ------------------------------------------------------------------

    function test_FundedUntil_IsNowPlusRunway() public view {
        assertEq(drip.fundedUntil(poolId), uint64(block.timestamp + 1_000_000));
    }

    function test_FundedUntil_ShrinksWithTime() public {
        uint64 end = drip.fundedUntil(poolId);
        skip(1000);
        assertEq(drip.fundedUntil(poolId), end, "the freeze timestamp itself does not move");
    }

    function test_FundedUntil_GrowsWithDeposits() public {
        uint64 before = drip.fundedUntil(poolId);
        _deposit(poolId, ONE_USDC);
        assertEq(drip.fundedUntil(poolId), before + 1_000_000);
    }

    function test_FundedUntil_MaxWhenPaused() public {
        _setRate(poolId, 0);
        assertEq(drip.fundedUntil(poolId), type(uint64).max);
    }

    function test_FundedUntil_MaxWithoutShares() public {
        uint256 id = _createPool();
        _deposit(id, ONE_USDC);
        assertEq(drip.fundedUntil(id), type(uint64).max);
    }

    function test_FundedUntil_IsNowWhenFrozen() public {
        skip(1_000_000);
        assertEq(drip.fundedUntil(poolId), uint64(block.timestamp), "already dry");
        skip(1000);
        assertEq(drip.fundedUntil(poolId), uint64(block.timestamp));
    }

    function test_FundedUntil_RespectsFutureStartTime() public {
        uint64 start = uint64(block.timestamp + 1000);
        uint256 id = drip.createPool(owner, RATE, start, NAME);
        _setShares(id, alice, 1);
        _deposit(id, 100);

        assertEq(drip.fundedUntil(id), start + 100, "the runway starts at startTime");
    }

    function test_FundedUntil_SaturatesAtUint64Max() public {
        uint256 id = drip.createPool(owner, 1, 0, NAME); // 1 wad/s
        _setShares(id, alice, 1);
        _deposit(id, 1_000_000 * ONE_USDC); // 1e18 s of runway
        assertEq(drip.fundedUntil(id), type(uint64).max);
    }

    function test_Unstreamed_TracksTheFreeBalance() public {
        assertEq(drip.unstreamed(poolId), ONE_USDC);
        skip(400);
        assertEq(drip.unstreamed(poolId), ONE_USDC - 400);
        skip(1_000_000);
        assertEq(drip.unstreamed(poolId), 0, "everything is owed once dry");
    }

    function test_Unstreamed_IgnoresPausedTime() public {
        _setRate(poolId, 0);
        skip(10_000);
        assertEq(drip.unstreamed(poolId), ONE_USDC);
    }

    // ------------------------------------------------------------------
    // getPool / getMember
    // ------------------------------------------------------------------

    function test_GetMember_DefaultsToEmpty() public view {
        IDripPool.Member memory m = drip.getMember(poolId, stranger);
        assertEq(m.shares, 0);
        assertEq(m.payout, address(0));
        assertEq(m.index, 0);
        assertEq(m.pending, 0);
    }

    function test_GetPool_ReflectsAccrualAfterAWrite() public {
        skip(400);
        assertEq(drip.getPool(poolId).owed, 0, "views of stored state are not simulated");

        drip.withdrawForBatch(poolId, new address[](0)); // any call accrues
        assertEq(drip.getPool(poolId).owed, 400 * WAD);
        assertEq(drip.getPool(poolId).lastAccrual, uint64(block.timestamp));
    }
}
