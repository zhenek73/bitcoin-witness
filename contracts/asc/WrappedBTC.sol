// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReserveGuard {
    function checkMint(uint256 amount) external view;
}

/// @title MiniERC20
/// @notice Deliberately minimal ERC20. This is demo scaffolding around the
///         thing being demonstrated (ReserveGuard) -- not a token anyone
///         should ship. No permit, no hooks, no pausing, no ownership
///         transfer.
/// @dev 8 decimals, so one token unit is exactly one satoshi. That keeps the
///      solvency comparison unit-for-unit against the value returned by
///      BitcoinFactVerifier and removes a whole class of scaling bug from the
///      one line that matters.
abstract contract MiniERC20 {
    uint8 public constant decimals = 8;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public immutable issuer;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error NotIssuer();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(address _issuer) {
        issuer = _issuer;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < value) revert InsufficientAllowance();
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    function burn(uint256 value) external {
        if (balanceOf[msg.sender] < value) revert InsufficientBalance();
        balanceOf[msg.sender] -= value;
        totalSupply -= value;
        emit Transfer(msg.sender, address(0), value);
    }

    function _move(address from, address to, uint256 value) internal {
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _mint(address to, uint256 value) internal {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }
}

/// @title NaiveWBTC
/// @notice Wrapped BTC the way it is issued today: the mint path trusts
///         whoever is allowed to call it, and the reserve invariant lives in
///         a report somewhere else.
/// @dev Present in this repo on purpose. It is the control case. An attacker
///      who reaches this mint -- through a compromised key, a signature-check
///      bug, a bad upgrade -- prints unbacked supply and the chain records it
///      as a perfectly valid transaction, because nothing on chain knows what
///      the reserve is. That is not a flaw in this toy; that is the current
///      state of the art, reproduced faithfully so the comparison is fair.
contract NaiveWBTC is MiniERC20 {
    string public constant name = "Naive Wrapped BTC";
    string public constant symbol = "nwBTC";

    constructor(address _issuer) MiniERC20(_issuer) {}

    function mint(address to, uint256 amount) external onlyIssuer {
        _mint(to, amount);
    }
}

/// @title GuardedWBTC
/// @notice The same token, with one line added to the mint path.
/// @dev That line is the entire contribution. Everything else in this file is
///      identical to the naive version above; the difference in outcome is
///      produced by a single external view call that consults a reserve
///      balance proven from Bitcoin.
contract GuardedWBTC is MiniERC20 {
    string public constant name = "Guarded Wrapped BTC";
    string public constant symbol = "gwBTC";

    IReserveGuard public immutable guard;

    constructor(address _guard, address _issuer) MiniERC20(_issuer) {
        guard = IReserveGuard(_guard);
    }

    function mint(address to, uint256 amount) external onlyIssuer {
        // The one line. Reverts unless totalSupply + amount stays within the
        // reserve proven from Bitcoin through exSat and Attestcoin.
        guard.checkMint(amount);
        _mint(to, amount);
    }
}
