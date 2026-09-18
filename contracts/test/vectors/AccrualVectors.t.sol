// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../unit/Base.t.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";

/// @title Accrual vector export
/// @notice Writes `contracts/test/vectors/accrual.json`, the cross-check between the contract and the
///         SDK's offchain accrual mirror (`packages/sdk/src/math.ts`). Every vector is captured from a
///         real DripPool, so the file is the contract's own output, not a hand-written expectation.
///         Run `forge test --match-path 'test/vectors/*'` to regenerate it; the file is committed.
///
/// @dev JSON shape (every integer is a decimal STRING, so a JSON parser never loses precision on a
///      bigint; booleans are real JSON booleans):
///
///      {
///        "version":   1,
///        "generator": "contracts/test/vectors/AccrualVectors.t.sol",
///        "constants": { "wadPerUnit", "indexScale", "maxRate", "maxShares",
///                       "maxTotalShares", "uint64Max" },     // decimal strings
///        "vectors": [
///          {
///            "name":   "human label for the state under test",
///            "pool": {                 // exactly what `getPool(poolId)` returns, i.e. STORED state,
///              "startTime",            // not simulated to `now`
///              "lastAccrual",
///              "cancelled",            // boolean
///              "ratePerSecond",        // wad per second
///              "totalShares",
///              "balance",              // USDC units (6 decimals)
///              "owed",                 // wad
///              "accIndex"              // wad per share, scaled by indexScale
///            },
///            "member": {               // what `getMember(poolId, member)` returns for `address`
///              "address",              // 0x-prefixed, lowercase-insensitive
///              "shares",
///              "index",
///              "pending"               // wad
///            },
///            "now": "unix seconds at which the expectations were read (>= pool.lastAccrual)",
///            "expected": {
///              "claimable":   "USDC units the member could withdraw at `now`",
///              "fundedUntil": "unix seconds at which the pool freezes; uint64Max when idle",
///              "unstreamed":  "USDC units the owner could still sweep at `now`"
///            }
///          }
///        ]
///      }
///
///      A consumer feeds `pool`, `member` and `now` into its own accrue + settle implementation and must
///      reproduce `expected` exactly, with no tolerance.
contract AccrualVectorsTest is BaseTest {
    string internal constant OUT_PATH = "./test/vectors/accrual.json";
    uint256 internal constant MIN_VECTORS = 30;

    string[] internal entries;

    function test_ExportAccrualVectors() public {
        _scenarioSteadyStream();
        _scenarioUnevenShares();
        _scenarioFreeze();
        _scenarioPaused();
        _scenarioNoShares();
        _scenarioFutureStart();
        _scenarioAfterWithdrawal();
        _scenarioRemovedMember();
        _scenarioCancelled();
        _scenarioTinyRate();
        _scenarioMonthlySalary();
        _scenarioExtremes();

        assertGe(entries.length, MIN_VECTORS, "PRD 8.2 asks for at least 30 vectors");
        vm.writeFile(OUT_PATH, _render());

        // Read it back so a broken write fails the suite instead of shipping a truncated file.
        assertGt(bytes(vm.readFile(OUT_PATH)).length, 0);
    }

    // ------------------------------------------------------------------
    // Scenarios
    // ------------------------------------------------------------------

    /// @dev 1 unit/s over 4 shares, sampled through the stream.
    function _scenarioSteadyStream() internal {
        uint256 id = _standardPool();
        _capture("fresh pool, nothing elapsed", id, alice);
        skip(1);
        _capture("one second in, still below one unit", id, alice);
        skip(399);
        _capture("400 s in, 1 share of 4", id, alice);
        _capture("400 s in, 2 shares of 4", id, carol);
        _capture("400 s in, address with no shares", id, stranger);
        skip(86_400);
        _capture("one day in", id, carol);
    }

    /// @dev Shares that do not divide the stream: every floor matters.
    function _scenarioUnevenShares() internal {
        uint256 id = drip.createPool(owner, RATE + 7, 0, "uneven");
        _setShares(id, alice, 1);
        _setShares(id, bob, 2);
        _setShares(id, carol, 7);
        _deposit(id, 123_457);

        skip(37);
        _capture("uneven shares, 37 s, 1/10", id, alice);
        _capture("uneven shares, 37 s, 2/10", id, bob);
        _capture("uneven shares, 37 s, 7/10", id, carol);
        skip(4_931);
        _capture("uneven shares, 4968 s", id, carol);
    }

    /// @dev The freeze, at the boundary and past it.
    function _scenarioFreeze() internal {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _setShares(id, bob, 3);
        _deposit(id, 1_000);

        skip(999);
        _capture("one second before the pool runs dry", id, alice);
        skip(1);
        _capture("exactly at the freeze", id, alice);
        skip(10_000);
        _capture("long after the freeze", id, alice);
        _capture("long after the freeze, 3 shares", id, bob);

        _deposit(id, 500); // resume without back-pay
        skip(100);
        _capture("resumed after a freeze", id, alice);
    }

    function _scenarioPaused() internal {
        uint256 id = _standardPool();
        skip(1_000);
        _setRate(id, 0);
        skip(50_000);
        _capture("paused pool, rate 0", id, carol);

        _setRate(id, 3 * RATE);
        skip(10);
        _capture("resumed at a higher rate", id, carol);
    }

    function _scenarioNoShares() internal {
        uint256 id = _createPool();
        _deposit(id, ONE_USDC);
        skip(5_000);
        _capture("funded pool with no members", id, alice);

        _setShares(id, alice, 5);
        skip(60);
        _capture("first member joins a pool that never streamed", id, alice);
    }

    function _scenarioFutureStart() internal {
        uint64 start = uint64(block.timestamp + 7 days);
        uint256 id = drip.createPool(owner, RATE, start, "scheduled");
        _setShares(id, alice, 1);
        _deposit(id, 2 * ONE_USDC);

        skip(3 days);
        _capture("scheduled pool, before startTime", id, alice);
        skip(4 days + 250);
        _capture("scheduled pool, 250 s after startTime", id, alice);
    }

    /// @dev Non-zero `pending` and a member index that lags `accIndex`.
    function _scenarioAfterWithdrawal() internal {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _setShares(id, bob, 2);
        _deposit(id, ONE_USDC);

        skip(100);
        vm.prank(alice);
        drip.withdraw(id); // leaves a sub-unit remainder in alice's pending
        _capture("right after a withdrawal, remainder pending", id, alice);
        skip(45);
        _capture("45 s after a withdrawal", id, alice);
        _capture("member who never withdrew", id, bob);

        skip(3_600);
        vm.prank(bob);
        drip.withdraw(id);
        skip(17);
        _capture("second member withdrew later", id, bob);
    }

    function _scenarioRemovedMember() internal {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _setShares(id, bob, 1);
        _deposit(id, ONE_USDC);

        skip(2_000);
        _setShares(id, bob, 0); // removed, keeps what he earned
        _capture("removed member, accrued intact", id, bob);
        skip(2_000);
        _capture("removed member, later", id, bob);
        _capture("remaining member takes the whole rate", id, alice);
    }

    function _scenarioCancelled() internal {
        uint256 id = _createPool();
        _setShares(id, alice, 1);
        _setShares(id, carol, 2);
        _deposit(id, ONE_USDC);

        skip(1_234);
        vm.prank(owner);
        drip.cancel(id, owner);
        _capture("cancelled pool, at the cancel block", id, carol);
        skip(365 days);
        _capture("cancelled pool, a year later", id, carol);
    }

    function _scenarioTinyRate() internal {
        uint256 id = drip.createPool(owner, 1, 0, "one wad per second"); // 1e-18 USDC/s
        _setShares(id, alice, 1);
        _deposit(id, ONE_USDC);

        skip(1e12 - 1);
        _capture("1 wad/s, one second short of a unit", id, alice);
        skip(1);
        _capture("1 wad/s, exactly one unit", id, alice);
    }

    /// @dev D9's motivating case: 1 USDC per 30 days must not round to zero.
    function _scenarioMonthlySalary() internal {
        uint128 rate = uint128((ONE_USDC * WAD) / 30 days);
        uint256 id = drip.createPool(owner, rate, 0, "1 USDC / month");
        _setShares(id, alice, 1);
        _setShares(id, bob, 1);
        _deposit(id, 30 * ONE_USDC);

        skip(30 days);
        _capture("1 USDC/month, one month in", id, alice);
        skip(335 days);
        _capture("1 USDC/month, one year in", id, alice);
    }

    /// @dev The MAX_* bounds and the uint64 saturation of fundedUntil.
    function _scenarioExtremes() internal {
        uint256 fast = drip.createPool(owner, uint128(drip.MAX_RATE()), 0, "max rate");
        _setShares(fast, alice, 1);
        _deposit(fast, ONE_USDC);
        skip(10);
        _capture("MAX_RATE with less than one second of funding", fast, alice);

        address whale = makeAddr("whale");
        _fund(whale, 4e18);
        vm.prank(whale);
        drip.deposit(fast, 3e18);
        skip(2);
        _capture("MAX_RATE with two seconds streamed", fast, alice);

        uint256 slow = drip.createPool(owner, 1, 0, "endless");
        _setShares(slow, alice, uint128(drip.MAX_SHARES()));
        _deposit(slow, 1_000_000 * ONE_USDC);
        skip(3);
        _capture("MAX_SHARES member, fundedUntil saturates at uint64 max", slow, alice);

        uint256 big = _createPool();
        _setShares(big, alice, uint128(drip.MAX_SHARES()));
        _setShares(big, bob, uint128(drip.MAX_SHARES()) - 1);
        _deposit(big, 10 * ONE_USDC);
        skip(777);
        _capture("huge totalShares, 777 s", big, alice);
        _capture("huge totalShares, one share short", big, bob);
    }

    // ------------------------------------------------------------------
    // Capture and render
    // ------------------------------------------------------------------

    function _capture(string memory name, uint256 poolId, address member) internal {
        IDripPool.Pool memory p = drip.getPool(poolId);
        IDripPool.Member memory m = drip.getMember(poolId, member);

        string memory pool = string.concat(
            '{"startTime":"',
            vm.toString(uint256(p.startTime)),
            '","lastAccrual":"',
            vm.toString(uint256(p.lastAccrual)),
            '","cancelled":',
            p.cancelled ? "true" : "false",
            ',"ratePerSecond":"',
            vm.toString(uint256(p.ratePerSecond)),
            '","totalShares":"',
            vm.toString(uint256(p.totalShares)),
            '","balance":"',
            vm.toString(p.balance),
            '","owed":"',
            vm.toString(p.owed),
            '","accIndex":"',
            vm.toString(p.accIndex),
            '"}'
        );

        string memory mem = string.concat(
            '{"address":"',
            vm.toString(member),
            '","shares":"',
            vm.toString(uint256(m.shares)),
            '","index":"',
            vm.toString(m.index),
            '","pending":"',
            vm.toString(m.pending),
            '"}'
        );

        string memory expected = string.concat(
            '{"claimable":"',
            vm.toString(drip.claimable(poolId, member)),
            '","fundedUntil":"',
            vm.toString(uint256(drip.fundedUntil(poolId))),
            '","unstreamed":"',
            vm.toString(drip.unstreamed(poolId)),
            '"}'
        );

        entries.push(
            string.concat(
                '    {"name":"',
                name,
                '","pool":',
                pool,
                ',"member":',
                mem,
                ',"now":"',
                vm.toString(block.timestamp),
                '","expected":',
                expected,
                "}"
            )
        );
    }

    function _render() internal view returns (string memory out) {
        out = string.concat(
            "{\n",
            '  "version": 1,\n',
            '  "generator": "contracts/test/vectors/AccrualVectors.t.sol",\n',
            '  "constants": {"wadPerUnit":"',
            vm.toString(drip.WAD_PER_UNIT()),
            '","indexScale":"',
            vm.toString(drip.INDEX_SCALE()),
            '","maxRate":"',
            vm.toString(drip.MAX_RATE()),
            '","maxShares":"',
            vm.toString(drip.MAX_SHARES()),
            '","maxTotalShares":"',
            vm.toString(drip.MAX_TOTAL_SHARES()),
            '","uint64Max":"',
            vm.toString(uint256(type(uint64).max)),
            '"},\n',
            '  "vectors": [\n'
        );

        for (uint256 i; i < entries.length; ++i) {
            out = string.concat(out, entries[i], i + 1 == entries.length ? "\n" : ",\n");
        }
        out = string.concat(out, "  ]\n}\n");
    }
}
