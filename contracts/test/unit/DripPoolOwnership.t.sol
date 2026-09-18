// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";

contract DripPoolOwnershipTest is BaseTest {
    uint256 internal poolId;

    function setUp() public override {
        super.setUp();
        poolId = _standardPool();
    }

    function test_Transfer_IsTwoStep() public {
        vm.expectEmit(true, true, true, true, address(drip));
        emit OwnershipTransferStarted(poolId, owner, dave);
        vm.prank(owner);
        drip.transferPoolOwnership(poolId, dave);

        assertEq(drip.getPool(poolId).owner, owner, "not yet");
        assertEq(drip.getPool(poolId).pendingOwner, dave);

        vm.expectEmit(true, true, true, true, address(drip));
        emit OwnershipTransferred(poolId, owner, dave);
        vm.prank(dave);
        drip.acceptPoolOwnership(poolId);

        IDripPool.Pool memory p = drip.getPool(poolId);
        assertEq(p.owner, dave);
        assertEq(p.pendingOwner, address(0));
    }

    function test_Transfer_NewOwnerCanAdminister() public {
        vm.prank(owner);
        drip.transferPoolOwnership(poolId, dave);
        vm.startPrank(dave);
        drip.acceptPoolOwnership(poolId);
        drip.setRate(poolId, 2 * RATE);
        vm.stopPrank();

        assertEq(drip.getPool(poolId).ratePerSecond, 2 * RATE);
    }

    function test_Transfer_OldOwnerLosesRights() public {
        vm.prank(owner);
        drip.transferPoolOwnership(poolId, dave);
        vm.prank(dave);
        drip.acceptPoolOwnership(poolId);

        vm.prank(owner);
        vm.expectRevert(IDripPool.NotOwner.selector);
        drip.setRate(poolId, 1);
    }

    function test_Transfer_CanBeReplacedBeforeAcceptance() public {
        vm.startPrank(owner);
        drip.transferPoolOwnership(poolId, dave);
        drip.transferPoolOwnership(poolId, bob);
        vm.stopPrank();

        vm.prank(dave);
        vm.expectRevert(IDripPool.NotPendingOwner.selector);
        drip.acceptPoolOwnership(poolId);

        vm.prank(bob);
        drip.acceptPoolOwnership(poolId);
        assertEq(drip.getPool(poolId).owner, bob);
    }

    function test_Transfer_DoesNotChangeClaimable() public {
        skip(400);
        vm.prank(owner);
        drip.transferPoolOwnership(poolId, dave);
        vm.prank(dave);
        drip.acceptPoolOwnership(poolId);

        assertEq(drip.claimable(poolId, carol), 200, "I4: ownership moves never touch members");
    }

    function test_Transfer_RevertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(IDripPool.NotOwner.selector);
        drip.transferPoolOwnership(poolId, stranger);
    }

    function test_Transfer_RevertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(IDripPool.ZeroAddress.selector);
        drip.transferPoolOwnership(poolId, address(0));
    }

    function test_Accept_RevertsWithoutPendingTransfer() public {
        vm.prank(dave);
        vm.expectRevert(IDripPool.NotPendingOwner.selector);
        drip.acceptPoolOwnership(poolId);
    }

    function test_Accept_RevertsForWrongCaller() public {
        vm.prank(owner);
        drip.transferPoolOwnership(poolId, dave);
        vm.prank(stranger);
        vm.expectRevert(IDripPool.NotPendingOwner.selector);
        drip.acceptPoolOwnership(poolId);
    }
}
