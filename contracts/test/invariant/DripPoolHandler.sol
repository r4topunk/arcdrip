// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DripPool} from "../../src/DripPool.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @notice Drives three pools and six actors through deposits, rate changes, re-weightings (single and batch),
///         payout-address changes, member and permissionless withdrawals, batch payouts, unstreamed recovery,
///         cancellation, two-step ownership transfers, blocklist toggles, direct donations and time jumps.
///
/// @dev The campaign runs with `fail-on-revert = true`, so every action either guards its preconditions or
///      catches the one revert the spec allows there. Two calls are made bare on purpose, because PRD 4.3 and
///      D15 say they can never revert: `withdrawForBatch` (a blocklisted or zero-claimable member is skipped,
///      not propagated) and `withdrawUnstreamed` within the bound reported by `unstreamed`.
///
///      Ghosts. `ghostAccruals` / `ghostSettles` count the floors the contract performed per pool, which is the
///      dust budget invariant I1 is allowed (PRD 4.5). `ghostClaimableDecreased` is the I4 flag: every owner
///      action is wrapped in a modifier that snapshots every actor's `claimable` before and after.
contract DripPoolHandler is Test {
    uint256 internal constant WAD = 1e12;

    uint256 public constant POOLS = 3;
    uint256 public constant ACTORS = 6;

    uint128 internal constant MAX_HANDLER_RATE = 1e15; // wad/s = 1e3 USDC/s
    uint128 internal constant MAX_HANDLER_SHARES = 1e6;
    uint256 internal constant MAX_HANDLER_DEPOSIT = 1e11; // 1e5 USDC
    uint256 internal constant MAX_HANDLER_JUMP = 1e6; // ~11.6 days

    DripPool public drip;
    MockUSDC public usdc;

    address[] public actors;
    address public funder = makeAddr("inv-funder");
    address public sink = makeAddr("inv-sink");

    // ghosts
    mapping(uint256 poolId => uint256) public ghostAccruals;
    mapping(uint256 poolId => uint256) public ghostSettles;
    bool public ghostClaimableDecreased;
    uint256 public ghostDonated;

    // coverage counters
    uint256 public totalCalls;
    uint256 public deposits;
    uint256 public withdrawals;
    uint256 public skippedWithdrawals;
    uint256 public batches;
    uint256 public cancels;
    uint256 public freezes; // actions that found the pool already dry
    uint256 public paidUnits; // USDC units that actually reached members

    constructor(DripPool drip_, MockUSDC usdc_, address[] memory actors_) {
        drip = drip_;
        usdc = usdc_;
        actors = actors_;

        usdc.mint(funder, 1e18);
        vm.prank(funder);
        usdc.approve(address(drip), type(uint256).max);
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // ------------------------------------------------------------------
    // Modifiers
    // ------------------------------------------------------------------

    modifier countCall() {
        totalCalls += 1;
        _;
    }

    /// @dev PRD 4.5 I4: no owner action may ever reduce what a member can claim. Nothing inside an action moves
    ///      time, so the two snapshots are taken at the same timestamp and any drop is a real regression.
    modifier noClaimableDrop(uint256 poolId) {
        uint256[] memory before = new uint256[](actors.length);
        for (uint256 i; i < actors.length; ++i) {
            before[i] = drip.claimable(poolId, actors[i]);
        }
        _;
        for (uint256 i; i < actors.length; ++i) {
            if (drip.claimable(poolId, actors[i]) < before[i]) ghostClaimableDecreased = true;
        }
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    function warpAhead(uint256 seed) external countCall {
        vm.warp(block.timestamp + bound(seed, 1, MAX_HANDLER_JUMP));
    }

    function deposit(uint256 poolSeed, uint256 amount) external countCall {
        uint256 poolId = _poolId(poolSeed);
        if (_cancelled(poolId)) return;
        amount = bound(amount, 1, MAX_HANDLER_DEPOSIT);

        vm.prank(funder);
        drip.deposit(poolId, amount);
        ghostAccruals[poolId] += 1;
        deposits += 1;
    }

    function setRate(uint256 poolSeed, uint256 rateSeed) external countCall noClaimableDrop(_poolId(poolSeed)) {
        uint256 poolId = _poolId(poolSeed);
        if (_cancelled(poolId)) return;
        if (drip.unstreamed(poolId) == 0) freezes += 1;

        vm.prank(_owner(poolId));
        drip.setRate(poolId, uint128(bound(rateSeed, 0, MAX_HANDLER_RATE)));
        ghostAccruals[poolId] += 1;
    }

    function setShares(uint256 poolSeed, uint256 actorSeed, uint256 sharesSeed)
        external
        countCall
        noClaimableDrop(_poolId(poolSeed))
    {
        uint256 poolId = _poolId(poolSeed);
        if (_cancelled(poolId)) return;
        address member = _actor(actorSeed);
        uint128 shares = uint128(bound(sharesSeed, 0, MAX_HANDLER_SHARES));
        if (drip.getMember(poolId, member).shares == shares) return; // NoOp reverts by design

        vm.prank(_owner(poolId));
        drip.setShares(poolId, member, shares);
        ghostAccruals[poolId] += 1;
        ghostSettles[poolId] += 1;
    }

    function setSharesBatch(uint256 poolSeed, uint256 seed) external countCall noClaimableDrop(_poolId(poolSeed)) {
        uint256 poolId = _poolId(poolSeed);
        if (_cancelled(poolId)) return;

        uint256 n = bound(seed, 1, 4);
        address[] memory list = new address[](n);
        uint128[] memory sharesList = new uint128[](n);
        for (uint256 i; i < n; ++i) {
            uint256 s = uint256(keccak256(abi.encode(seed, i)));
            list[i] = _actor(s); // duplicates are allowed: last one wins
            sharesList[i] = uint128(bound(s >> 8, 0, MAX_HANDLER_SHARES));
        }

        vm.prank(_owner(poolId));
        drip.setSharesBatch(poolId, list, sharesList);
        ghostAccruals[poolId] += 1;
        ghostSettles[poolId] += n;
    }

    function setPayoutAddress(uint256 poolSeed, uint256 actorSeed, uint256 toSeed) external countCall {
        uint256 poolId = _poolId(poolSeed);
        address member = _actor(actorSeed);
        address to = toSeed % 4 == 0 ? address(0) : _actor(toSeed >> 8);

        vm.prank(member);
        drip.setPayoutAddress(poolId, to);
    }

    function withdraw(uint256 poolSeed, uint256 actorSeed) external countCall {
        uint256 poolId = _poolId(poolSeed);
        address member = _actor(actorSeed);

        vm.prank(member);
        try drip.withdraw(poolId) returns (uint256 units) {
            assertGt(units, 0, "withdraw returned zero without reverting");
            ghostAccruals[poolId] += 1;
            ghostSettles[poolId] += 1;
            withdrawals += 1;
            paidUnits += units;
        } catch {
            _assertWithdrawFailureIsAllowed(poolId, member);
        }
    }

    function withdrawFor(uint256 poolSeed, uint256 actorSeed, uint256 callerSeed) external countCall {
        uint256 poolId = _poolId(poolSeed);
        address member = _actor(actorSeed);
        address to = _payoutOf(poolId, member);
        uint256 before = usdc.balanceOf(to);

        vm.prank(_actor(callerSeed));
        try drip.withdrawFor(poolId, member) returns (uint256 units) {
            // PRD D5: the funds always go to the member's payout address, never to the caller
            assertEq(usdc.balanceOf(to) - before, units, "withdrawFor paid the wrong address");
            ghostAccruals[poolId] += 1;
            ghostSettles[poolId] += 1;
            withdrawals += 1;
            paidUnits += units;
        } catch {
            _assertWithdrawFailureIsAllowed(poolId, member);
        }
    }

    /// @dev Bare call: PRD D15 says one bad member must never make this revert, so a revert fails the campaign.
    function withdrawForBatch(uint256 poolSeed, uint256 seed) external countCall {
        uint256 poolId = _poolId(poolSeed);
        uint256 n = actors.length;
        address[] memory list = new address[](n);
        for (uint256 i; i < n; ++i) {
            list[i] = actors[(i + (seed % n)) % n];
        }

        vm.prank(sink);
        uint256 total = drip.withdrawForBatch(poolId, list);
        ghostAccruals[poolId] += 1;
        ghostSettles[poolId] += n;
        batches += 1;
        paidUnits += total;
        if (total == 0) skippedWithdrawals += 1;
    }

    /// @dev Bare call inside the bound the view reports: `unstreamed` and `withdrawUnstreamed` must agree.
    function withdrawUnstreamed(uint256 poolSeed, uint256 amountSeed)
        external
        countCall
        noClaimableDrop(_poolId(poolSeed))
    {
        uint256 poolId = _poolId(poolSeed);
        if (_cancelled(poolId)) return;
        uint256 max = drip.unstreamed(poolId);
        if (max == 0) return;

        vm.prank(_owner(poolId));
        drip.withdrawUnstreamed(poolId, bound(amountSeed, 1, max), sink);
        ghostAccruals[poolId] += 1;
    }

    /// @dev Only pool 3 can be cancelled, and rarely: cancelling is terminal for every owner action, so
    ///      letting it fire often would spend most of a campaign on dead pools. Pools 1 and 2 stay live.
    function cancel(uint256 poolSeed, uint256 seed) external countCall noClaimableDrop(_poolId(poolSeed)) {
        uint256 poolId = _poolId(poolSeed);
        if (poolId != 3 || _cancelled(poolId) || seed % 24 != 0) return;

        vm.prank(_owner(poolId));
        drip.cancel(poolId, sink);
        ghostAccruals[poolId] += 1;
        cancels += 1;
    }

    /// @dev A full two-step round trip, so the handler ends the action owning the pool again. Ownership works
    ///      on cancelled pools too (PRD 4.3), hence no `_cancelled` guard.
    function rotateOwnership(uint256 poolSeed, uint256 actorSeed)
        external
        countCall
        noClaimableDrop(_poolId(poolSeed))
    {
        uint256 poolId = _poolId(poolSeed);
        address newOwner = _actor(actorSeed);
        address current = _owner(poolId);
        if (newOwner == current) return;

        vm.prank(current);
        drip.transferPoolOwnership(poolId, newOwner);
        vm.prank(newOwner);
        drip.acceptPoolOwnership(poolId);
        vm.prank(newOwner);
        drip.transferPoolOwnership(poolId, current);
        vm.prank(current);
        drip.acceptPoolOwnership(poolId);
    }

    function toggleBlocklist(uint256 actorSeed, bool blocked) external countCall {
        usdc.blacklist(_actor(actorSeed), blocked);
    }

    /// @dev PRD 7: USDC sent straight to the contract is ignored by the accounting, which makes I3 a `<=`.
    function donate(uint256 amount) external countCall {
        amount = bound(amount, 1, 1e9);
        vm.prank(funder);
        assertTrue(usdc.transfer(address(drip), amount), "donation transfer failed");
        ghostDonated += amount;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev A withdrawal may only fail for two reasons: nothing to withdraw, or a blocklisted payout address.
    function _assertWithdrawFailureIsAllowed(uint256 poolId, address member) internal {
        skippedWithdrawals += 1;
        if (drip.claimable(poolId, member) == 0) return;
        assertTrue(
            usdc.isBlacklisted(_payoutOf(poolId, member)),
            "withdraw reverted with a non-zero claimable and an allowed payout"
        );
    }

    function _payoutOf(uint256 poolId, address member) internal view returns (address) {
        address payout = drip.getMember(poolId, member).payout;
        return payout == address(0) ? member : payout;
    }

    function _owner(uint256 poolId) internal view returns (address) {
        return drip.getPool(poolId).owner;
    }

    function _cancelled(uint256 poolId) internal view returns (bool) {
        return drip.getPool(poolId).cancelled;
    }

    function _poolId(uint256 seed) internal pure returns (uint256) {
        return (seed % POOLS) + 1;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }
}
