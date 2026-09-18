// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";

/// @dev The end-to-end scenarios of PRD section 8.1, each one written as the story it checks.
contract DripPoolScenariosTest is BaseTest {
    function test_Scenario_FullPayrollLifecycle() public {
        // Create, staff, fund.
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _setShares(id, bob, 1);
        _setShares(id, carol, 2);
        _deposit(id, ONE_USDC);

        // Run for a while; everyone withdraws.
        skip(1000);
        drip.withdrawFor(id, alice);
        drip.withdrawFor(id, bob);
        drip.withdrawFor(id, carol);
        assertEq(usdc.balanceOf(alice), 250);
        assertEq(usdc.balanceOf(carol), 500);

        // Dave joins mid-stream.
        _setShares(id, dave, 1);
        skip(1000);
        assertEq(drip.claimable(id, dave), 200, "1/5 of 1000");

        // Bob leaves; his accrued amount is untouched.
        _setShares(id, bob, 0);
        uint256 bobOwed = drip.claimable(id, bob);
        skip(1000);
        assertEq(drip.claimable(id, bob), bobOwed);

        // Pause, resume.
        _setRate(id, 0);
        skip(10_000);
        uint256 frozen = drip.claimable(id, alice);
        _setRate(id, RATE);
        skip(100);
        assertGt(drip.claimable(id, alice), frozen);

        // Pay everyone in one call, then cancel.
        address[] memory list = new address[](4);
        list[0] = alice;
        list[1] = bob;
        list[2] = carol;
        list[3] = dave;
        drip.withdrawForBatch(id, list);

        vm.prank(owner);
        drip.cancel(id, owner);
        _assertSolvent(id);
        assertEq(drip.getPool(id).balance, 0, "nothing left over: everyone was paid first");
    }

    function test_Scenario_FreezeThenDepositWithoutBackPay() public {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _deposit(id, 3600); // one hour of runway at 1 unit/s
        skip(7200); // twice that

        assertEq(drip.claimable(id, alice), 3600, "capped by the funded time");
        assertEq(drip.unstreamed(id), 0);
        assertEq(drip.fundedUntil(id), uint64(block.timestamp));

        _deposit(id, 3600);
        assertEq(drip.claimable(id, alice), 3600, "the deposit does not back-pay the frozen hour");

        skip(1800);
        assertEq(drip.claimable(id, alice), 5400);
        _assertSolvent(id);
    }

    function test_Scenario_FutureStartTime() public {
        uint64 start = uint64(block.timestamp + 1 days);
        uint256 id = drip.createPool(owner, RATE, start, NAME);
        _setShares(id, alice, 1);
        _deposit(id, ONE_USDC);

        skip(1 days - 1);
        assertEq(drip.claimable(id, alice), 0, "nothing before startTime");
        assertEq(drip.unstreamed(id), ONE_USDC);

        skip(101);
        assertEq(drip.claimable(id, alice), 100, "100 s after startTime");
    }

    function test_Scenario_WithdrawAfterCancel() public {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _deposit(id, ONE_USDC);
        skip(500);

        vm.prank(owner);
        drip.cancel(id, owner);
        assertEq(usdc.balanceOf(owner), ONE_USDC - 500);

        skip(30 days);
        vm.prank(alice);
        assertEq(drip.withdraw(id), 500);
        assertEq(drip.getPool(id).balance, 0);
        assertEq(usdc.balanceOf(address(drip)), 0);
    }

    function test_Scenario_OnePoolPaysFourMembersToTheLastUnit() public {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _setShares(id, bob, 1);
        _setShares(id, carol, 2);
        _deposit(id, 1000);
        skip(1_000_000); // far past the freeze

        address[] memory list = new address[](3);
        list[0] = alice;
        list[1] = bob;
        list[2] = carol;
        assertEq(drip.withdrawForBatch(id, list), 1000, "the whole deposit reached the members");

        IDripPool.Pool memory p = drip.getPool(id);
        assertEq(p.balance, 0);
        assertEq(p.owed, 0);
    }

    /// @dev D9's reason for the wad unit: 1 USDC per month must not round to zero.
    function test_Scenario_OneUsdcPerMonthOverAYear() public {
        uint128 rate = uint128((1 * ONE_USDC * WAD) / 30 days); // 1 USDC / 30 d, in wad/s
        assertGt(rate, 0);

        uint256 id = drip.createPool(owner, rate, 0, "tiny");
        _setShares(id, alice, 1);
        _deposit(id, 20 * ONE_USDC);

        // A year is 12.1666 months of 30 days.
        skip(365 days);
        uint256 got = drip.claimable(id, alice);
        uint256 ideal = (uint256(rate) * 365 days) / WAD;
        assertEq(got, ideal, "no drift over a year");
        assertApproxEqAbs(got, 12_166_666, 1, "about 12.17 USDC");

        vm.prank(alice);
        drip.withdraw(id);
        assertEq(usdc.balanceOf(alice), got);
        _assertSolvent(id);
    }

    /// @dev Same rate, but claimed every day: the per-accrual floors must not accumulate into drift.
    function test_Scenario_OneUsdcPerMonthClaimedDaily() public {
        uint128 rate = uint128((1 * ONE_USDC * WAD) / 30 days);
        uint256 id = drip.createPool(owner, rate, 0, "tiny");
        _setShares(id, alice, 1);
        _setShares(id, bob, 2);
        _deposit(id, 20 * ONE_USDC);

        for (uint256 i; i < 365; ++i) {
            skip(1 days);
            drip.withdrawForBatch(id, _pair());
        }

        uint256 streamed = (uint256(rate) * 365 days) / WAD;
        uint256 paid = usdc.balanceOf(alice) + usdc.balanceOf(bob);
        assertLe(paid, streamed, "I5: never overpays");
        assertApproxEqAbs(paid, streamed, 2, "daily claims lose at most rounding dust");
        _assertSolvent(id);
    }

    function test_Scenario_DustStaysInThePoolForever() public {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _setShares(id, bob, 2);
        _deposit(id, 100);
        skip(1_000_000); // fully streamed: owed == 100 units

        drip.withdrawForBatch(id, _pair());
        IDripPool.Pool memory p = drip.getPool(id);

        // 100 units over 3 shares: 33 + 66 paid, 1 unit worth of fractions still owed.
        assertEq(usdc.balanceOf(alice) + usdc.balanceOf(bob), 99);
        assertEq(p.balance, 1);
        assertGt(p.owed, 0);
        assertEq(drip.unstreamed(id), 0, "the owner cannot sweep it");

        vm.prank(owner);
        vm.expectRevert(IDripPool.InsufficientUnstreamed.selector);
        drip.withdrawUnstreamed(id, 1, owner);
    }

    function _pair() internal view returns (address[] memory list) {
        list = new address[](2);
        list[0] = alice;
        list[1] = bob;
    }
}
