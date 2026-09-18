// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";

contract DripPoolDepositTest is BaseTest {
    uint256 internal poolId;

    function setUp() public override {
        super.setUp();
        poolId = _createPool();
        _setShares(poolId, alice, 1);
    }

    function test_Deposit_CreditsPoolAndMovesTokens() public {
        vm.expectEmit(true, true, true, true, address(drip));
        emit Deposited(poolId, funder, ONE_USDC);
        _deposit(poolId, ONE_USDC);

        assertEq(drip.getPool(poolId).balance, ONE_USDC);
        assertEq(usdc.balanceOf(address(drip)), ONE_USDC);
    }

    function test_Deposit_IsPermissionless() public {
        _fund(stranger, ONE_USDC);
        vm.prank(stranger);
        drip.deposit(poolId, ONE_USDC);
        assertEq(drip.getPool(poolId).balance, ONE_USDC);
    }

    function test_Deposit_AccruesBeforeCrediting() public {
        _deposit(poolId, 100);
        skip(1000); // only 100 s are funded: the stream froze at t+100
        _deposit(poolId, 100);

        IDripPool.Pool memory p = drip.getPool(poolId);
        assertEq(p.balance, 200);
        assertEq(p.owed, 100 * WAD, "frozen time is not back-paid");
        assertEq(drip.claimable(poolId, alice), 100);
    }

    function test_Deposit_ResumesFromDepositTimestamp() public {
        _deposit(poolId, 100);
        skip(1000);
        _deposit(poolId, 100);
        skip(50);

        assertEq(drip.claimable(poolId, alice), 150, "100 pre-freeze + 50 post-deposit");
    }

    function test_Deposit_AccumulatesAcrossDeposits() public {
        _deposit(poolId, ONE_USDC);
        _deposit(poolId, ONE_USDC);
        assertEq(drip.getPool(poolId).balance, 2 * ONE_USDC);
    }

    function test_Deposit_RevertsOnZeroAmount() public {
        vm.expectRevert(IDripPool.ZeroAmount.selector);
        _deposit(poolId, 0);
    }

    function test_Deposit_RevertsWhenCancelled() public {
        vm.prank(owner);
        drip.cancel(poolId, owner);
        vm.expectRevert(IDripPool.PoolCancelled.selector);
        _deposit(poolId, ONE_USDC);
    }

    function test_Deposit_RevertsWithoutAllowance() public {
        usdc.mint(stranger, ONE_USDC);
        vm.prank(stranger);
        vm.expectRevert();
        drip.deposit(poolId, ONE_USDC);
    }

    function test_Deposit_DirectTransfersAreIgnored() public {
        _deposit(poolId, ONE_USDC);
        vm.prank(funder);
        // the mock reverts on failure; the return value is not the subject of this test
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        usdc.transfer(address(drip), 5 * ONE_USDC); // donation, not accounted (I3 is <=)

        assertEq(drip.getPool(poolId).balance, ONE_USDC);
        assertEq(usdc.balanceOf(address(drip)), 6 * ONE_USDC);
        _assertSolvent(poolId);
    }

    // ------------------------------------------------------------------
    // setRate
    // ------------------------------------------------------------------

    function test_SetRate_AccruesAtOldRateFirst() public {
        _deposit(poolId, ONE_USDC);
        skip(100);

        vm.expectEmit(true, true, true, true, address(drip));
        emit RateSet(poolId, RATE, 2 * RATE);
        _setRate(poolId, 2 * RATE);

        assertEq(drip.claimable(poolId, alice), 100);
        skip(100);
        assertEq(drip.claimable(poolId, alice), 300, "100 at 1x + 200 at 2x");
    }

    function test_SetRate_ZeroPausesAndPreservesAccrued() public {
        _deposit(poolId, ONE_USDC);
        skip(100);
        _setRate(poolId, 0);
        skip(10_000);

        assertEq(drip.claimable(poolId, alice), 100, "paused stream does not grow");
        _setRate(poolId, RATE);
        skip(50);
        assertEq(drip.claimable(poolId, alice), 150, "resumes without back-pay");
    }

    function test_SetRate_WhileFrozen() public {
        _deposit(poolId, 100);
        skip(1000); // frozen after 100 s
        _setRate(poolId, 10 * RATE);

        assertEq(drip.claimable(poolId, alice), 100, "no back-pay at the new rate");
        _deposit(poolId, 100);
        skip(5);
        assertEq(drip.claimable(poolId, alice), 150, "10 units/s for 5 s");
    }

    function test_SetRate_MaxRate() public {
        _setRate(poolId, uint128(drip.MAX_RATE()));
        assertEq(drip.getPool(poolId).ratePerSecond, uint128(drip.MAX_RATE()));
    }

    function test_SetRate_RevertsAboveMax() public {
        uint128 tooFast = uint128(drip.MAX_RATE() + 1);
        vm.prank(owner);
        vm.expectRevert(IDripPool.BadRate.selector);
        drip.setRate(poolId, tooFast);
    }

    function test_SetRate_RevertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(IDripPool.NotOwner.selector);
        drip.setRate(poolId, 1);
    }

    function test_SetRate_RevertsWhenCancelled() public {
        vm.startPrank(owner);
        drip.cancel(poolId, owner);
        vm.expectRevert(IDripPool.PoolCancelled.selector);
        drip.setRate(poolId, 1);
        vm.stopPrank();
    }
}
