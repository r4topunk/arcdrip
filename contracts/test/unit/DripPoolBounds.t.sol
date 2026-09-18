// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";

/// @dev The MAX_* guards, exercised at and just past the bound.
contract DripPoolBoundsTest is BaseTest {
    function test_MaxRate_StreamsWithoutOverflow() public {
        uint128 rate = uint128(drip.MAX_RATE()); // 1e30 wad/s = 1e18 units/s
        uint256 id = drip.createPool(owner, rate, 0, NAME);
        _setShares(id, alice, 1);
        _setShares(id, bob, 1);

        address whale = makeAddr("whale");
        _fund(whale, 4e18);
        vm.prank(whale);
        drip.deposit(id, 3e18); // 3 seconds of runway

        skip(2);
        assertEq(drip.claimable(id, alice), 1e18);
        assertEq(drip.claimable(id, bob), 1e18);
        assertEq(drip.unstreamed(id), 1e18);

        vm.prank(alice);
        assertEq(drip.withdraw(id), 1e18);
        _assertSolvent(id);
    }

    /// @dev At MAX_RATE a pool funded with less than one second of stream has `dt == 0`: the floor in
    ///      `available / rate` is the freeze, so nothing accrues rather than something unpayable.
    function test_MaxRate_UnderfundedPoolStreamsNothing() public {
        uint256 id = drip.createPool(owner, uint128(drip.MAX_RATE()), 0, NAME);
        _setShares(id, alice, 1);
        _deposit(id, ONE_USDC);

        skip(10);
        assertEq(drip.claimable(id, alice), 0);
        assertEq(drip.unstreamed(id), ONE_USDC);
        assertEq(drip.fundedUntil(id), uint64(block.timestamp));
    }

    function test_MaxTotalShares_AcceptedAtTheBound() public {
        uint256 id = _createPool();
        _fillToMaxTotalShares(id);
        assertEq(drip.getPool(id).totalShares, uint128(drip.MAX_TOTAL_SHARES()));
    }

    function test_MaxTotalShares_RevertsOnePastTheBound() public {
        uint256 id = _createPool();
        _fillToMaxTotalShares(id);

        vm.prank(owner);
        vm.expectRevert(IDripPool.BadShares.selector);
        drip.setShares(id, alice, 1);
    }

    function test_MaxTotalShares_AccrualDustStaysBelowOneWad() public {
        uint256 id = _createPool();
        _fillToMaxTotalShares(id); // 1000 members x 1e15 shares
        _deposit(id, ONE_USDC);
        skip(1000);

        drip.withdrawForBatch(id, new address[](0)); // force one accrual
        IDripPool.Pool memory p = drip.getPool(id);

        // accIndex floors at most 1 wad-per-share-unit of value per accrual.
        uint256 distributed = (uint256(p.accIndex) * p.totalShares) / 1e18;
        assertLe(p.owed - distributed, 1, "dust per accrual is under 1 wad");
    }

    function test_MaxTotalShares_TwoMembersCannotExceedItAlone() public {
        // MAX_SHARES (1e15) is 1/1000 of MAX_TOTAL_SHARES, so no single write can blow the total.
        uint256 id = _createPool();
        _setShares(id, alice, uint128(drip.MAX_SHARES()));
        _setShares(id, bob, uint128(drip.MAX_SHARES()));
        assertEq(drip.getPool(id).totalShares, 2 * drip.MAX_SHARES());
    }

    function test_SmallestUsefulRate() public {
        uint256 id = drip.createPool(owner, 1, 0, NAME); // 1 wad/s = 1e-18 USDC/s
        _setShares(id, alice, 1);
        _deposit(id, ONE_USDC);

        skip(1e12 - 1);
        assertEq(drip.claimable(id, alice), 0, "still under one unit");
        skip(1);
        assertEq(drip.claimable(id, alice), 1);
    }

    function test_LargeBalanceAndLongHorizon() public {
        // casting to uint128 is safe because 1000 * WAD is 1e15, far below MAX_RATE
        // forge-lint: disable-next-line(unsafe-typecast)
        uint128 rate = uint128(1000 * WAD); // 0.001 USDC/s ~ 86 USDC/day
        uint256 id = drip.createPool(owner, rate, 0, NAME);
        _setShares(id, alice, 3);
        _setShares(id, bob, 7);
        _deposit(id, 5_000_000 * ONE_USDC);

        skip(3650 days);
        uint256 streamed = (uint256(rate) * 3650 days) / WAD;
        assertEq(drip.claimable(id, alice) + drip.claimable(id, bob), streamed);
        _assertSolvent(id);
    }

    /// @dev 1000 members of MAX_SHARES each, in batches of MAX_BATCH.
    function _fillToMaxTotalShares(uint256 id) internal {
        uint128 per = uint128(drip.MAX_SHARES());
        uint256 batch = drip.MAX_BATCH();
        uint256 rounds = drip.MAX_TOTAL_SHARES() / (per * batch);

        for (uint256 r; r < rounds; ++r) {
            address[] memory ms = new address[](batch);
            uint128[] memory ss = new uint128[](batch);
            for (uint256 i; i < batch; ++i) {
                // casting to uint160 is safe because these are small synthetic test addresses
                // forge-lint: disable-next-line(unsafe-typecast)
                ms[i] = address(uint160(100_000 + r * batch + i));
                ss[i] = per;
            }
            vm.prank(owner);
            drip.setSharesBatch(id, ms, ss);
        }
    }
}
