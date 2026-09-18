// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DripPool} from "../src/DripPool.sol";

interface IERC20Decimals {
    function decimals() external view returns (uint8);
}

/// @notice Deterministic CREATE2 deployment of DripPool through the canonical deployer
///         0x4e59b44847b379578588920cA78FbF26c0B4956C (present on Arc mainnet, Arc testnet and every local anvil),
///         salt keccak256("arcdrip.v1"). The address depends only on the salt and the init code (bytecode plus the
///         single constructor argument), so mainnet and testnet get the same address for the same USDC.
///
/// Signer: a Foundry encrypted keystore held by the human operator (see DEPLOY.md). No private keys in env or code.
/// The e2e dry run (`pnpm e2e:dry-run`) runs this very script against a local anvil with --unlocked.
///
/// Env:
///   USDC_ADDRESS  default 0x3600...0000 (Arc USDC). Any other value is accepted only on a local chain (31337),
///                 where the dry run etches MockUSDC at the same address anyway.
///   SALT_LABEL    default "arcdrip.v1"; salt = keccak256(bytes(label)). A new label only for a new deployment.
///
///   # simulation only (no --broadcast): prints the predicted address, sends nothing
///   forge script script/Deploy.s.sol --rpc-url arc --account $DEPLOYER_ACCOUNT --sender $DEPLOYER_ADDRESS
///   # real deploy (operator only): the same command plus --broadcast, then record it
///   node script/record-deployment.mjs 5042
contract Deploy is Script {
    /// @notice Canonical CREATE2 deployer (Arachnid's deterministic-deployment-proxy). Forge routes
    ///         `new C{salt: s}()` through it when broadcasting.
    address public constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// @notice Arc USDC, ERC-20 view (6 decimals), on mainnet and testnet.
    address public constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    /// @notice Salt label of the v1 deployment. Never reuse it for different bytecode or arguments.
    string public constant DEFAULT_SALT_LABEL = "arcdrip.v1";

    uint256 internal constant ARC_MAINNET = 5042;
    uint256 internal constant ARC_TESTNET = 5042002;
    uint256 internal constant LOCAL = 31337;

    /// @notice The constructor argument plus the salt label.
    struct Params {
        address usdc;
        string saltLabel;
    }

    error UnsupportedChain(uint256 chainId);
    error MissingCreate2Deployer();
    error UsdcOverrideNotAllowed(address usdc);
    error MissingToken(address token);
    error WrongTokenDecimals(address token, uint8 decimals);
    error AddressMismatch(address expected, address actual);
    error StateMismatch(string field);

    /// @notice Entry point of `forge script`: reads the parameters from env, then deploys (or skips).
    function run() external returns (DripPool pool) {
        return deploy(paramsFromEnv());
    }

    /// @notice Deployment parameters from env, with the Arc defaults. Reverts on an unsupported chain or a USDC
    ///         override outside a local chain.
    function paramsFromEnv() public view returns (Params memory p) {
        uint256 chainId = block.chainid;
        _requireSupportedChain(chainId);
        p.usdc = vm.envOr("USDC_ADDRESS", ARC_USDC);
        if (chainId != LOCAL && p.usdc != ARC_USDC) revert UsdcOverrideNotAllowed(p.usdc);
        p.saltLabel = vm.envOr("SALT_LABEL", DEFAULT_SALT_LABEL);
    }

    /// @notice CREATE2 salt of a label: keccak256(bytes(label)).
    function saltOf(string memory label) public pure returns (bytes32) {
        return keccak256(bytes(label));
    }

    /// @notice Init code sent to the CREATE2 deployer: creation bytecode plus the ABI-encoded constructor argument.
    function initCode(Params memory p) public pure returns (bytes memory) {
        return abi.encodePacked(type(DripPool).creationCode, abi.encode(p.usdc));
    }

    /// @notice Address DripPool gets for `p` on any chain that has the CREATE2 deployer.
    function predict(Params memory p) public pure returns (address) {
        return vm.computeCreate2Address(saltOf(p.saltLabel), keccak256(initCode(p)), CREATE2_DEPLOYER);
    }

    /// @notice Deploys DripPool for `p` through the CREATE2 deployer, or returns the existing contract when the
    ///         predicted address already has code (idempotent). Reads the new contract back before returning.
    function deploy(Params memory p) public returns (DripPool pool) {
        uint256 chainId = block.chainid;
        _requireSupportedChain(chainId);
        if (CREATE2_DEPLOYER.code.length == 0) revert MissingCreate2Deployer();
        _requireUsdc(p.usdc);

        address expected = predict(p);
        console2.log("chainId", chainId);
        console2.log("usdc", p.usdc);
        console2.log("salt label", p.saltLabel);
        console2.log("salt");
        console2.logBytes32(saltOf(p.saltLabel));
        console2.log("DripPool (CREATE2)", expected);

        if (expected.code.length > 0) {
            console2.log("already deployed, nothing to do");
            return DripPool(expected);
        }

        vm.startBroadcast();
        pool = new DripPool{salt: saltOf(p.saltLabel)}(p.usdc);
        vm.stopBroadcast();

        if (address(pool) != expected) revert AddressMismatch(expected, address(pool));
        if (address(pool.usdc()) != p.usdc) revert StateMismatch("usdc");
        if (pool.nextPoolId() != 1) revert StateMismatch("nextPoolId");
        console2.log("deployed", address(pool));
    }

    function _requireSupportedChain(uint256 chainId) internal pure {
        if (chainId != ARC_MAINNET && chainId != ARC_TESTNET && chainId != LOCAL) revert UnsupportedChain(chainId);
    }

    /// @dev The token must exist and report 6 decimals (Arc USDC's ERC-20 view, or MockUSDC on anvil).
    function _requireUsdc(address token) internal view {
        if (token.code.length == 0) revert MissingToken(token);
        uint8 decimals = IERC20Decimals(token).decimals();
        if (decimals != 6) revert WrongTokenDecimals(token, decimals);
    }
}
