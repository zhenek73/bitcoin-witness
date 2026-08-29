// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Bitcoin Witness Receiver
/// @notice Deployed on exSat's EVM layer. Receives Bitcoin UTXO facts
///         relayed from exSat's native layer (the `btcwitness` Antelope
///         contract, calling `evm.xsat`'s `call()` action) and emits them as a
///         standard EVM event. That event — a real transaction with real logs
///         on exSat's EVM chain — is what Creditcoin's Attestcoin protocol
///         attests, and what `BitcoinFactVerifier` later authenticates on
///         Creditcoin.
/// @dev v1 scope: existence + value of one unspent Bitcoin output.
///      scriptpubkey / address is intentionally out of scope — see
///      docs/ARCHITECTURE.md "V1 scope".
contract BitcoinWitnessReceiver {
    /// @notice The only address allowed to submit facts: the EVM-mapped
    ///         ("reserved") address of the native `btcwitness` account.
    /// @dev exSat's EVM derives it deterministically from the Antelope account
    ///      name: 0xbbbbbbbb ‖ name_u64 (8 bytes, big-endian) ‖ 8 zero bytes.
    ///      For the account `btcwitness` that is
    ///      0xbBBbbBbb3E51c7666AC600000000000000000000.
    address public immutable relayer;

    /// @notice Emitted once per relayed Bitcoin UTXO fact.
    /// @param txid Bitcoin transaction id, exactly as exSat's `utxomng.xsat`
    ///        index stores it (see docs/ARCHITECTURE.md "txid byte order").
    /// @param index vout index of the output within that transaction.
    /// @param value Output value, in satoshis.
    /// @param relayer_ The relaying address (always `relayer`; indexed so the
    ///        Creditcoin verifier can authenticate authorship from the log
    ///        topics alone).
    event BitcoinUtxoAttested(bytes32 indexed txid, uint32 index, uint64 value, address indexed relayer_);

    error NotRelayer(address caller);

    constructor(address _relayer) {
        require(_relayer != address(0), "relayer must not be zero");
        relayer = _relayer;
    }

    /// @notice Called by `evm.xsat` on behalf of the native `btcwitness`
    ///         contract via its `relayutxo` action.
    /// @dev Access control here is defence in depth, not the load-bearing
    ///      check. The authoritative one lives in `BitcoinFactVerifier` on
    ///      Creditcoin, which requires the log's indexed relayer topic to match
    ///      the expected address — that check survives a redeploy of this
    ///      contract and cannot be bypassed by emitting the same event from
    ///      somewhere else. Rejecting non-relayer callers here simply keeps
    ///      junk out of the logs and makes the failure obvious at the source.
    function receiveUtxoFact(bytes32 txid, uint32 index, uint64 value) external {
        if (msg.sender != relayer) revert NotRelayer(msg.sender);
        emit BitcoinUtxoAttested(txid, index, value, msg.sender);
    }
}
