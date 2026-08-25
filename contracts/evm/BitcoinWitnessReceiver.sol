// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Bitcoin Witness Receiver
/// @notice Deployed on exSat's EVM layer. Receives Bitcoin UTXO facts
///         relayed from exSat's native layer (the `btcwitness` Antelope
///         contract, calling exSat's `evm_runtime.call()` action) and
///         emits them as a standard EVM event. This event — a real
///         transaction with real logs on exSat's EVM chain — is what
///         Creditcoin's Attestcoin protocol attests and verifies on-chain,
///         which is what actually makes the Bitcoin fact provable to
///         Creditcoin without trusting us.
/// @dev v1 scope: proves existence + value of one unspent Bitcoin output.
///      scriptpubkey / address is intentionally out of scope for v1 — see
///      docs/ARCHITECTURE.md "V1 scope".
contract BitcoinWitnessReceiver {
    /// @notice Emitted once per relayed Bitcoin UTXO fact.
    /// @param txid Bitcoin transaction id (as reported by exSat's native
    ///        utxomng.xsat index).
    /// @param index vout index of the output within that transaction.
    /// @param value Output value, in satoshis.
    /// @param relayer EVM-mapped address of the native `btcwitness`
    ///        contract that relayed this fact (msg.sender).
    event BitcoinUtxoAttested(bytes32 indexed txid, uint32 index, uint64 value, address indexed relayer);

    /// @notice Called by exSat's evm_runtime on behalf of the native
    ///         `btcwitness` relay contract via its `relayutxo` action.
    ///         Anyone can call this directly too — the value of the claim
    ///         comes from Attestcoin proving *who* called it and *what*
    ///         was emitted, not from restricting the caller here. Trying to
    ///         relay a UTXO that doesn't really exist on exSat is caught
    ///         upstream, in `btcwitness::relayutxo`, which reads the real
    ///         `utxomng.xsat` table before ever reaching this call.
    function receiveUtxoFact(bytes32 txid, uint32 index, uint64 value) external {
        emit BitcoinUtxoAttested(txid, index, value, msg.sender);
    }
}
