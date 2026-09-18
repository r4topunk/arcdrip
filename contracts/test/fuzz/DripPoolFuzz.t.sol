// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {DripPool} from "../../src/DripPool.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {RationalAcc} from "./RationalAcc.sol";

/// @notice PRD 8.1 "Fuzz: random op sequences vs an exact-rational reference model (I5)".
///
///         Every fuzz run drives one pool with five members through a random sequence of deposits, rate
///         changes, re-weightings, withdrawals, batch payouts, unstreamed recovery and cancellation, with
///         random time jumps in between. Alongside it the test keeps two independent models:
///
///         1. **Pool mirror** - an integer reimplementation of PRD 4.2 (`from`, the `available / rate` freeze
///            cap, `owed`) written from the spec, not from `DripPool.sol`. After every step the mirror's
///            `balance` and `owed` must equal the contract's simulated state *exactly*. This is what catches a
///            wrong freeze, a missing `_accrue` or a mis-signed `owed` update.
///         2. **Exact-rational entitlement** - per member, the sum over intervals of `streamed * shares /
///            totalShares` in exact rational arithmetic (`RationalAcc`, no floors). PRD 4.5 I5: everything a
///            member has been paid plus everything they can still claim must never exceed it. The contract
///            floors twice (index, then settle) and both floors favour the pool, so the gap is dust; the test
///            asserts the direction, never equality.
///
///         Bounds (rate <= 1e18 wad/s, dt <= 1e6 s, shares <= 1e6, deposit <= 1e12 units) keep every reference
///         term numerator `streamed * shares` at or below 1e30, which is what `RationalAcc` needs to stay
///         exact. The MAX_* corners are covered by `test/unit/DripPoolBounds.t.sol` instead.
contract DripPoolFuzzTest is Test {
    using RationalAcc for RationalAcc.Acc;

    uint256 internal constant WAD = 1e12;
    uint256 internal constant INDEX_SCALE = 1e18;
    uint256 internal constant N = 5; // members
    uint256 internal constant OPS = 12; // ops per run

    uint128 internal constant MAX_FUZZ_RATE = 1e18; // wad/s = 1e6 USDC/s
    uint256 internal constant MAX_FUZZ_DT = 1e6; // ~11.6 days per jump
    uint128 internal constant MAX_FUZZ_SHARES = 1e6;
    uint256 internal constant MAX_FUZZ_DEPOSIT = 1e12; // 1e6 USDC

    DripPool internal drip;
    MockUSDC internal usdc;

    address internal owner = makeAddr("fuzz-owner");
    address internal funder = makeAddr("fuzz-funder");
    address internal sink = makeAddr("fuzz-sink");
    address[N] internal member;

    // ---- pool mirror (PRD 4.2, written from the spec) ----
    struct Mirror {
        uint128 rate;
        uint128 totalShares;
        uint256 balance;
        uint256 owed;
        uint64 lastAccrual;
        uint64 startTime;
        bool cancelled;
    }

    Mirror internal mir;
    uint128[N] internal mShares;

    // ---- exact-rational reference, per member (wad) ----
    RationalAcc.Acc[N] internal entitled;
    uint256[N] internal paidWad;

    uint256 internal poolId;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        drip = new DripPool(address(usdc));
        for (uint256 i; i < N; ++i) {
            member[i] = makeAddr(string.concat("fuzz-member-", vm.toString(i)));
        }
        usdc.mint(funder, type(uint128).max);
        vm.prank(funder);
        usdc.approve(address(drip), type(uint256).max);
    }

    // ------------------------------------------------------------------
    // The fuzz entry point
    // ------------------------------------------------------------------

    /// forge-config: default.fuzz.runs = 600
    function testFuzz_OpSequenceNeverOverPays(uint256 rateSeed, uint256 startSeed, uint256[OPS] calldata seeds) public {
        uint128 rate = uint128(bound(rateSeed, 0, MAX_FUZZ_RATE));
        // a third of the runs start in the future, so the `startTime` branch of `_from` is exercised
        uint64 startTime =
            startSeed % 3 == 0 ? uint64(bound(startSeed >> 8, block.timestamp, block.timestamp + 5e5)) : 0;

        poolId = drip.createPool(owner, rate, startTime, "fuzz pool");
        mir.rate = rate;
        mir.startTime = startTime;
        mir.lastAccrual = uint64(block.timestamp);

        // a first deposit most of the time, so the early ops are not all no-ops on an empty pool
        if (rateSeed % 4 != 0) {
            uint256 seed0 = uint256(keccak256(abi.encode(rateSeed, startSeed)));
            _deposit(bound(seed0, 1, MAX_FUZZ_DEPOSIT));
        }

        for (uint256 i; i < OPS; ++i) {
            uint256 seed = seeds[i];
            vm.warp(block.timestamp + bound(seed >> 8, 0, MAX_FUZZ_DT));
            _mirrorAccrue();
            _step(seed);
            _assertMirrorMatches();
            _assertNeverOverPaid();
        }

        // Final sweep: pay everyone, then assert once more on settled state.
        _mirrorAccrue();
        _batch();
        _assertMirrorMatches();
        _assertNeverOverPaid();
        _assertSolvent();
        assertEq(_flushes(), 0, "reference model hit the rational overflow valve; tighten the fuzz bounds");
    }

    // ------------------------------------------------------------------
    // Ops
    // ------------------------------------------------------------------

    function _step(uint256 seed) internal {
        uint256 op = seed % 8;
        uint256 s = seed >> 64;

        if (op == 0) {
            // time only; touch the views so a reverting view is caught too
            drip.claimable(poolId, member[s % N]);
            drip.fundedUntil(poolId);
            drip.unstreamed(poolId);
        } else if (op == 1) {
            if (!mir.cancelled) _deposit(bound(s, 1, MAX_FUZZ_DEPOSIT));
        } else if (op == 2) {
            if (!mir.cancelled) _setRate(uint128(bound(s, 0, MAX_FUZZ_RATE)));
        } else if (op == 3 || op == 4) {
            if (!mir.cancelled) _setShares(s % N, uint128(bound(s >> 8, 0, MAX_FUZZ_SHARES)));
        } else if (op == 5) {
            _withdraw(s % N);
        } else if (op == 6) {
            _batch();
        } else {
            // cancel is rare (it ends every owner action), otherwise recover unstreamed funds
            if (!mir.cancelled && (s >> 32) % 8 == 0) _cancel();
            else if (!mir.cancelled) _withdrawUnstreamed(s);
        }
    }

    function _deposit(uint256 amount) internal {
        vm.prank(funder);
        drip.deposit(poolId, amount);
        mir.balance += amount;
    }

    function _setRate(uint128 rate) internal {
        vm.prank(owner);
        drip.setRate(poolId, rate);
        mir.rate = rate;
    }

    function _setShares(uint256 i, uint128 shares) internal {
        if (mShares[i] == shares) return; // NoOp reverts by design
        vm.prank(owner);
        drip.setShares(poolId, member[i], shares);
        mir.totalShares = uint128(uint256(mir.totalShares) - mShares[i] + shares);
        mShares[i] = shares;
    }

    function _withdraw(uint256 i) internal {
        uint256 before = usdc.balanceOf(member[i]);
        vm.prank(member[i]);
        try drip.withdraw(poolId) returns (uint256 units) {
            assertEq(usdc.balanceOf(member[i]) - before, units, "withdraw returned the wrong amount");
            _recordPayout(i, units);
        } catch (bytes memory err) {
            // truncating the revert data to its selector is the point here
            // forge-lint: disable-next-line(unsafe-typecast)
            assertEq(bytes4(err), IDripPool.NothingToWithdraw.selector, "unexpected withdraw revert");
            assertEq(drip.claimable(poolId, member[i]), 0, "NothingToWithdraw with a non-zero claimable");
        }
    }

    function _batch() internal {
        address[] memory list = new address[](N);
        uint256[N] memory before;
        for (uint256 i; i < N; ++i) {
            list[i] = member[i];
            before[i] = usdc.balanceOf(member[i]);
        }

        // withdrawForBatch is permissionless and must never revert (D15)
        vm.prank(sink);
        uint256 total = drip.withdrawForBatch(poolId, list);

        uint256 sum;
        for (uint256 i; i < N; ++i) {
            uint256 units = usdc.balanceOf(member[i]) - before[i];
            sum += units;
            _recordPayout(i, units);
        }
        assertEq(sum, total, "batch total does not match what members received");
    }

    function _withdrawUnstreamed(uint256 seed) internal {
        uint256 max = drip.unstreamed(poolId);
        if (max == 0) return;
        uint256 amount = bound(seed, 1, max);
        vm.prank(owner);
        drip.withdrawUnstreamed(poolId, amount, sink);
        mir.balance -= amount;
    }

    function _cancel() internal {
        vm.prank(owner);
        uint256 refund = drip.cancel(poolId, sink);
        mir.balance -= refund;
        mir.rate = 0;
        mir.cancelled = true;
    }

    function _recordPayout(uint256 i, uint256 units) internal {
        if (units == 0) return;
        paidWad[i] += units * WAD;
        mir.balance -= units;
        mir.owed -= units * WAD;
    }

    // ------------------------------------------------------------------
    // Models
    // ------------------------------------------------------------------

    /// @dev PRD 4.2 transcribed: accrue the mirror up to `block.timestamp` and credit every member their exact
    ///      rational share of what was streamed. Accrual is additive over sub-intervals (the freeze cap only
    ///      ever binds once), so the mirror may accrue more often than the contract does.
    function _mirrorAccrue() internal {
        uint256 from = mir.lastAccrual > mir.startTime ? mir.lastAccrual : mir.startTime;
        if (block.timestamp > from && mir.rate > 0 && mir.totalShares > 0) {
            uint256 available = mir.balance * WAD - mir.owed;
            uint256 dt = block.timestamp - from;
            uint256 funded = available / mir.rate;
            if (funded < dt) dt = funded;
            if (dt > 0) {
                uint256 streamed = uint256(mir.rate) * dt;
                for (uint256 i; i < N; ++i) {
                    if (mShares[i] != 0) entitled[i].add(streamed * mShares[i], mir.totalShares);
                }
                mir.owed += streamed;
            }
        }
        mir.lastAccrual = uint64(block.timestamp);
    }

    /// @dev The contract's `owed` / `accIndex` as of now, i.e. PRD 4.2 applied to stored state without writing.
    ///      Reimplemented here (not read from the contract) so the two are genuinely independent.
    function _sim() internal view returns (uint256 accIndex, uint256 owed) {
        IDripPool.Pool memory p = drip.getPool(poolId);
        (accIndex, owed) = (p.accIndex, p.owed);
        uint256 from = p.lastAccrual > p.startTime ? p.lastAccrual : p.startTime;
        if (block.timestamp > from && p.ratePerSecond > 0 && p.totalShares > 0) {
            uint256 available = p.balance * WAD - owed;
            uint256 dt = block.timestamp - from;
            uint256 funded = available / p.ratePerSecond;
            if (funded < dt) dt = funded;
            uint256 streamed = uint256(p.ratePerSecond) * dt;
            accIndex += (streamed * INDEX_SCALE) / p.totalShares;
            owed += streamed;
        }
    }

    // ------------------------------------------------------------------
    // Assertions
    // ------------------------------------------------------------------

    function _assertMirrorMatches() internal view {
        IDripPool.Pool memory p = drip.getPool(poolId);
        (, uint256 owed) = _sim();
        assertEq(p.balance, mir.balance, "mirror balance diverged");
        assertEq(owed, mir.owed, "mirror owed diverged (freeze cap or accrual order)");
        assertEq(p.totalShares, mir.totalShares, "mirror totalShares diverged");
        assertEq(p.ratePerSecond, mir.rate, "mirror rate diverged");
        assertEq(p.cancelled, mir.cancelled, "mirror cancelled diverged");
    }

    /// @dev PRD 4.5 I5.
    function _assertNeverOverPaid() internal view {
        (uint256 accIndex,) = _sim();
        uint256 sumEntitlement;
        for (uint256 i; i < N; ++i) {
            IDripPool.Member memory m = drip.getMember(poolId, member[i]);
            uint256 claimableWad = m.pending + (uint256(m.shares) * (accIndex - m.index)) / INDEX_SCALE;
            sumEntitlement += claimableWad;
            assertLe(
                paidWad[i] + claimableWad, entitled[i].whole, "I5: member holds more than the exactly-split stream"
            );
        }
        // I1, on simulated state: nobody can collectively claim more than `owed`.
        (, uint256 owed) = _sim();
        assertLe(sumEntitlement, owed, "I1: members claim more than the pool owes");
    }

    function _assertSolvent() internal view {
        IDripPool.Pool memory p = drip.getPool(poolId);
        assertLe(p.owed, p.balance * WAD, "I2: owed exceeds balance");
        assertLe(p.balance, usdc.balanceOf(address(drip)), "I3: pool balance exceeds the token balance");
    }

    function _flushes() internal view returns (uint256 total) {
        for (uint256 i; i < N; ++i) {
            total += entitled[i].flushes;
        }
    }
}
