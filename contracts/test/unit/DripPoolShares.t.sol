// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";

contract DripPoolSharesTest is BaseTest {
    uint256 internal poolId;

    function setUp() public override {
        super.setUp();
        poolId = _createPool();
    }

    // ------------------------------------------------------------------
    // setShares
    // ------------------------------------------------------------------

    function test_SetShares_AddsMember() public {
        vm.expectEmit(true, true, true, true, address(drip));
        emit SharesSet(poolId, alice, 0, 3, 3);
        _setShares(poolId, alice, 3);

        assertEq(drip.getMember(poolId, alice).shares, 3);
        assertEq(drip.getPool(poolId).totalShares, 3);
    }

    function test_SetShares_UpdatesTotal() public {
        _setShares(poolId, alice, 3);
        _setShares(poolId, bob, 2);
        assertEq(drip.getPool(poolId).totalShares, 5);

        _setShares(poolId, alice, 1);
        assertEq(drip.getPool(poolId).totalShares, 3);
    }

    function test_SetShares_JoinMidStreamDoesNotBackPay() public {
        _setShares(poolId, alice, 1);
        _deposit(poolId, ONE_USDC);
        skip(100);

        _setShares(poolId, bob, 1); // joins at t+100
        assertEq(drip.claimable(poolId, alice), 100);
        assertEq(drip.claimable(poolId, bob), 0, "no retroactive accrual");

        skip(100);
        assertEq(drip.claimable(poolId, alice), 150);
        assertEq(drip.claimable(poolId, bob), 50);
    }

    function test_SetShares_LeaveMidStreamKeepsAccrued() public {
        _setShares(poolId, alice, 1);
        _setShares(poolId, bob, 1);
        _deposit(poolId, ONE_USDC);
        skip(200);

        _setShares(poolId, bob, 0); // removed
        assertEq(drip.claimable(poolId, bob), 100, "accrued stays");

        skip(200);
        assertEq(drip.claimable(poolId, bob), 100, "no further accrual");
        assertEq(drip.claimable(poolId, alice), 300, "alice now takes the whole rate");

        vm.prank(bob);
        assertEq(drip.withdraw(poolId), 100);
    }

    function test_SetShares_ReWeightRepricesFromThatSecond() public {
        _setShares(poolId, alice, 1);
        _setShares(poolId, bob, 1);
        _deposit(poolId, ONE_USDC);
        skip(100);

        _setShares(poolId, alice, 3); // alice 3 / bob 1
        skip(100);

        assertEq(drip.claimable(poolId, alice), 50 + 75);
        assertEq(drip.claimable(poolId, bob), 50 + 25);
    }

    function test_SetShares_DoesNotTouchOtherMembersStorage() public {
        _setShares(poolId, alice, 1);
        _setShares(poolId, bob, 1);
        _deposit(poolId, ONE_USDC);
        skip(100);

        IDripPool.Member memory before = drip.getMember(poolId, bob);
        _setShares(poolId, alice, 5);
        IDripPool.Member memory afterM = drip.getMember(poolId, bob);

        assertEq(before.index, afterM.index, "bob's index untouched");
        assertEq(before.pending, afterM.pending, "bob's pending untouched");
        assertEq(drip.claimable(poolId, bob), 50, "bob's claimable unchanged (I4)");
    }

    function test_SetShares_WhileFrozen() public {
        _setShares(poolId, alice, 1);
        _deposit(poolId, 100);
        skip(1000); // frozen at t+100

        _setShares(poolId, bob, 1);
        assertEq(drip.claimable(poolId, alice), 100);
        assertEq(drip.claimable(poolId, bob), 0);

        _deposit(poolId, 100);
        skip(100);
        assertEq(drip.claimable(poolId, alice), 150);
        assertEq(drip.claimable(poolId, bob), 50);
    }

    function test_SetShares_ZeroTotalSharesConsumesNothing() public {
        _deposit(poolId, ONE_USDC);
        skip(1000); // no members at all

        assertEq(drip.getPool(poolId).owed, 0, "money never streams into the void");
        assertEq(drip.unstreamed(poolId), ONE_USDC);

        _setShares(poolId, alice, 1);
        skip(100);
        assertEq(drip.claimable(poolId, alice), 100, "no back-pay for the empty period");
    }

    function test_SetShares_AllMembersLeaveThenReturn() public {
        _setShares(poolId, alice, 1);
        _deposit(poolId, ONE_USDC);
        skip(100);
        _setShares(poolId, alice, 0); // totalShares back to 0
        skip(10_000);

        assertEq(drip.getPool(poolId).owed, 100 * WAD, "nothing streamed while empty");
        _setShares(poolId, alice, 1);
        skip(100);
        assertEq(drip.claimable(poolId, alice), 200);
    }

    function test_SetShares_MaxSharesAllowed() public {
        _setShares(poolId, alice, uint128(drip.MAX_SHARES()));
        assertEq(drip.getPool(poolId).totalShares, uint128(drip.MAX_SHARES()));
    }

    function test_SetShares_RevertsAboveMaxShares() public {
        uint128 tooMany = uint128(drip.MAX_SHARES() + 1);
        vm.prank(owner);
        vm.expectRevert(IDripPool.BadShares.selector);
        drip.setShares(poolId, alice, tooMany);
    }

    function test_SetShares_RevertsOnZeroMember() public {
        vm.prank(owner);
        vm.expectRevert(IDripPool.ZeroAddress.selector);
        drip.setShares(poolId, address(0), 1);
    }

    function test_SetShares_RevertsOnNoOp() public {
        _setShares(poolId, alice, 2);
        vm.prank(owner);
        vm.expectRevert(IDripPool.NoOp.selector);
        drip.setShares(poolId, alice, 2);
    }

    function test_SetShares_RevertsOnNoOpForUnknownMember() public {
        vm.prank(owner);
        vm.expectRevert(IDripPool.NoOp.selector);
        drip.setShares(poolId, alice, 0);
    }

    function test_SetShares_RevertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(IDripPool.NotOwner.selector);
        drip.setShares(poolId, alice, 1);
    }

    function test_SetShares_RevertsWhenCancelled() public {
        vm.startPrank(owner);
        drip.cancel(poolId, owner);
        vm.expectRevert(IDripPool.PoolCancelled.selector);
        drip.setShares(poolId, alice, 1);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // setSharesBatch
    // ------------------------------------------------------------------

    function test_SetSharesBatch_SetsAll() public {
        (address[] memory ms, uint128[] memory ss) = _three(1, 1, 2);
        vm.prank(owner);
        drip.setSharesBatch(poolId, ms, ss);

        assertEq(drip.getPool(poolId).totalShares, 4);
        assertEq(drip.getMember(poolId, carol).shares, 2);
    }

    function test_SetSharesBatch_SingleAccrual() public {
        _setShares(poolId, alice, 1);
        _deposit(poolId, ONE_USDC);
        skip(100);

        (address[] memory ms, uint128[] memory ss) = _three(1, 1, 2);
        vm.prank(owner);
        drip.setSharesBatch(poolId, ms, ss);

        assertEq(drip.getPool(poolId).owed, 100 * WAD);
        assertEq(drip.getPool(poolId).lastAccrual, uint64(block.timestamp));
        assertEq(drip.claimable(poolId, alice), 100);
    }

    function test_SetSharesBatch_DuplicatesLastWins() public {
        address[] memory ms = new address[](3);
        uint128[] memory ss = new uint128[](3);
        ms[0] = alice;
        ms[1] = alice;
        ms[2] = alice;
        ss[0] = 1;
        ss[1] = 5;
        ss[2] = 9;

        vm.prank(owner);
        drip.setSharesBatch(poolId, ms, ss);

        assertEq(drip.getMember(poolId, alice).shares, 9);
        assertEq(drip.getPool(poolId).totalShares, 9, "total tracks the last value only");
    }

    function test_SetSharesBatch_SkipsUnchangedSilently() public {
        _setShares(poolId, alice, 1);

        address[] memory ms = new address[](2);
        uint128[] memory ss = new uint128[](2);
        ms[0] = alice;
        ss[0] = 1; // unchanged: skipped, no NoOp revert
        ms[1] = bob;
        ss[1] = 4;

        vm.prank(owner);
        drip.setSharesBatch(poolId, ms, ss);
        assertEq(drip.getPool(poolId).totalShares, 5);
    }

    function test_SetSharesBatch_EmptyIsNoop() public {
        vm.prank(owner);
        drip.setSharesBatch(poolId, new address[](0), new uint128[](0));
        assertEq(drip.getPool(poolId).totalShares, 0);
    }

    function test_SetSharesBatch_MaxBatch() public {
        uint256 n = drip.MAX_BATCH();
        address[] memory ms = new address[](n);
        uint128[] memory ss = new uint128[](n);
        for (uint256 i; i < n; ++i) {
            // casting to uint160 is safe because these are small synthetic test addresses
            // forge-lint: disable-next-line(unsafe-typecast)
            ms[i] = address(uint160(1000 + i));
            ss[i] = 1;
        }
        vm.prank(owner);
        drip.setSharesBatch(poolId, ms, ss);
        assertEq(drip.getPool(poolId).totalShares, n);
    }

    function test_SetSharesBatch_RevertsOnLengthMismatch() public {
        vm.prank(owner);
        vm.expectRevert(IDripPool.LengthMismatch.selector);
        drip.setSharesBatch(poolId, new address[](2), new uint128[](1));
    }

    function test_SetSharesBatch_RevertsAboveMaxBatch() public {
        uint256 n = drip.MAX_BATCH() + 1;
        vm.prank(owner);
        vm.expectRevert(IDripPool.TooManyItems.selector);
        drip.setSharesBatch(poolId, new address[](n), new uint128[](n));
    }

    function test_SetSharesBatch_RevertsOnZeroMember() public {
        address[] memory ms = new address[](1);
        uint128[] memory ss = new uint128[](1);
        ss[0] = 1;
        vm.prank(owner);
        vm.expectRevert(IDripPool.ZeroAddress.selector);
        drip.setSharesBatch(poolId, ms, ss);
    }

    function test_SetSharesBatch_RevertsAboveMaxShares() public {
        address[] memory ms = new address[](1);
        uint128[] memory ss = new uint128[](1);
        ms[0] = alice;
        ss[0] = uint128(drip.MAX_SHARES() + 1);
        vm.prank(owner); // the MAX_SHARES() read above must happen before the prank
        vm.expectRevert(IDripPool.BadShares.selector);
        drip.setSharesBatch(poolId, ms, ss);
    }

    function test_SetSharesBatch_RevertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(IDripPool.NotOwner.selector);
        drip.setSharesBatch(poolId, new address[](0), new uint128[](0));
    }

    function test_SetSharesBatch_RevertsWhenCancelled() public {
        vm.startPrank(owner);
        drip.cancel(poolId, owner);
        vm.expectRevert(IDripPool.PoolCancelled.selector);
        drip.setSharesBatch(poolId, new address[](0), new uint128[](0));
        vm.stopPrank();
    }

    function _three(uint128 a, uint128 b, uint128 c) internal view returns (address[] memory ms, uint128[] memory ss) {
        ms = new address[](3);
        ss = new uint128[](3);
        ms[0] = alice;
        ms[1] = bob;
        ms[2] = carol;
        ss[0] = a;
        ss[1] = b;
        ss[2] = c;
    }
}
