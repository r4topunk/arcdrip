// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";

/// @notice Regressions for the griefing and fund-destruction surfaces found in the security review.
///         See docs/SPEC.md §6.1 (the exact reading of I4) and docs/THREATS.md §7 and §20.
contract DripPoolGriefingTest is BaseTest {
    // ------------------------------------------------------------------
    // Forced settles (docs/SPEC.md §6.1)
    // ------------------------------------------------------------------

    /// @dev `withdrawForBatch` is permissionless and, by D15, does not revert on a member with nothing to pay.
    ///      It must therefore not `_settle` that member either: a settle floors, and an *extra* floor burns up
    ///      to 1 wad of their entitlement into unreachable `owed` dust. The member's stored state must come out
    ///      byte-identical to what it was before the poke.
    function test_Batch_PokeThatPaysNothingDoesNotSettleTheMember() public {
        uint256 id = _threeSharePool();
        uint256 t0 = block.timestamp;

        vm.warp(t0 + 1); // alice has accrued a third of a unit: real entitlement, zero payable units
        assertEq(drip.claimable(id, alice), 0, "precondition: nothing payable yet");
        IDripPool.Member memory before = drip.getMember(id, alice);

        address[] memory list = new address[](1);
        list[0] = alice;
        vm.prank(stranger);
        assertEq(drip.withdrawForBatch(id, list), 0, "a poke that pays nothing must transfer nothing");

        IDripPool.Member memory afterPoke = drip.getMember(id, alice);
        assertEq(afterPoke.index, before.index, "the member was settled by a poke that paid nothing");
        assertEq(afterPoke.pending, before.pending, "the member's pending was rewritten by a free poke");
    }

    /// @dev The residual, and its bound. Closing the settle lever does not close the *accrual* lever: every
    ///      state-changing call runs `_accrue`, whose `accIndex` division also floors, and permissionless
    ///      functions (`deposit`, `withdrawForBatch`, …) are exactly how a pool gets used. That is PRD §4.5
    ///      I1's `accrualCount × 1 wad` term, which the spec budgets on purpose (docs/SPEC.md §6.1).
    ///
    ///      So the guarantee is a bound, not equality: N pokes cost the member under N wad in total, funds are
    ///      destroyed rather than moved, and the griefer pays gas for nothing. `claimable` in whole units can
    ///      lag by one unit when the loss straddles a boundary, which is what this test pins down.
    function test_Batch_PokeCostsAtMostTheDocumentedAccrualDust() public {
        uint256 griefed = _threeSharePool();
        uint256 clean = _threeSharePool();
        uint256 t0 = block.timestamp;

        // Poke on every second of the window. Each one pays nothing and settles nobody.
        address[] memory list = new address[](1);
        list[0] = alice;
        uint256 pokes = 2;
        for (uint256 i = 1; i <= pokes; ++i) {
            vm.warp(t0 + i);
            vm.prank(stranger);
            assertEq(drip.withdrawForBatch(griefed, list), 0, "a poke must never pay anything");
        }

        vm.warp(t0 + 3);
        uint256 griefedWad = _entitlement(griefed, alice);
        uint256 cleanWad = _entitlement(clean, alice);
        assertLe(griefedWad, cleanWad, "a poke must never increase an entitlement");
        assertLe(cleanWad - griefedWad, pokes, "pokes cost more than I1's one-wad-per-accrual budget");

        // Nothing was transferred to anyone, and the destroyed wad did not become owner-sweepable balance.
        assertEq(usdc.balanceOf(alice), 0, "no payout happened");
        assertEq(usdc.balanceOf(stranger), 0, "the griefer gained nothing");
        assertEq(drip.unstreamed(griefed), drip.unstreamed(clean), "dust leaked into the owner's sweepable balance");
        _assertSolvent(griefed);
    }

    /// @dev `withdrawFor` on a member with nothing payable reverts instead of settling (PRD §7, dust griefing),
    ///      so it is not a lever either.
    function test_WithdrawFor_RevertsInsteadOfSettlingAZeroClaimableMember() public {
        uint256 id = _threeSharePool();
        vm.warp(block.timestamp + 1);
        IDripPool.Member memory before = drip.getMember(id, alice);

        vm.prank(stranger);
        vm.expectRevert(IDripPool.NothingToWithdraw.selector);
        drip.withdrawFor(id, alice);

        assertEq(drip.getMember(id, alice).index, before.index, "a reverted withdrawFor must leave no trace");
    }

    /// @dev What I4 guarantees against the owner, stated exactly (docs/SPEC.md §6.1): owner actions never move
    ///      earned funds anywhere, and the most they can cost a member is the per-settle dust I1 already
    ///      budgets — under 1 wad each, which at a unit boundary is at most one USDC unit of `claimable`.
    function test_SetShares_OwnerTogglesCostAtMostTheDocumentedDust() public {
        uint256 id = _threeSharePool();
        uint256 clean = _threeSharePool();
        uint256 t0 = block.timestamp;

        vm.warp(t0 + 1);
        // Three owner writes, each of which settles alice: two on another member, one on her own row.
        address[] memory list = new address[](2);
        uint128[] memory shares = new uint128[](2);
        (list[0], shares[0]) = (alice, 1); // unchanged entry: skipped, bob's toggle drags alice along
        (list[1], shares[1]) = (bob, 3);
        vm.prank(owner);
        drip.setSharesBatch(id, list, shares);
        _setShares(id, bob, 2); // back to the original weighting
        _setShares(id, alice, 2);
        _setShares(id, alice, 1);

        vm.warp(t0 + 3);
        uint256 griefedWad = _entitlement(id, alice);
        uint256 cleanWad = _entitlement(clean, alice);
        assertLe(griefedWad, cleanWad, "owner actions must never increase a member's entitlement");
        // Four settles at most, each losing under 1 wad; the pool-level accruals add one wad apiece (I1).
        assertLe(cleanWad - griefedWad, 8, "owner actions cost more than the I1 dust budget");
        _assertSolvent(id);

        // The absolute part of I4: nothing was moved to anyone. The owner cannot sweep it either.
        assertEq(usdc.balanceOf(alice), 0, "no payout happened");
        assertEq(drip.unstreamed(id), drip.unstreamed(clean), "dust did not become owner-sweepable balance");
    }

    // ------------------------------------------------------------------
    // The singleton is never a payout destination (docs/THREATS.md §20)
    // ------------------------------------------------------------------

    /// @dev Paying `address(this)` is a self-transfer: `balance`, `owed` and `pending` are debited but no token
    ///      moves, so the units become untracked surplus no pool accounts for and no function can pay out.
    ///      `setPayoutAddress` already refused it; every other route into a payout address must too.
    function test_SetShares_RevertsOnTheSingleton() public {
        uint256 id = _createPool();
        vm.prank(owner);
        vm.expectRevert(IDripPool.BadPayout.selector);
        drip.setShares(id, address(drip), 1);
    }

    function test_SetSharesBatch_RevertsOnTheSingleton() public {
        uint256 id = _createPool();
        address[] memory list = new address[](2);
        uint128[] memory shares = new uint128[](2);
        (list[0], shares[0]) = (alice, 1);
        (list[1], shares[1]) = (address(drip), 1);

        vm.prank(owner);
        vm.expectRevert(IDripPool.BadPayout.selector);
        drip.setSharesBatch(id, list, shares);
    }

    function test_WithdrawUnstreamed_RevertsOnTheSingleton() public {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _deposit(id, ONE_USDC);

        vm.prank(owner);
        vm.expectRevert(IDripPool.BadPayout.selector);
        drip.withdrawUnstreamed(id, 1000, address(drip));
    }

    function test_Cancel_RevertsOnTheSingleton() public {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _deposit(id, ONE_USDC);

        vm.prank(owner);
        vm.expectRevert(IDripPool.BadPayout.selector);
        drip.cancel(id, address(drip));
    }

    /// @dev The guards leave the pool usable: the same calls with a real destination still work, and the
    ///      tokens actually leave the contract.
    function test_OwnerSweeps_StillWorkWithARealDestination() public {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _deposit(id, ONE_USDC);

        uint256 tokenBefore = usdc.balanceOf(address(drip));
        vm.prank(owner);
        drip.withdrawUnstreamed(id, 1000, stranger);
        assertEq(tokenBefore - usdc.balanceOf(address(drip)), 1000, "units were debited but never transferred");
        assertEq(usdc.balanceOf(stranger), 1000, "the destination was not paid");
        _assertSolvent(id);
    }

    // ------------------------------------------------------------------
    // Fixtures
    // ------------------------------------------------------------------

    /// @dev 1 USDC unit/s, alice 1 share of 3, funded for 1e6 seconds. Three shares make the index division
    ///      inexact, which is what exposes a per-settle floor loss at a whole-unit boundary.
    function _threeSharePool() internal returns (uint256 id) {
        id = drip.createPool(owner, RATE, 0, NAME);
        _setShares(id, alice, 1);
        _setShares(id, bob, 2);
        _deposit(id, ONE_USDC);
    }
}
