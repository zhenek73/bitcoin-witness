// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read side of BitcoinFactVerifier. See contracts/asc/BitcoinFactVerifier.sol.
interface IBitcoinFactVerifier {
    function getProvenValue(bytes32 txid, uint32 index)
        external
        view
        returns (uint64 value, uint64 sourceHeight, uint64 provenAt, bool proven);
}

interface ITotalSupply {
    function totalSupply() external view returns (uint256);
}

/// @title ReserveGuard
/// @notice Makes "wrapped supply must never exceed Bitcoin reserves" a
///         precondition of the mint transaction instead of a claim in a
///         monthly PDF.
///
/// @dev WHY THIS EXISTS
///
///      Every wrapped-BTC system carries the invariant
///      `supply(wBTC) <= reserves(BTC)`. Today that invariant is enforced
///      socially: an auditor checks it after the fact, on a schedule, off
///      chain. The large bridge losses of the last few years (Ronin,
///      Wormhole, Nomad, BNB Bridge) are all the same shape -- an attacker
///      finds a path that mints tokens which were never backed, and exits
///      inside a few blocks, long before any human looks at a reserve report.
///
///      Nobody enforces the invariant at runtime because no EVM chain could
///      read Bitcoin. Bitcoin Witness removes that excuse: the reserve balance
///      arrives in this contract as a fact proven from Bitcoin itself, through
///      exSat's UTXO index and an Attestcoin attestation, with no custodian
///      asserting anything. So the check moves from the report to the
///      transaction, and an unbacked mint does not get flagged -- it reverts.
///
///      WHAT THIS DOES NOT DO
///
///      1. It stops INFLATION, not THEFT. An attacker who drains already
///         backed tokens out of a pool leaves supply and reserves both
///         unchanged; the invariant holds and this contract will not object.
///         The claim is "you cannot print what is not there", never "funds
///         cannot be stolen".
///      2. The issuer declares which outpoints are its reserves. A lying
///         issuer is still a lying issuer. What changes is that the lie is a
///         single public, permanent, checkable statement rather than a
///         recurring private assertion -- and outpoints are globally unique,
///         so two issuers claiming the same reserve is detectable by anyone.
///      3. Proofs have latency (Bitcoin confirmations, then attestation
///         depth). So the number here is the reserve as of some minutes ago,
///         never the reserve as of this instant. Note the direction of that
///         error: a deposit not yet proven is simply not counted, so lag makes
///         this contract stricter, never more permissive. Staleness is
///         conservative by construction.
///      4. A UTXO proven unspent at height H may be spent at H+1. `maxFactAge`
///         is the answer: a fact older than the window stops counting toward
///         reserves entirely, which again errs toward blocking mints.
contract ReserveGuard {
    struct Outpoint {
        bytes32 txid;
        uint32 index;
    }

    /// The verifier whose proven facts this guard trusts. Immutable: swapping
    /// the source of truth after the fact would defeat the entire point.
    IBitcoinFactVerifier public immutable verifier;

    /// The party that declares reserve outpoints and mints. Immutable for the
    /// same reason.
    address public immutable issuer;

    /// The wrapped token whose supply is constrained. Read from the token
    /// itself rather than passed in by the caller -- a caller-supplied supply
    /// figure would make this check theatre.
    ITotalSupply public token;

    /// Seconds after which a proven fact stops counting toward reserves.
    /// Zero disables the window (useful only for tests).
    uint64 public maxFactAge;

    Outpoint[] private _reserves;
    mapping(bytes32 => uint256) private _slotPlusOne;

    event ReserveDeclared(bytes32 indexed txid, uint32 indexed index);
    event ReserveRemoved(bytes32 indexed txid, uint32 indexed index);
    event TokenSet(address token);
    event MaxFactAgeSet(uint64 maxFactAge);

    error NotIssuer();
    error TokenAlreadySet();
    error ZeroAddress();
    error AlreadyDeclared();
    error NotDeclared();
    error NoTokenSet();

    /// @dev Carries the numbers that made the mint impossible, so an operator
    ///      reading a failed transaction sees the shortfall and how much
    ///      reserve went uncounted for staleness, not just a bare revert.
    error Insolvent(uint256 supplyAfter, uint256 provenReserves, uint256 staleOutpoints);

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert NotIssuer();
        _;
    }

    constructor(address _verifier, address _issuer, uint64 _maxFactAge) {
        if (_verifier == address(0) || _issuer == address(0)) revert ZeroAddress();
        verifier = IBitcoinFactVerifier(_verifier);
        issuer = _issuer;
        maxFactAge = _maxFactAge;
        emit MaxFactAgeSet(_maxFactAge);
    }

    function setToken(address _token) external onlyIssuer {
        if (address(token) != address(0)) revert TokenAlreadySet();
        if (_token == address(0)) revert ZeroAddress();
        token = ITotalSupply(_token);
        emit TokenSet(_token);
    }

    function setMaxFactAge(uint64 _maxFactAge) external onlyIssuer {
        maxFactAge = _maxFactAge;
        emit MaxFactAgeSet(_maxFactAge);
    }

    /// @notice Declare a Bitcoin outpoint as part of this issuer's reserve.
    /// @dev Declaring does not make it count. Only a fact proven through
    ///      BitcoinFactVerifier, and still inside the freshness window, adds
    ///      to the number `checkMint` compares against.
    function declareReserve(bytes32 txid, uint32 index) external onlyIssuer {
        bytes32 k = _key(txid, index);
        if (_slotPlusOne[k] != 0) revert AlreadyDeclared();
        _reserves.push(Outpoint({txid: txid, index: index}));
        _slotPlusOne[k] = _reserves.length;
        emit ReserveDeclared(txid, index);
    }

    /// @notice Remove a declared outpoint (for example once it has been spent
    ///         in a legitimate redemption).
    function removeReserve(bytes32 txid, uint32 index) external onlyIssuer {
        bytes32 k = _key(txid, index);
        uint256 slot = _slotPlusOne[k];
        if (slot == 0) revert NotDeclared();
        uint256 i = slot - 1;
        uint256 last = _reserves.length - 1;
        if (i != last) {
            Outpoint memory moved = _reserves[last];
            _reserves[i] = moved;
            _slotPlusOne[_key(moved.txid, moved.index)] = i + 1;
        }
        _reserves.pop();
        delete _slotPlusOne[k];
        emit ReserveRemoved(txid, index);
    }

    function reserveCount() external view returns (uint256) {
        return _reserves.length;
    }

    function reserveAt(uint256 i) external view returns (bytes32 txid, uint32 index) {
        Outpoint memory o = _reserves[i];
        return (o.txid, o.index);
    }

    /// @notice Total reserve, in satoshis, that is currently proven AND fresh.
    /// @return totalSats satoshis counted toward the invariant
    /// @return counted number of outpoints that contributed
    /// @return stale number of declared outpoints ignored as unproven or aged out
    /// @dev Linear in the number of declared outpoints, with one staticcall
    ///      each. Fine at demo scale and for a real issuer holding a handful of
    ///      cold outpoints; an issuer with thousands would keep a checkpointed
    ///      aggregate updated on each proof instead. The semantics would not
    ///      change, only the gas.
    function provenReserves()
        public
        view
        returns (uint256 totalSats, uint256 counted, uint256 stale)
    {
        uint64 nowTs = uint64(block.timestamp);
        uint64 window = maxFactAge;
        uint256 n = _reserves.length;
        for (uint256 i = 0; i < n; i++) {
            Outpoint memory o = _reserves[i];
            (uint64 value,, uint64 provenAt, bool proven) = verifier.getProvenValue(o.txid, o.index);
            if (!proven) {
                stale++;
                continue;
            }
            if (window != 0 && nowTs > provenAt && nowTs - provenAt > window) {
                stale++;
                continue;
            }
            totalSats += value;
            counted++;
        }
    }

    /// @notice Revert unless minting `amount` would keep supply within proven
    ///         reserves. This is the whole contract.
    /// @dev View, not state-changing: it is a precondition, and a precondition
    ///      that mutated state would be a second thing to get wrong. The revert
    ///      data carries the shortfall.
    function checkMint(uint256 amount) public view {
        if (address(token) == address(0)) revert NoTokenSet();
        uint256 supplyAfter = token.totalSupply() + amount;
        (uint256 reserves, , uint256 stale) = provenReserves();
        if (supplyAfter > reserves) revert Insolvent(supplyAfter, reserves, stale);
    }

    /// @notice Everything a dashboard, an auditor or a judge needs, in one call.
    function solvency()
        external
        view
        returns (
            uint256 provenReserveSats,
            uint256 wrappedSupply,
            uint256 countedOutpoints,
            uint256 staleOutpoints,
            bool solvent
        )
    {
        (provenReserveSats, countedOutpoints, staleOutpoints) = provenReserves();
        wrappedSupply = address(token) == address(0) ? 0 : token.totalSupply();
        solvent = wrappedSupply <= provenReserveSats;
    }

    function _key(bytes32 txid, uint32 index) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(txid, index));
    }
}
