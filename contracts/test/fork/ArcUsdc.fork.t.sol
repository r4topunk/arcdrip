// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {DripPool} from "../../src/DripPool.sol";
import {IDripPool} from "../../src/interfaces/IDripPool.sol";

/// @dev The slice of USDC that DripPool and this test touch. Arc's USDC is a FiatToken-like ERC-20 view of the
///      native coin at 0x3600...0000 with 6 decimals (PRD 9).
interface IArcUsdc {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/// @notice PRD 8.1 "Fork test against Arc testnet USDC (`deposit`, `withdraw`)". Everything runs on a LOCAL
///         fork: no transaction is ever broadcast and no funds are ever spent. Balances come from `vm.deal`,
///         which credits the native coin that Arc's USDC is a view of.
///
///         Skipped unless an RPC is configured, so an offline `forge test` stays green:
///
///             ARC_TESTNET_RPC=https://rpc.testnet.arc.io forge test --match-contract ArcUsdcFork -vv
///
///         `ARC_RPC` is accepted as a fallback (mainnet), and `ARC_FORK_BLOCK` pins a block so forge can cache
///         the fork state.
///
///         Known limitation, inherited from the same author's ArcSeal fork test: on a plain local fork a USDC
///         `transfer` / `transferFrom` reaches a native-coin precompile at 0x1800...0000 that only Arc nodes
///         implement; locally the call into it reverts. The test probes that precompile once:
///         with it, the full deposit/withdraw cycle runs against the real token; without it, the moving-money
///         part is skipped with a message and the read-only checks still run. That is the "mock-only" case
///         recorded as an UNKNOWN in PRD 14.
contract ArcUsdcForkTest is Test {
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    uint256 internal constant ARC_MAINNET = 5042;
    uint256 internal constant ARC_TESTNET = 5042002;

    uint128 internal constant RATE = 1e12; // 1 USDC unit per second
    uint256 internal constant ONE_USDC = 1e6;

    IArcUsdc internal usdc = IArcUsdc(USDC);
    bool internal enabled;
    bool internal transfersWork;

    function setUp() public {
        string memory rpc = vm.envOr("ARC_TESTNET_RPC", string(""));
        if (bytes(rpc).length == 0) rpc = vm.envOr("ARC_RPC", string(""));
        if (bytes(rpc).length == 0) return;

        uint256 forkBlock = vm.envOr("ARC_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, forkBlock);
        enabled = true;

        transfersWork = _probeTransfer();
    }

    modifier onlyFork() {
        if (!enabled) {
            vm.skip(true, "set ARC_TESTNET_RPC (or ARC_RPC) to run the Arc fork tests");
            return;
        }
        _;
    }

    // ------------------------------------------------------------------
    // The token itself
    // ------------------------------------------------------------------

    function test_fork_UsdcMatchesTheAssumptionsInThePrd() public onlyFork {
        assertTrue(block.chainid == ARC_MAINNET || block.chainid == ARC_TESTNET, "not an Arc chain");
        assertGt(USDC.code.length, 0, "no USDC code at 0x3600...0000");
        assertEq(usdc.decimals(), 6, "USDC is not 6 decimals");
        // `balanceOf` is served by the fork's state, so it always works; `transfer` and `totalSupply` are
        // delegated to the native-coin precompile, whose real behaviour lives in the Arc node and reverts in a
        // local EVM. Recorded, not asserted, so the day it starts working this test does not turn red.
        console.log("USDC transfers executable on this fork: %s", transfersWork);
    }

    /// @dev Arc keeps one balance: the native coin and the 6-decimal ERC-20 view are the same money.
    function test_fork_NativeBalanceIsTheUsdcBalance() public onlyFork {
        address holder = makeAddr("arcdrip-fork-holder");
        assertEq(usdc.balanceOf(holder), 0);
        vm.deal(holder, 2.5 ether);
        assertEq(usdc.balanceOf(holder), 2_500_000, "1 native unit is not 1e-6 USDC");
    }

    // ------------------------------------------------------------------
    // DripPool against the real token
    // ------------------------------------------------------------------

    /// @notice Deploying and creating a pool must work against the real token, whether or not transfers can
    ///         execute locally.
    function test_fork_DeployAndCreatePool() public onlyFork {
        DripPool drip = new DripPool(USDC);
        assertEq(address(drip.usdc()), USDC);

        address owner = makeAddr("arcdrip-fork-owner");
        uint256 poolId = drip.createPool(owner, RATE, 0, "fork pool");
        IDripPool.Pool memory p = drip.getPool(poolId);
        assertEq(p.owner, owner);
        assertEq(p.ratePerSecond, RATE);
        assertEq(drip.unstreamed(poolId), 0);
        assertEq(drip.fundedUntil(poolId), type(uint64).max, "an empty pool with no shares is never funded out");
    }

    /// @notice PRD 8.1: `deposit` then `withdraw` against Arc's real USDC.
    function test_fork_DepositAndWithdrawWithRealUsdc() public onlyFork {
        if (!transfersWork) {
            console.log("SKIPPED: USDC transfers need Arc's native-coin precompile, absent on a local fork");
            return;
        }

        DripPool drip = new DripPool(USDC);
        address owner = makeAddr("arcdrip-fork-owner2");
        address funder = makeAddr("arcdrip-fork-funder");
        address member = makeAddr("arcdrip-fork-member");
        vm.deal(funder, 10 ether);

        uint256 poolId = drip.createPool(owner, RATE, 0, "fork payroll");
        vm.prank(owner);
        drip.setShares(poolId, member, 1);

        vm.startPrank(funder);
        usdc.approve(address(drip), type(uint256).max);
        drip.deposit(poolId, ONE_USDC);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(drip)), ONE_USDC, "deposit did not reach the contract");

        vm.warp(block.timestamp + 1 hours);
        uint256 expected = 3600; // 1 unit/s for one hour
        assertEq(drip.claimable(poolId, member), expected, "claimable diverged from the rate");

        uint256 before = usdc.balanceOf(member);
        vm.prank(member);
        uint256 units = drip.withdraw(poolId);
        assertEq(units, expected);
        assertEq(usdc.balanceOf(member) - before, expected, "member was not paid on the real token");
        assertEq(usdc.balanceOf(address(drip)), ONE_USDC - expected);

        // The last unit is still solvent: I2 on the real token.
        IDripPool.Pool memory p = drip.getPool(poolId);
        assertLe(p.owed, p.balance * 1e12);
        assertLe(p.balance, usdc.balanceOf(address(drip)));
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev One-off probe: can a USDC transfer execute on this fork at all?
    function _probeTransfer() internal returns (bool ok) {
        address probe = makeAddr("arcdrip-fork-probe");
        vm.deal(probe, 1 ether);
        vm.prank(probe);
        (bool success, bytes memory ret) =
            USDC.call(abi.encodeCall(IArcUsdc.transfer, (makeAddr("arcdrip-fork-probe-sink"), 1)));
        ok = success && (ret.length == 0 || abi.decode(ret, (bool)));
        if (!ok) console.log("USDC transfers do not execute on this fork; the transfer paths are skipped");
    }
}
