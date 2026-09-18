// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {BaseTest} from "./Base.t.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";

/// @dev withdrawUnstreamed and cancel: the two places where the owner touches money.
///      Both are bounded by `balance - ceilDiv(owed, 1e12)`, so earned funds are untouchable (I4).
contract DripPoolOwnerFundsTest is BaseTest {
    uint256 internal poolId;

    function setUp() public override {
        super.setUp();
        poolId = _standardPool();
    }

    // ------------------------------------------------------------------
    // withdrawUnstreamed
    // ------------------------------------------------------------------

    function test_WithdrawUnstreamed_SweepsFreeFunds() public {
        skip(400);

        vm.expectEmit(true, true, true, true, address(drip));
        emit UnstreamedWithdrawn(poolId, dave, 1000);
        vm.prank(owner);
        drip.withdrawUnstreamed(poolId, 1000, dave);

        assertEq(usdc.balanceOf(dave), 1000);
        assertEq(drip.getPool(poolId).balance, ONE_USDC - 1000);
    }

    function test_WithdrawUnstreamed_AtTheExactBound() public {
        skip(400);
        uint256 free = drip.unstreamed(poolId);
        assertEq(free, ONE_USDC - 400);

        vm.prank(owner);
        drip.withdrawUnstreamed(poolId, free, owner);
        assertEq(drip.unstreamed(poolId), 0);
        _assertSolvent(poolId);
    }

    function test_WithdrawUnstreamed_LeavesEveryMemberWhole() public {
        skip(400);
        uint256 free = drip.unstreamed(poolId);
        vm.prank(owner);
        drip.withdrawUnstreamed(poolId, free, owner);

        assertEq(drip.claimable(poolId, alice), 100);
        assertEq(drip.claimable(poolId, bob), 100);
        assertEq(drip.claimable(poolId, carol), 200);

        vm.prank(alice);
        drip.withdraw(poolId);
        drip.withdrawFor(poolId, bob);
        drip.withdrawFor(poolId, carol);
        assertEq(usdc.balanceOf(alice), 100);
        assertEq(usdc.balanceOf(carol), 200);
    }

    function test_WithdrawUnstreamed_CeilDivProtectsAFractionOfAUnit() public {
        // Rate of 1 unit + 1 wad per second: after 10 s owed is 10.00000000001 units, which members can
        // only claim as 10 whole units. ceilDiv still reserves 11, so the owner can never sweep the
        // fraction a member is owed.
        uint256 id = drip.createPool(owner, RATE + 1, 0, NAME);
        _setShares(id, alice, 1);
        _deposit(id, ONE_USDC);
        skip(10);

        assertEq(drip.claimable(id, alice), 10);
        assertEq(drip.unstreamed(id), ONE_USDC - 11, "ceilDiv rounds the members' claim up");

        vm.prank(owner);
        vm.expectRevert(IDripPool.InsufficientUnstreamed.selector);
        drip.withdrawUnstreamed(id, ONE_USDC - 10, owner);
    }

    function test_WithdrawUnstreamed_RevertsAboveBound() public {
        skip(400);
        vm.prank(owner);
        vm.expectRevert(IDripPool.InsufficientUnstreamed.selector);
        drip.withdrawUnstreamed(poolId, ONE_USDC - 399, owner);
    }

    function test_WithdrawUnstreamed_AccruesFirst() public {
        skip(400);
        vm.prank(owner);
        vm.expectRevert(IDripPool.InsufficientUnstreamed.selector);
        drip.withdrawUnstreamed(poolId, ONE_USDC, owner); // pre-accrual balance would have allowed it
    }

    function test_WithdrawUnstreamed_RevertsOnZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(IDripPool.ZeroAmount.selector);
        drip.withdrawUnstreamed(poolId, 0, owner);
    }

    function test_WithdrawUnstreamed_RevertsOnZeroRecipient() public {
        vm.prank(owner);
        vm.expectRevert(IDripPool.ZeroAddress.selector);
        drip.withdrawUnstreamed(poolId, 1, address(0));
    }

    function test_WithdrawUnstreamed_RevertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(IDripPool.NotOwner.selector);
        drip.withdrawUnstreamed(poolId, 1, stranger);
    }

    function test_WithdrawUnstreamed_RevertsWhenCancelled() public {
        vm.startPrank(owner);
        drip.cancel(poolId, owner);
        vm.expectRevert(IDripPool.PoolCancelled.selector);
        drip.withdrawUnstreamed(poolId, 1, owner);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // cancel
    // ------------------------------------------------------------------

    function test_Cancel_RefundsTheUnstreamedPart() public {
        skip(400);

        vm.expectEmit(true, true, true, true, address(drip));
        emit Cancelled(poolId, dave, ONE_USDC - 400);
        vm.prank(owner);
        assertEq(drip.cancel(poolId, dave), ONE_USDC - 400);

        IDripPool.Pool memory p = drip.getPool(poolId);
        assertTrue(p.cancelled);
        assertEq(p.ratePerSecond, 0);
        assertEq(p.balance, 400, "exactly what members are owed stays");
        assertEq(usdc.balanceOf(dave), ONE_USDC - 400);
    }

    /// @dev The rate is an accrual input, so an indexer replaying events must see it go to zero
    ///      (PRD 4.4). `cancel` therefore emits `RateSet(poolId, oldRate, 0)` before `Cancelled`.
    function test_Cancel_EmitsRateSetToZero() public {
        skip(400);

        vm.expectEmit(true, true, true, true, address(drip));
        emit RateSet(poolId, RATE, 0);
        vm.expectEmit(true, true, true, true, address(drip));
        emit Cancelled(poolId, dave, ONE_USDC - 400);
        vm.prank(owner);
        drip.cancel(poolId, dave);

        assertEq(drip.getPool(poolId).ratePerSecond, 0);
    }

    /// @dev A pool that was already paused has nothing to report: no redundant `RateSet`.
    function test_Cancel_EmitsNoRateSetWhenAlreadyPaused() public {
        skip(400);
        vm.startPrank(owner);
        drip.setRate(poolId, 0);

        vm.recordLogs();
        drip.cancel(poolId, owner);
        vm.stopPrank();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 rateSetTopic = keccak256("RateSet(uint256,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != rateSetTopic, "no RateSet when the rate was already 0");
        }
    }

    function test_Cancel_MembersKeepWithdrawingForever() public {
        skip(400);
        vm.prank(owner);
        drip.cancel(poolId, owner);
        skip(365 days);

        assertEq(drip.claimable(poolId, carol), 200, "frozen at the cancel timestamp");
        vm.prank(carol);
        assertEq(drip.withdraw(poolId), 200);
        assertEq(usdc.balanceOf(carol), 200);
    }

    function test_Cancel_WithNothingOwed() public {
        uint256 id = _createPool();
        _deposit(id, ONE_USDC);

        vm.prank(owner);
        assertEq(drip.cancel(id, owner), ONE_USDC);
        assertEq(drip.getPool(id).balance, 0);
    }

    function test_Cancel_WithZeroRefund() public {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _deposit(id, 100);
        skip(1000); // fully streamed

        vm.expectEmit(true, true, true, true, address(drip));
        emit Cancelled(id, owner, 0);
        vm.prank(owner);
        assertEq(drip.cancel(id, owner), 0);
        assertEq(usdc.balanceOf(owner), 0);
    }

    function test_Cancel_StopsAccrual() public {
        skip(400);
        vm.prank(owner);
        drip.cancel(poolId, owner);
        skip(400);
        assertEq(drip.claimable(poolId, alice), 100);
    }

    function test_Cancel_KeepsOwnershipTransferAvailable() public {
        vm.startPrank(owner);
        drip.cancel(poolId, owner);
        drip.transferPoolOwnership(poolId, dave);
        vm.stopPrank();

        vm.prank(dave);
        drip.acceptPoolOwnership(poolId);
        assertEq(drip.getPool(poolId).owner, dave);
    }

    function test_Cancel_RevertsOnZeroRecipient() public {
        vm.prank(owner);
        vm.expectRevert(IDripPool.ZeroAddress.selector);
        drip.cancel(poolId, address(0));
    }

    function test_Cancel_RevertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(IDripPool.NotOwner.selector);
        drip.cancel(poolId, stranger);
    }

    function test_Cancel_RevertsTwice() public {
        vm.startPrank(owner);
        drip.cancel(poolId, owner);
        vm.expectRevert(IDripPool.PoolCancelled.selector);
        drip.cancel(poolId, owner);
        vm.stopPrank();
    }
}
