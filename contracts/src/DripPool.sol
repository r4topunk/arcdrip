// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IDripPool} from "./interfaces/IDripPool.sol";

/// @title DripPool
/// @notice Shared USDC stream for collectives: one rate, N shares, live runway.
/// @dev Immutable singleton, no contract-level owner, no fees, no upgradeability. See docs/SPEC.md.
///
///      Accounting. Internal amounts are wad = USDC units x 1e12, so a rate as small as 1 USDC/month
///      never rounds to zero. `accIndex` is wad-per-share scaled by INDEX_SCALE; a member's entitlement
///      is `pending + shares * (accIndex - index) / INDEX_SCALE`. Changing one member's shares therefore
///      re-prices everyone from that second on without writing to anybody else's storage.
///
///      Solvency. `_accrue` caps elapsed time by `available / rate`, where `available = balance * 1e12 -
///      owed`. Because rate and totalShares are constant between accruals, that cap is exactly "streaming
///      stopped when the money ran out", so `owed <= balance * 1e12` always holds and no `fundedUntil` has
///      to be stored. Frozen time is never back-paid: a deposit resumes the stream from its own timestamp.
///
///      Rounding. Every division floors, and every floor favours the pool: `owed` grows by the full
///      `streamed` while members collectively receive at most that much. The difference is dust that stays
///      in `owed` forever, bounded by 1 wad (1e-18 USDC) per accrual thanks to MAX_TOTAL_SHARES.
contract DripPool is IDripPool, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @inheritdoc IDripPool
    uint256 public constant WAD_PER_UNIT = 1e12;
    /// @inheritdoc IDripPool
    uint256 public constant INDEX_SCALE = 1e18;
    /// @inheritdoc IDripPool
    uint256 public constant MAX_RATE = 1e30;
    /// @inheritdoc IDripPool
    uint256 public constant MAX_SHARES = 1e15;
    /// @inheritdoc IDripPool
    uint256 public constant MAX_TOTAL_SHARES = 1e18;
    /// @inheritdoc IDripPool
    uint256 public constant MAX_BATCH = 100;

    /// @inheritdoc IDripPool
    IERC20 public immutable usdc;

    /// @inheritdoc IDripPool
    uint256 public nextPoolId = 1;

    mapping(uint256 poolId => Pool) internal pools;
    mapping(uint256 poolId => mapping(address member => Member)) internal members;

    /// @param usdc_ The ERC-20 streamed by this deployment (USDC 0x3600...0000 on Arc, 6 decimals).
    constructor(address usdc_) {
        if (usdc_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
    }

    // ------------------------------------------------------------------
    // Pool lifecycle
    // ------------------------------------------------------------------

    /// @inheritdoc IDripPool
    function createPool(address owner, uint128 ratePerSecond, uint64 startTime, string calldata name)
        external
        returns (uint256 poolId)
    {
        if (owner == address(0)) revert ZeroAddress();
        if (ratePerSecond > MAX_RATE) revert BadRate();
        if (startTime != 0 && startTime < block.timestamp) revert BadStartTime();

        poolId = nextPoolId++;
        Pool storage p = pools[poolId];
        p.owner = owner;
        p.startTime = startTime;
        p.lastAccrual = uint64(block.timestamp);
        p.ratePerSecond = ratePerSecond;

        emit PoolCreated(poolId, owner, ratePerSecond, startTime, name);
    }

    /// @inheritdoc IDripPool
    function deposit(uint256 poolId, uint256 amount) external nonReentrant {
        Pool storage p = _livePool(poolId);
        if (amount == 0) revert ZeroAmount();

        _accrue(p);
        p.balance += amount;

        emit Deposited(poolId, msg.sender, amount);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @inheritdoc IDripPool
    function setRate(uint256 poolId, uint128 ratePerSecond) external {
        Pool storage p = _ownerPool(poolId);
        if (ratePerSecond > MAX_RATE) revert BadRate();

        _accrue(p);
        uint128 oldRate = p.ratePerSecond;
        p.ratePerSecond = ratePerSecond;

        emit RateSet(poolId, oldRate, ratePerSecond);
    }

    /// @inheritdoc IDripPool
    function setShares(uint256 poolId, address member, uint128 shares) external {
        Pool storage p = _ownerPool(poolId);
        if (member == address(0)) revert ZeroAddress();
        if (member == address(this)) revert BadPayout(); // paying the singleton is a self-transfer: it burns funds
        if (shares > MAX_SHARES) revert BadShares();
        if (members[poolId][member].shares == shares) revert NoOp();

        _accrue(p);
        _setShares(p, poolId, member, shares);
    }

    /// @inheritdoc IDripPool
    function setSharesBatch(uint256 poolId, address[] calldata membersList, uint128[] calldata sharesList) external {
        Pool storage p = _ownerPool(poolId);
        uint256 n = membersList.length;
        if (n != sharesList.length) revert LengthMismatch();
        if (n > MAX_BATCH) revert TooManyItems();

        _accrue(p);
        for (uint256 i; i < n; ++i) {
            address member = membersList[i];
            uint128 shares = sharesList[i];
            if (member == address(0)) revert ZeroAddress();
            if (member == address(this)) revert BadPayout();
            if (shares > MAX_SHARES) revert BadShares();
            if (members[poolId][member].shares == shares) continue; // unchanged entries are skipped silently
            _setShares(p, poolId, member, shares);
        }
    }

    /// @inheritdoc IDripPool
    function setPayoutAddress(uint256 poolId, address to) external {
        _pool(poolId); // reverts PoolNotFound; allowed on cancelled pools
        if (to == address(this)) revert BadPayout();

        members[poolId][msg.sender].payout = to;
        emit PayoutAddressSet(poolId, msg.sender, to);
    }

    // ------------------------------------------------------------------
    // Withdrawals
    // ------------------------------------------------------------------

    /// @inheritdoc IDripPool
    function withdraw(uint256 poolId) external nonReentrant returns (uint256 amount) {
        return _withdraw(poolId, msg.sender);
    }

    /// @inheritdoc IDripPool
    function withdrawFor(uint256 poolId, address member) external nonReentrant returns (uint256 amount) {
        return _withdraw(poolId, member);
    }

    /// @inheritdoc IDripPool
    function withdrawForBatch(uint256 poolId, address[] calldata membersList)
        external
        nonReentrant
        returns (uint256 total)
    {
        Pool storage p = _pool(poolId);
        uint256 n = membersList.length;
        if (n > MAX_BATCH) revert TooManyItems();

        _accrue(p);
        for (uint256 i; i < n; ++i) {
            address member = membersList[i];
            Member storage m = members[poolId][member];

            // Peek at the entitlement without settling. `_settle` floors, and a sum of floors can be smaller
            // than the floor of the sum, so a settle that pays nothing would burn up to 1 wad of this member's
            // entitlement into `owed` dust. Because this function is permissionless (D15) that would be a free
            // grief lever on any address, so members with nothing payable are skipped before any write (I4).
            uint256 units = (m.pending + (uint256(m.shares) * (p.accIndex - m.index)) / INDEX_SCALE) / WAD_PER_UNIT;
            if (units == 0) continue; // nothing to pay: skipped silently, and not settled

            _settle(p, m);

            uint256 wad = units * WAD_PER_UNIT;
            m.pending -= wad;
            p.owed -= wad;
            p.balance -= units;

            address to = m.payout == address(0) ? member : m.payout;
            // `trySafeTransfer` is SafeERC20's non-reverting variant: same acceptance rule as
            // `safeTransfer` (success, and either empty return data or `true`), reported as a bool.
            if (usdc.trySafeTransfer(to, units)) {
                total += units;
                emit Withdrawn(poolId, member, to, units, msg.sender);
            } else {
                // Blocklisted payout or a token returning false: restore and keep going (D15).
                m.pending += wad;
                p.owed += wad;
                p.balance += units;
                emit WithdrawSkipped(poolId, member, units);
            }
        }
    }

    /// @inheritdoc IDripPool
    function withdrawUnstreamed(uint256 poolId, uint256 amount, address to) external nonReentrant {
        Pool storage p = _ownerPool(poolId);
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert BadPayout(); // a self-transfer would silently destroy the refund
        if (amount == 0) revert ZeroAmount();

        _accrue(p);
        if (amount > _unstreamed(p.balance, p.owed)) revert InsufficientUnstreamed();
        p.balance -= amount;

        emit UnstreamedWithdrawn(poolId, to, amount);
        usdc.safeTransfer(to, amount);
    }

    /// @inheritdoc IDripPool
    function cancel(uint256 poolId, address to) external nonReentrant returns (uint256 refund) {
        Pool storage p = _ownerPool(poolId);
        if (to == address(0)) revert ZeroAddress();
        if (to == address(this)) revert BadPayout(); // a self-transfer would silently destroy the refund

        _accrue(p);
        uint128 oldRate = p.ratePerSecond;
        p.ratePerSecond = 0;
        p.cancelled = true;

        refund = _unstreamed(p.balance, p.owed);
        if (refund != 0) p.balance -= refund;

        // `RateSet` is emitted here too: the rate is an accrual input, so an indexer replaying events must
        // see it go to zero without having to special-case `Cancelled` (PRD 4.4).
        if (oldRate != 0) emit RateSet(poolId, oldRate, 0);
        emit Cancelled(poolId, to, refund);
        if (refund != 0) usdc.safeTransfer(to, refund);
    }

    // ------------------------------------------------------------------
    // Ownership (two-step, works on cancelled pools)
    // ------------------------------------------------------------------

    /// @inheritdoc IDripPool
    function transferPoolOwnership(uint256 poolId, address newOwner) external {
        Pool storage p = _pool(poolId);
        if (msg.sender != p.owner) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();

        p.pendingOwner = newOwner;
        emit OwnershipTransferStarted(poolId, p.owner, newOwner);
    }

    /// @inheritdoc IDripPool
    function acceptPoolOwnership(uint256 poolId) external {
        Pool storage p = _pool(poolId);
        if (msg.sender != p.pendingOwner) revert NotPendingOwner();

        address oldOwner = p.owner;
        p.owner = msg.sender;
        p.pendingOwner = address(0);
        emit OwnershipTransferred(poolId, oldOwner, msg.sender);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    /// @inheritdoc IDripPool
    function getPool(uint256 poolId) external view returns (Pool memory) {
        return _pool(poolId);
    }

    /// @inheritdoc IDripPool
    function getMember(uint256 poolId, address member) external view returns (Member memory) {
        _pool(poolId);
        return members[poolId][member];
    }

    /// @inheritdoc IDripPool
    function claimable(uint256 poolId, address member) external view returns (uint256 units) {
        Pool storage p = _pool(poolId);
        (uint256 accIndex,) = _simulate(p);
        Member storage m = members[poolId][member];
        uint256 pending = m.pending + (uint256(m.shares) * (accIndex - m.index)) / INDEX_SCALE;
        return pending / WAD_PER_UNIT;
    }

    /// @inheritdoc IDripPool
    function fundedUntil(uint256 poolId) external view returns (uint64) {
        Pool storage p = _pool(poolId);
        uint128 rate = p.ratePerSecond;
        if (rate == 0 || p.totalShares == 0) return type(uint64).max;

        (, uint256 owed) = _simulate(p);
        // After the simulated accrual `lastAccrual` is `block.timestamp`, so accrual restarts here.
        uint256 from = _from(uint64(block.timestamp), p.startTime);
        uint256 available = p.balance * WAD_PER_UNIT - owed;
        uint256 end = from + available / rate;
        // casting to 'uint64' is safe because the ternary returns before it when `end` does not fit
        // forge-lint: disable-next-line(unsafe-typecast)
        return end > type(uint64).max ? type(uint64).max : uint64(end);
    }

    /// @inheritdoc IDripPool
    function unstreamed(uint256 poolId) external view returns (uint256 units) {
        Pool storage p = _pool(poolId);
        (, uint256 owed) = _simulate(p);
        return _unstreamed(p.balance, owed);
    }

    // ------------------------------------------------------------------
    // Accrual
    // ------------------------------------------------------------------

    /// @dev The single place where time enters the accounting. Must be called before any change to
    ///      `ratePerSecond`, `totalShares`, `balance` or `owed`.
    function _accrue(Pool storage p) internal {
        (uint256 accIndex, uint256 owed) = _accrueMath(
            block.timestamp,
            _from(p.lastAccrual, p.startTime),
            p.ratePerSecond,
            p.totalShares,
            p.balance,
            p.owed,
            p.accIndex
        );
        if (owed != p.owed) {
            p.accIndex = accIndex;
            p.owed = owed;
        }
        p.lastAccrual = uint64(block.timestamp);
    }

    /// @dev `_accrue` without writing, for views.
    function _simulate(Pool storage p) internal view returns (uint256 accIndex, uint256 owed) {
        return _accrueMath(
            block.timestamp,
            _from(p.lastAccrual, p.startTime),
            p.ratePerSecond,
            p.totalShares,
            p.balance,
            p.owed,
            p.accIndex
        );
    }

    /// @dev Pure accrual math shared by the state-changing path and the views, so they cannot drift.
    ///      `dt` is capped by the funded time, which is the freeze.
    function _accrueMath(
        uint256 nowTs,
        uint256 from,
        uint128 rate,
        uint128 totalShares,
        uint256 balance,
        uint256 owed,
        uint256 accIndex
    ) internal pure returns (uint256, uint256) {
        if (nowTs > from && rate > 0 && totalShares > 0) {
            uint256 available = balance * WAD_PER_UNIT - owed; // never negative: invariant I2
            uint256 dt = nowTs - from;
            uint256 funded = available / rate;
            if (funded < dt) dt = funded;
            if (dt > 0) {
                uint256 streamed = uint256(rate) * dt;
                accIndex += (streamed * INDEX_SCALE) / totalShares; // floor: favours the pool
                owed += streamed;
            }
        }
        return (accIndex, owed);
    }

    /// @dev Always called after `_accrue`. Moves the member's share of the index into `pending`.
    function _settle(Pool storage p, Member storage m) internal {
        uint256 accIndex = p.accIndex;
        uint256 index = m.index;
        if (accIndex != index) {
            uint256 shares = m.shares;
            if (shares != 0) m.pending += (shares * (accIndex - index)) / INDEX_SCALE; // floor
            m.index = accIndex;
        }
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _setShares(Pool storage p, uint256 poolId, address member, uint128 shares) internal {
        Member storage m = members[poolId][member];
        _settle(p, m);

        uint128 oldShares = m.shares;
        uint256 newTotal = uint256(p.totalShares) - oldShares + shares;
        if (newTotal > MAX_TOTAL_SHARES) revert BadShares();

        m.shares = shares;
        // casting to 'uint128' is safe because newTotal was just bounded by MAX_TOTAL_SHARES (1e18 < 2**128)
        // forge-lint: disable-next-line(unsafe-typecast)
        p.totalShares = uint128(newTotal);

        emit SharesSet(poolId, member, oldShares, shares, newTotal);
    }

    function _withdraw(uint256 poolId, address member) internal returns (uint256 units) {
        Pool storage p = _pool(poolId);
        _accrue(p);

        Member storage m = members[poolId][member];
        _settle(p, m);

        units = m.pending / WAD_PER_UNIT;
        if (units == 0) revert NothingToWithdraw();

        uint256 wad = units * WAD_PER_UNIT;
        m.pending -= wad;
        p.owed -= wad;
        p.balance -= units;

        address to = m.payout == address(0) ? member : m.payout;
        emit Withdrawn(poolId, member, to, units, msg.sender);
        usdc.safeTransfer(to, units);
    }

    function _pool(uint256 poolId) internal view returns (Pool storage p) {
        p = pools[poolId];
        if (p.owner == address(0)) revert PoolNotFound();
    }

    function _livePool(uint256 poolId) internal view returns (Pool storage p) {
        p = _pool(poolId);
        if (p.cancelled) revert PoolCancelled();
    }

    function _ownerPool(uint256 poolId) internal view returns (Pool storage p) {
        p = _pool(poolId);
        if (msg.sender != p.owner) revert NotOwner();
        if (p.cancelled) revert PoolCancelled();
    }

    function _from(uint64 lastAccrual, uint64 startTime) internal pure returns (uint256) {
        return lastAccrual > startTime ? lastAccrual : startTime;
    }

    /// @dev USDC units that are not backing `owed`. `ceilDiv` rounds the members' claim up, so a
    ///      fraction of a unit still owed is never handed to the owner.
    function _unstreamed(uint256 balance, uint256 owed) internal pure returns (uint256) {
        uint256 reserved = (owed + WAD_PER_UNIT - 1) / WAD_PER_UNIT;
        return balance > reserved ? balance - reserved : 0;
    }
}
