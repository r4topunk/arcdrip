// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";

contract DripPoolWithdrawTest is BaseTest {
    uint256 internal poolId;

    function setUp() public override {
        super.setUp();
        poolId = _standardPool(); // alice 1 / bob 1 / carol 2, 1 USDC funded, 1 unit/s
    }

    function test_Withdraw_PaysTheMember() public {
        skip(400);

        vm.expectEmit(true, true, true, true, address(drip));
        emit Withdrawn(poolId, alice, alice, 100, alice);
        vm.prank(alice);
        assertEq(drip.withdraw(poolId), 100);

        assertEq(usdc.balanceOf(alice), 100);
        assertEq(drip.claimable(poolId, alice), 0);
        _assertSolvent(poolId);
    }

    function test_Withdraw_UpdatesPoolAccounting() public {
        skip(400);
        vm.prank(carol);
        drip.withdraw(poolId); // carol holds 2/4 shares -> 200 units

        IDripPool.Pool memory p = drip.getPool(poolId);
        assertEq(p.balance, ONE_USDC - 200);
        assertEq(p.owed, 400 * WAD - 200 * WAD);
        assertEq(drip.getMember(poolId, carol).pending, 0);
    }

    function test_Withdraw_KeepsSubUnitDust() public {
        // 3 shares over 10 s: 10 units streamed, alice is entitled to 3.33 units.
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _setShares(id, bob, 2);
        _deposit(id, ONE_USDC);
        skip(10);

        vm.prank(alice);
        assertEq(drip.withdraw(id), 3);
        assertEq(drip.getMember(id, alice).pending, 333_333_333_333, "0.33 units stay in wad");
    }

    function test_Withdraw_TwiceInSameBlockReverts() public {
        skip(400);
        vm.startPrank(alice);
        drip.withdraw(poolId);
        vm.expectRevert(IDripPool.NothingToWithdraw.selector);
        drip.withdraw(poolId);
        vm.stopPrank();
    }

    function test_Withdraw_RevertsWithNothingAccrued() public {
        vm.prank(alice);
        vm.expectRevert(IDripPool.NothingToWithdraw.selector);
        drip.withdraw(poolId);
    }

    function test_Withdraw_RevertsBelowOneUnit() public {
        skip(3); // 3 units streamed, alice gets 0.75 -> floors to 0
        vm.prank(alice);
        vm.expectRevert(IDripPool.NothingToWithdraw.selector);
        drip.withdraw(poolId);
    }

    function test_Withdraw_RevertsForNonMember() public {
        skip(400);
        vm.prank(stranger);
        vm.expectRevert(IDripPool.NothingToWithdraw.selector);
        drip.withdraw(poolId);
    }

    function test_Withdraw_WorksAfterFreeze() public {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _deposit(id, 100);
        skip(10_000);

        vm.prank(alice);
        assertEq(drip.withdraw(id), 100);
        assertEq(drip.getPool(id).balance, 0);
        assertEq(drip.getPool(id).owed, 0);
    }

    // ------------------------------------------------------------------
    // withdrawFor
    // ------------------------------------------------------------------

    function test_WithdrawFor_IsPermissionlessAndPaysTheMember() public {
        skip(400);

        vm.expectEmit(true, true, true, true, address(drip));
        emit Withdrawn(poolId, bob, bob, 100, stranger);
        vm.prank(stranger);
        assertEq(drip.withdrawFor(poolId, bob), 100);

        assertEq(usdc.balanceOf(bob), 100, "funds go to the member");
        assertEq(usdc.balanceOf(stranger), 0, "never to the caller");
    }

    function test_WithdrawFor_RevertsWhenNothingAccrued() public {
        vm.prank(stranger);
        vm.expectRevert(IDripPool.NothingToWithdraw.selector);
        drip.withdrawFor(poolId, dave);
    }

    function test_WithdrawFor_RevertsWhenPayoutIsBlocklisted() public {
        skip(400);
        usdc.blacklist(alice, true);
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        drip.withdrawFor(poolId, alice);
    }

    function test_WithdrawFor_DoesNotStallOtherMembers() public {
        skip(400);
        usdc.blacklist(alice, true);

        drip.withdrawFor(poolId, bob);
        assertEq(usdc.balanceOf(bob), 100);
    }

    function test_WithdrawFor_FrontRunningSetSharesIsHarmless() public {
        skip(400);
        drip.withdrawFor(poolId, alice); // settles first
        _setShares(poolId, alice, 3);

        assertEq(usdc.balanceOf(alice), 100, "accrued before the re-weight is identical either way");
        assertEq(drip.claimable(poolId, alice), 0);
    }

    // ------------------------------------------------------------------
    // setPayoutAddress
    // ------------------------------------------------------------------

    function test_SetPayoutAddress_RedirectsWithdrawals() public {
        vm.expectEmit(true, true, true, true, address(drip));
        emit PayoutAddressSet(poolId, alice, dave);
        vm.prank(alice);
        drip.setPayoutAddress(poolId, dave);

        assertEq(drip.getMember(poolId, alice).payout, dave);

        skip(400);
        vm.expectEmit(true, true, true, true, address(drip));
        emit Withdrawn(poolId, alice, dave, 100, stranger);
        vm.prank(stranger);
        drip.withdrawFor(poolId, alice);

        assertEq(usdc.balanceOf(dave), 100);
        assertEq(usdc.balanceOf(alice), 0);
    }

    function test_SetPayoutAddress_ZeroResetsToSelf() public {
        vm.startPrank(alice);
        drip.setPayoutAddress(poolId, dave);
        drip.setPayoutAddress(poolId, address(0));
        vm.stopPrank();

        skip(400);
        drip.withdrawFor(poolId, alice);
        assertEq(usdc.balanceOf(alice), 100);
    }

    function test_SetPayoutAddress_StoredForAddressWithoutShares() public {
        vm.prank(stranger);
        drip.setPayoutAddress(poolId, dave);
        assertEq(drip.getMember(poolId, stranger).payout, dave);
        assertEq(drip.getMember(poolId, stranger).shares, 0);
    }

    function test_SetPayoutAddress_WorksAfterCancel() public {
        vm.prank(owner);
        drip.cancel(poolId, owner);

        vm.prank(alice);
        drip.setPayoutAddress(poolId, dave);
        assertEq(drip.getMember(poolId, alice).payout, dave);
    }

    function test_SetPayoutAddress_LetsABlocklistedMemberEscape() public {
        skip(400);
        usdc.blacklist(alice, true);

        vm.prank(alice);
        drip.setPayoutAddress(poolId, dave);
        drip.withdrawFor(poolId, alice);
        assertEq(usdc.balanceOf(dave), 100);
    }

    function test_SetPayoutAddress_RevertsOnContractItself() public {
        vm.prank(alice);
        vm.expectRevert(IDripPool.BadPayout.selector);
        drip.setPayoutAddress(poolId, address(drip));
    }

    function test_SetPayoutAddress_IsPerPool() public {
        uint256 other = _standardPool();
        vm.prank(alice);
        drip.setPayoutAddress(poolId, dave);
        assertEq(drip.getMember(other, alice).payout, address(0));
    }
}
