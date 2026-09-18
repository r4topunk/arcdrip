// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {BaseTest} from "./Base.t.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";

contract DripPoolBatchTest is BaseTest {
    uint256 internal poolId;

    function setUp() public override {
        super.setUp();
        poolId = _standardPool(); // alice 1 / bob 1 / carol 2, 1 USDC funded, 1 unit/s
    }

    function _members() internal view returns (address[] memory list) {
        list = new address[](3);
        list[0] = alice;
        list[1] = bob;
        list[2] = carol;
    }

    function test_Batch_PaysEveryone() public {
        skip(400);

        vm.prank(stranger);
        assertEq(drip.withdrawForBatch(poolId, _members()), 400);

        assertEq(usdc.balanceOf(alice), 100);
        assertEq(usdc.balanceOf(bob), 100);
        assertEq(usdc.balanceOf(carol), 200);
        assertEq(usdc.balanceOf(stranger), 0, "caller is never paid");
        _assertSolvent(poolId);
    }

    function test_Batch_SingleAccrual() public {
        skip(400);
        vm.prank(stranger);
        drip.withdrawForBatch(poolId, _members());

        IDripPool.Pool memory p = drip.getPool(poolId);
        assertEq(p.lastAccrual, uint64(block.timestamp));
        assertEq(p.balance, ONE_USDC - 400);
        assertEq(p.owed, 0);
    }

    function test_Batch_RespectsPayoutAddresses() public {
        vm.prank(carol);
        drip.setPayoutAddress(poolId, dave);
        skip(400);

        drip.withdrawForBatch(poolId, _members());
        assertEq(usdc.balanceOf(dave), 200);
        assertEq(usdc.balanceOf(carol), 0);
    }

    function test_Batch_SkipsBlocklistedMemberAndRestoresState() public {
        skip(400);
        usdc.blacklist(alice, true);

        vm.expectEmit(true, true, true, true, address(drip));
        emit WithdrawSkipped(poolId, alice, 100);
        assertEq(drip.withdrawForBatch(poolId, _members()), 300, "alice's 100 is not counted");

        assertEq(usdc.balanceOf(alice), 0);
        assertEq(usdc.balanceOf(bob), 100);
        assertEq(usdc.balanceOf(carol), 200);

        // Alice's entitlement survived the skip intact.
        assertEq(drip.claimable(poolId, alice), 100);
        assertEq(drip.getMember(poolId, alice).pending, 100 * WAD);

        IDripPool.Pool memory p = drip.getPool(poolId);
        assertEq(p.balance, ONE_USDC - 300, "only the paid units left the pool");
        assertEq(p.owed, 100 * WAD, "alice is still owed");
        _assertSolvent(poolId);
    }

    function test_Batch_BlocklistedMemberCanBePaidLater() public {
        skip(400);
        usdc.blacklist(alice, true);
        drip.withdrawForBatch(poolId, _members());

        usdc.blacklist(alice, false);
        vm.prank(alice);
        assertEq(drip.withdraw(poolId), 100);
        assertEq(usdc.balanceOf(alice), 100);
    }

    function test_Batch_SkipsMemberWhoseTokenReturnsFalse() public {
        skip(400);
        usdc.setReturnsFalse(true);

        vm.expectEmit(true, true, true, true, address(drip));
        emit WithdrawSkipped(poolId, alice, 100);
        assertEq(drip.withdrawForBatch(poolId, _members()), 0);

        IDripPool.Pool memory p = drip.getPool(poolId);
        assertEq(p.balance, ONE_USDC, "nothing left the pool");
        assertEq(p.owed, 400 * WAD);
        assertEq(drip.claimable(poolId, carol), 200);
    }

    function test_Batch_SkipsZeroClaimableMemberSilently() public {
        skip(400);
        address[] memory list = new address[](4);
        list[0] = alice;
        list[1] = dave; // never had shares
        list[2] = bob;
        list[3] = carol;

        vm.recordLogs();
        assertEq(drip.withdrawForBatch(poolId, list), 400);

        assertEq(usdc.balanceOf(dave), 0);
        assertEq(drip.getMember(poolId, dave).pending, 0);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(
                logs[i].topics[0] != WithdrawSkipped.selector, "a zero-claimable member must be skipped silently"
            );
        }
    }

    function test_Batch_SkipsSubUnitClaimable() public {
        skip(1); // 1 unit streamed over 4 shares: everyone floors to 0
        assertEq(drip.withdrawForBatch(poolId, _members()), 0);
        assertEq(drip.getPool(poolId).balance, ONE_USDC);
    }

    function test_Batch_HandlesDuplicates() public {
        skip(400);
        address[] memory list = new address[](2);
        list[0] = alice;
        list[1] = alice;

        assertEq(drip.withdrawForBatch(poolId, list), 100, "second entry has nothing left");
        assertEq(usdc.balanceOf(alice), 100);
    }

    function test_Batch_EmptyListIsNoop() public {
        skip(400);
        assertEq(drip.withdrawForBatch(poolId, new address[](0)), 0);
        assertEq(drip.getPool(poolId).owed, 400 * WAD, "accrual still happened");
    }

    function test_Batch_ZeroAddressEntryIsSkipped() public {
        skip(400);
        address[] memory list = new address[](1);
        list[0] = address(0);
        assertEq(drip.withdrawForBatch(poolId, list), 0);
    }

    function test_Batch_MaxBatch() public {
        uint256 n = drip.MAX_BATCH();
        address[] memory list = new address[](n);
        for (uint256 i; i < n; ++i) {
            // casting to uint160 is safe because these are small synthetic test addresses
            // forge-lint: disable-next-line(unsafe-typecast)
            list[i] = address(uint160(2000 + i));
        }
        skip(400);
        assertEq(drip.withdrawForBatch(poolId, list), 0);
    }

    function test_Batch_RevertsAboveMaxBatch() public {
        vm.expectRevert(IDripPool.TooManyItems.selector);
        drip.withdrawForBatch(poolId, new address[](101));
    }

    function test_Batch_WorksAfterCancel() public {
        skip(400);
        vm.prank(owner);
        drip.cancel(poolId, owner);

        assertEq(drip.withdrawForBatch(poolId, _members()), 400);
        assertEq(drip.getPool(poolId).balance, 0);
    }

    function test_Batch_WorksWhenFrozen() public {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _setShares(id, bob, 1);
        _deposit(id, 100);
        skip(10_000); // frozen at t+100

        address[] memory list = new address[](2);
        list[0] = alice;
        list[1] = bob;
        assertEq(drip.withdrawForBatch(id, list), 100);
        assertEq(drip.getPool(id).balance, 0);
    }
}
