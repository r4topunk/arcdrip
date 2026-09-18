// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DripPool} from "../../src/DripPool.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

/// @dev Shared fixture for the DripPool unit suite.
///      The default rate is 1 USDC unit per second (1e12 wad/s), so "seconds elapsed" and "units
///      streamed" are the same number and every expectation below is checkable by hand.
abstract contract BaseTest is Test {
    // Mirrored events, for vm.expectEmit.
    event PoolCreated(
        uint256 indexed poolId, address indexed owner, uint256 ratePerSecond, uint64 startTime, string name
    );
    event Deposited(uint256 indexed poolId, address indexed from, uint256 amount);
    event RateSet(uint256 indexed poolId, uint256 oldRate, uint256 newRate);
    event SharesSet(
        uint256 indexed poolId, address indexed member, uint256 oldShares, uint256 newShares, uint256 totalShares
    );
    event PayoutAddressSet(uint256 indexed poolId, address indexed member, address to);
    event Withdrawn(uint256 indexed poolId, address indexed member, address indexed to, uint256 amount, address caller);
    event WithdrawSkipped(uint256 indexed poolId, address indexed member, uint256 amount);
    event UnstreamedWithdrawn(uint256 indexed poolId, address indexed to, uint256 amount);
    event Cancelled(uint256 indexed poolId, address indexed to, uint256 refund);
    event OwnershipTransferStarted(uint256 indexed poolId, address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(uint256 indexed poolId, address indexed oldOwner, address indexed newOwner);

    uint256 internal constant ONE_USDC = 1e6; // 6 decimals
    uint256 internal constant WAD = 1e12; // wad per USDC unit
    uint128 internal constant RATE = 1e12; // 1 USDC unit per second
    string internal constant NAME = "r4to collective";

    DripPool internal drip;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal stranger = makeAddr("stranger");
    address internal funder = makeAddr("funder");

    function setUp() public virtual {
        vm.warp(1_800_000_000); // a plausible Arc mainnet timestamp; avoids 0-timestamp edge cases
        usdc = new MockUSDC();
        drip = new DripPool(address(usdc));
        _fund(funder, 10_000_000 * ONE_USDC);
    }

    // ------------------------------------------------------------------
    // Fixtures
    // ------------------------------------------------------------------

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(drip), type(uint256).max);
    }

    function _createPool() internal returns (uint256 poolId) {
        return drip.createPool(owner, RATE, 0, NAME);
    }

    /// @dev Pool streaming 1 unit/s, members alice 1 / bob 1 / carol 2, funded with 1 USDC
    ///      (1e6 units = 1e6 seconds of runway).
    function _standardPool() internal returns (uint256 poolId) {
        poolId = _createPool();
        _setShares(poolId, alice, 1);
        _setShares(poolId, bob, 1);
        _setShares(poolId, carol, 2);
        _deposit(poolId, ONE_USDC);
    }

    function _deposit(uint256 poolId, uint256 amount) internal {
        vm.prank(funder);
        drip.deposit(poolId, amount);
    }

    function _setShares(uint256 poolId, address member, uint128 shares) internal {
        vm.prank(owner);
        drip.setShares(poolId, member, shares);
    }

    function _setRate(uint256 poolId, uint128 rate) internal {
        vm.prank(owner);
        drip.setRate(poolId, rate);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Sum of what every member could still claim, in wad, on simulated state.
    function _entitlement(uint256 poolId, address member) internal view returns (uint256) {
        IDripPool.Member memory m = drip.getMember(poolId, member);
        return m.pending + (uint256(m.shares) * (_simAccIndex(poolId) - m.index)) / 1e18;
    }

    function _simAccIndex(uint256 poolId) internal view returns (uint256) {
        IDripPool.Pool memory p = drip.getPool(poolId);
        uint256 from = p.lastAccrual > p.startTime ? p.lastAccrual : p.startTime;
        if (block.timestamp > from && p.ratePerSecond > 0 && p.totalShares > 0) {
            uint256 available = p.balance * WAD - p.owed;
            uint256 dt = block.timestamp - from;
            uint256 funded = available / p.ratePerSecond;
            if (funded < dt) dt = funded;
            return p.accIndex + (uint256(p.ratePerSecond) * dt * 1e18) / p.totalShares;
        }
        return p.accIndex;
    }

    function _assertSolvent(uint256 poolId) internal view {
        IDripPool.Pool memory p = drip.getPool(poolId);
        assertLe(p.owed, p.balance * WAD, "I2: owed exceeds balance");
        assertLe(p.balance, usdc.balanceOf(address(drip)), "I3: pool balance exceeds token balance");
    }
}
