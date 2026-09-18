// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {DripPool} from "../../src/DripPool.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";

contract DripPoolCreateTest is BaseTest {
    function test_Constructor_SetsUsdc() public view {
        assertEq(address(drip.usdc()), address(usdc));
        assertEq(drip.nextPoolId(), 1);
    }

    function test_Constructor_RevertsOnZeroToken() public {
        vm.expectRevert(IDripPool.ZeroAddress.selector);
        new DripPool(address(0));
    }

    function test_Constants() public view {
        assertEq(drip.WAD_PER_UNIT(), 1e12);
        assertEq(drip.INDEX_SCALE(), 1e18);
        assertEq(drip.MAX_RATE(), 1e30);
        assertEq(drip.MAX_SHARES(), 1e15);
        assertEq(drip.MAX_TOTAL_SHARES(), 1e18);
        assertEq(drip.MAX_BATCH(), 100);
    }

    function test_CreatePool_InitialState() public {
        vm.expectEmit(true, true, true, true, address(drip));
        emit PoolCreated(1, owner, RATE, 0, NAME);
        uint256 poolId = drip.createPool(owner, RATE, 0, NAME);

        assertEq(poolId, 1);
        assertEq(drip.nextPoolId(), 2);

        IDripPool.Pool memory p = drip.getPool(poolId);
        assertEq(p.owner, owner);
        assertEq(p.pendingOwner, address(0));
        assertEq(p.startTime, 0);
        assertEq(p.lastAccrual, uint64(block.timestamp));
        assertFalse(p.cancelled);
        assertEq(p.ratePerSecond, RATE);
        assertEq(p.totalShares, 0);
        assertEq(p.balance, 0);
        assertEq(p.owed, 0);
        assertEq(p.accIndex, 0);
    }

    function test_CreatePool_IsPermissionless() public {
        vm.prank(stranger);
        uint256 poolId = drip.createPool(owner, RATE, 0, NAME);
        assertEq(drip.getPool(poolId).owner, owner);
    }

    function test_CreatePool_IdsIncrement() public {
        assertEq(drip.createPool(owner, RATE, 0, "a"), 1);
        assertEq(drip.createPool(alice, RATE, 0, "b"), 2);
        assertEq(drip.createPool(bob, 0, 0, "c"), 3);
        assertEq(drip.nextPoolId(), 4);
    }

    function test_CreatePool_ZeroRateIsPaused() public {
        uint256 poolId = drip.createPool(owner, 0, 0, NAME);
        _setShares(poolId, alice, 1);
        _deposit(poolId, ONE_USDC);
        skip(1000);
        assertEq(drip.claimable(poolId, alice), 0);
    }

    function test_CreatePool_FutureStartTime() public {
        uint64 start = uint64(block.timestamp + 1000);
        uint256 poolId = drip.createPool(owner, RATE, start, NAME);
        assertEq(drip.getPool(poolId).startTime, start);
    }

    function test_CreatePool_StartTimeEqualToNowIsAllowed() public {
        uint64 start = uint64(block.timestamp);
        uint256 poolId = drip.createPool(owner, RATE, start, NAME);
        assertEq(drip.getPool(poolId).startTime, start);
    }

    function test_CreatePool_MaxRateIsAllowed() public {
        uint256 poolId = drip.createPool(owner, uint128(drip.MAX_RATE()), 0, NAME);
        assertEq(drip.getPool(poolId).ratePerSecond, uint128(drip.MAX_RATE()));
    }

    function test_CreatePool_RevertsOnZeroOwner() public {
        vm.expectRevert(IDripPool.ZeroAddress.selector);
        drip.createPool(address(0), RATE, 0, NAME);
    }

    function test_CreatePool_RevertsOnRateAboveMax() public {
        uint128 tooFast = uint128(drip.MAX_RATE() + 1);
        vm.expectRevert(IDripPool.BadRate.selector);
        drip.createPool(owner, tooFast, 0, NAME);
    }

    function test_CreatePool_RevertsOnPastStartTime() public {
        vm.expectRevert(IDripPool.BadStartTime.selector);
        drip.createPool(owner, RATE, uint64(block.timestamp - 1), NAME);
    }

    function test_Views_RevertOnUnknownPool() public {
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.getPool(1);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.getMember(1, alice);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.claimable(1, alice);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.fundedUntil(1);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.unstreamed(1);
    }

    function test_Writes_RevertOnUnknownPool() public {
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.deposit(7, 1);
        vm.prank(owner);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.setRate(7, 1);
        vm.prank(owner);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.setShares(7, alice, 1);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.setPayoutAddress(7, alice);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.withdraw(7);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.withdrawFor(7, alice);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.withdrawForBatch(7, new address[](0));
        vm.prank(owner);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.withdrawUnstreamed(7, 1, owner);
        vm.prank(owner);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.cancel(7, owner);
        vm.prank(owner);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.transferPoolOwnership(7, alice);
        vm.expectRevert(IDripPool.PoolNotFound.selector);
        drip.acceptPoolOwnership(7);
    }

    function test_Pools_AreIsolated() public {
        uint256 a = _standardPool();
        uint256 b = _standardPool();
        skip(400);
        drip.withdrawFor(a, alice);

        assertEq(drip.claimable(b, alice), 100, "pool b untouched");
        _assertSolvent(a);
        _assertSolvent(b);
    }
}
