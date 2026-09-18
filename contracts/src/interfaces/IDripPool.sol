// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IDripPool
/// @notice Shared USDC stream for collectives: one rate, N shares, live runway.
/// @dev One immutable singleton holds many pools. A pool streams `ratePerSecond` (in wad, see
///      `WAD_PER_UNIT`) split across members by mutable integer shares, using an accumulated index so
///      joining, leaving or re-weighting is O(1) and never touches another member's storage.
///      Accrual is capped by the funded balance, so the pool can never owe more than it holds: when it
///      runs dry the stream freezes and the next deposit resumes it from that deposit's timestamp
///      (frozen time is never back-paid). This file is the binding interface described in docs/SPEC.md.
interface IDripPool {
    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------

    struct Pool {
        address owner; // may pause, re-weight, sweep unstreamed funds and cancel; never touches `owed`
        address pendingOwner; // two-step ownership transfer
        uint64 startTime; // accrual never starts before this timestamp
        uint64 lastAccrual; // timestamp of the last _accrue
        bool cancelled; // terminal: no deposits, no owner writes; members keep withdrawing forever
        uint128 ratePerSecond; // wad per second for the whole pool; 0 = paused
        uint128 totalShares; // sum of member shares; 0 = nothing streams and nothing is consumed
        uint256 balance; // USDC units (6 decimals) held for this pool
        uint256 owed; // wad already streamed to members and not yet withdrawn (includes rounding dust)
        uint256 accIndex; // wad per share, scaled by INDEX_SCALE
    }

    struct Member {
        uint128 shares; // relative weight; 0 = removed (accrued amount stays withdrawable forever)
        address payout; // 0 = pay the member address itself
        uint256 index; // accIndex at the member's last settle
        uint256 pending; // wad settled and not yet withdrawn
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    /// @param name Emitted only; never stored.
    event PoolCreated(
        uint256 indexed poolId, address indexed owner, uint256 ratePerSecond, uint64 startTime, string name
    );
    event Deposited(uint256 indexed poolId, address indexed from, uint256 amount);
    event RateSet(uint256 indexed poolId, uint256 oldRate, uint256 newRate);
    event SharesSet(
        uint256 indexed poolId, address indexed member, uint256 oldShares, uint256 newShares, uint256 totalShares
    );
    event PayoutAddressSet(uint256 indexed poolId, address indexed member, address to);
    /// @param amount USDC units. `to` is the member's payout address, never the caller.
    event Withdrawn(uint256 indexed poolId, address indexed member, address indexed to, uint256 amount, address caller);
    /// @notice Emitted by `withdrawForBatch` when a member's transfer reverts or returns false; that
    ///         member's state is restored and the batch continues.
    event WithdrawSkipped(uint256 indexed poolId, address indexed member, uint256 amount);
    event UnstreamedWithdrawn(uint256 indexed poolId, address indexed to, uint256 amount);
    /// @dev `ratePerSecond` becomes 0; a `RateSet(poolId, oldRate, 0)` is emitted alongside this event
    ///      (skipped when the pool was already paused), so an indexer needs no special case.
    event Cancelled(uint256 indexed poolId, address indexed to, uint256 refund);
    event OwnershipTransferStarted(uint256 indexed poolId, address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(uint256 indexed poolId, address indexed oldOwner, address indexed newOwner);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error PoolNotFound();
    error NotOwner();
    error NotPendingOwner();
    error PoolCancelled();
    error ZeroAddress();
    error ZeroAmount();
    error BadRate();
    error BadShares();
    error BadStartTime();
    error BadPayout();
    error NoOp();
    error NothingToWithdraw();
    error InsufficientUnstreamed();
    error LengthMismatch();
    error TooManyItems();

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    /// @notice 1 USDC unit (1e-6 USDC) expressed in the internal wad accounting unit.
    function WAD_PER_UNIT() external view returns (uint256);
    /// @notice Fixed-point scale of `Pool.accIndex`.
    function INDEX_SCALE() external view returns (uint256);
    /// @notice Maximum `ratePerSecond` in wad/s (1e12 USDC/s); overflow guard.
    function MAX_RATE() external view returns (uint256);
    /// @notice Maximum shares for a single member.
    function MAX_SHARES() external view returns (uint256);
    /// @notice Maximum `Pool.totalShares`; keeps per-accrual rounding dust below 1 wad.
    function MAX_TOTAL_SHARES() external view returns (uint256);
    /// @notice Maximum number of entries in `setSharesBatch` and `withdrawForBatch`.
    function MAX_BATCH() external view returns (uint256);

    /// @notice The ERC-20 streamed by this deployment (USDC 0x3600...0000 on Arc, 6 decimals).
    function usdc() external view returns (IERC20);
    /// @notice Id of the next pool to be created; pool ids start at 1.
    function nextPoolId() external view returns (uint256);

    // ------------------------------------------------------------------
    // Pool lifecycle
    // ------------------------------------------------------------------

    /// @notice Creates a pool. Permissionless; the caller does not have to be the owner.
    /// @param owner Pool owner (EOA, Safe or DAO). Must not be the zero address.
    /// @param ratePerSecond Wad per second for the whole pool; `<= MAX_RATE`. 0 means created paused.
    /// @param startTime 0 means "now"; otherwise must be `>= block.timestamp`.
    /// @param name Human label, emitted in `PoolCreated` and never stored.
    function createPool(address owner, uint128 ratePerSecond, uint64 startTime, string calldata name)
        external
        returns (uint256 poolId);

    /// @notice Funds a live pool. Permissionless. Resumes a frozen stream from this timestamp.
    function deposit(uint256 poolId, uint256 amount) external;

    /// @notice Sets the pool rate in wad per second. 0 pauses the stream.
    function setRate(uint256 poolId, uint128 ratePerSecond) external;

    /// @notice Sets a member's shares. 0 removes the member; the amount already accrued stays withdrawable.
    /// @dev `member` may not be the singleton itself: paying it would be a self-transfer that debits the pool
    ///      and moves no token, so it reverts `BadPayout` like `setPayoutAddress` does.
    function setShares(uint256 poolId, address member, uint128 shares) external;

    /// @notice Batched `setShares` with a single accrual. Duplicates are allowed (last wins);
    ///         entries whose value is unchanged are skipped silently.
    /// @dev Every entry is checked exactly as `setShares` checks it, including the `BadPayout` guard.
    function setSharesBatch(uint256 poolId, address[] calldata membersList, uint128[] calldata sharesList) external;

    /// @notice Sets where the caller's withdrawals are sent in this pool. 0 resets to the caller.
    /// @dev Callable by any address, with or without shares, on live and cancelled pools. `address(this)`
    ///      reverts `BadPayout`.
    function setPayoutAddress(uint256 poolId, address to) external;

    // ------------------------------------------------------------------
    // Withdrawals
    // ------------------------------------------------------------------

    /// @notice Withdraws everything the caller has accrued in this pool, in whole USDC units.
    function withdraw(uint256 poolId) external returns (uint256 amount);

    /// @notice Withdraws on behalf of `member`. Funds always go to the member's payout address.
    function withdrawFor(uint256 poolId, address member) external returns (uint256 amount);

    /// @notice "Pay everyone": one accrual, then a payout per member. A member whose transfer fails or
    ///         whose claimable amount is zero is skipped; the batch never reverts because of one member.
    /// @dev A member with nothing payable is skipped *before* being settled, so this permissionless call
    ///      cannot force the settle rounding onto an arbitrary address (docs/SPEC.md 6.2).
    function withdrawForBatch(uint256 poolId, address[] calldata membersList) external returns (uint256 total);

    /// @notice Owner sweep of funds that have not been streamed yet; bounded by `unstreamed(poolId)`.
    /// @dev `to` may not be the singleton itself; that would silently destroy the swept units (`BadPayout`).
    function withdrawUnstreamed(uint256 poolId, uint256 amount, address to) external;

    /// @notice Stops the stream forever and refunds the unstreamed remainder. Members keep withdrawing.
    /// @dev `to` may not be the singleton itself (`BadPayout`).
    function cancel(uint256 poolId, address to) external returns (uint256 refund);

    // ------------------------------------------------------------------
    // Ownership (two-step, works on cancelled pools)
    // ------------------------------------------------------------------

    function transferPoolOwnership(uint256 poolId, address newOwner) external;
    function acceptPoolOwnership(uint256 poolId) external;

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getPool(uint256 poolId) external view returns (Pool memory);
    function getMember(uint256 poolId, address member) external view returns (Member memory);
    /// @notice USDC units `member` could withdraw right now (simulated accrue + settle, floored).
    function claimable(uint256 poolId, address member) external view returns (uint256 units);
    /// @notice Timestamp at which the pool freezes; `type(uint64).max` when nothing is streaming.
    function fundedUntil(uint256 poolId) external view returns (uint64);
    /// @notice USDC units the owner may still sweep or be refunded: `balance - ceil(owed / 1e12)`.
    function unstreamed(uint256 poolId) external view returns (uint256 units);
}
