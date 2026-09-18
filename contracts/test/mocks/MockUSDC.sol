// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Test double of Circle's FiatToken v2.2 as deployed on Arc (0x3600...0000): 6 decimals and a
///         blocklist that makes transfers revert with FiatToken's own message. Modelled on ArcPull's mock.
/// @dev Adds `setReturnsFalse`, which makes `transfer` return false without reverting. Real USDC never
///      does this, but `withdrawForBatch` must treat it exactly like a revert (skip + restore), and that
///      branch is otherwise untestable.
contract MockUSDC {
    string public constant name = "USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isBlacklisted;
    uint256 public totalSupply;

    /// @dev When true, `transfer` is a no-op returning false.
    bool public returnsFalse;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        totalSupply += value;
        emit Transfer(address(0), to, value);
    }

    function blacklist(address account, bool value) external {
        isBlacklisted[account] = value;
    }

    function setReturnsFalse(bool value) external {
        returnsFalse = value;
    }

    modifier notBlacklisted(address account) {
        require(!isBlacklisted[account], "Blacklistable: account is blacklisted");
        _;
    }

    function approve(address spender, uint256 value)
        external
        notBlacklisted(msg.sender)
        notBlacklisted(spender)
        returns (bool)
    {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external notBlacklisted(msg.sender) notBlacklisted(to) returns (bool) {
        if (returnsFalse) return false;
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value)
        external
        notBlacklisted(msg.sender)
        notBlacklisted(from)
        notBlacklisted(to)
        returns (bool)
    {
        require(value <= allowance[from][msg.sender], "ERC20: transfer amount exceeds allowance");
        allowance[from][msg.sender] -= value;
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        require(from != address(0), "ERC20: transfer from the zero address");
        require(to != address(0), "ERC20: transfer to the zero address");
        require(value <= balanceOf[from], "ERC20: transfer amount exceeds balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
