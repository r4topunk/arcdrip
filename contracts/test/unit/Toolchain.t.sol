// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Scaffold-only guard: proves forge-std and the OpenZeppelin pieces DripPool depends on
/// (SafeERC20, ReentrancyGuard) resolve through remappings.txt and compile at the pinned solc.
/// Delete once contracts/test/unit holds the real DripPool suite.
contract ToolchainProbe is ReentrancyGuard {
    using SafeERC20 for IERC20;

    function guarded() external nonReentrant returns (uint256) {
        return 1;
    }
}

contract ToolchainTest is Test {
    function test_ToolchainWiring() public {
        ToolchainProbe probe = new ToolchainProbe();
        assertEq(probe.guarded(), 1);
    }
}
