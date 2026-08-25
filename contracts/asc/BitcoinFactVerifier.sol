// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Attestcoin BlockProver interface
/// @notice Minimal interface to Creditcoin's BlockProver precompile.
/// @dev Address and function signatures confirmed against two independent
///      sources: docs.creditcoin.org (attestcoin-protocol-chains-environments)
///      AND the actual runtime source (gluwa/creditcoin3,
///      runtime/src/precompiles.rs: `PrecompileAt<AddressU64<4050>,
///      BlockProverPrecompile<R>, ...>` — 4050 decimal == 0xFD2).
///      Struct field semantics (esp. ContinuityProof's first field) are
///      inferred from usage in precompiles/block-prover/src/tests.rs, not
///      from an official field-name spec — verify before depending on it.
interface IBlockProver {
    struct MerkleProofEntry {
        bytes32 sibling;
        bool isLeft;
    }

    struct TransactionMerkleProof {
        bytes32 root;
        MerkleProofEntry[] siblings;
    }

    struct ContinuityProof {
        // Inferred meaning: hash of the block immediately preceding the
        // continuity chain (blocks[0] is at queryHeight-1, per the
        // precompile's own doc comment). Name not officially confirmed.
        bytes32 anchorHash;
        bytes32[] blocks;
    }

    event TransactionVerified(uint64 indexed chainKey, uint64 indexed height, uint64 transactionIndex);

    /// State-changing verify — emits `TransactionVerified` on success, reverts on failure.
    function verifyAndEmit(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        TransactionMerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external returns (bool);

    /// Read-only verify — same checks, no event, no state change.
    function verify(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        TransactionMerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external view returns (bool);
}

/// @title Bitcoin Fact Verifier
/// @notice Deployed on Creditcoin. Consumes an Attestcoin proof for a
///         transaction sent to our `BitcoinWitnessReceiver` contract on
///         exSat EVM, verifies it via the BlockProver precompile, decodes
///         the Bitcoin fact from the transaction's calldata, and stores it
///         as a proven fact on Creditcoin.
/// @dev v1 scope: only the (txid, index) -> value fact from
///      `receiveUtxoFact(bytes32,uint32,uint64)` calldata. See
///      docs/ARCHITECTURE.md "V1 scope".
contract BitcoinFactVerifier {
    IBlockProver public immutable blockProver;

    /// The Attestcoin chain_key our exSat source chain was registered
    /// under via `register_chain` on our Creditcoin devnet. Set at
    /// construction — TODO: fill in with the real value once
    /// `register_chain` has actually been called (see docs/stream).
    uint64 public immutable exsatChainKey;

    /// selector for receiveUtxoFact(bytes32,uint32,uint64), same constant
    /// used on the exSat EVM side (contracts/evm/BitcoinWitnessReceiver.sol)
    /// and computed in the native relay contract
    /// (contracts/native/src/btcwitness.cpp).
    bytes4 public constant RECEIVE_UTXO_FACT_SELECTOR = 0x67b449eb;

    /// proven[txid][index] = value, once verified. 0 means "not yet proven"
    /// (v1 doesn't distinguish "proven zero-value" from "unproven" — a
    /// real zero-value Bitcoin output is not a meaningful case for v1).
    mapping(bytes32 => mapping(uint32 => uint64)) public provenUtxoValue;

    event BitcoinFactProven(bytes32 indexed txid, uint32 index, uint64 value, uint64 height);

    constructor(address blockProverAddress, uint64 _exsatChainKey) {
        blockProver = IBlockProver(blockProverAddress);
        exsatChainKey = _exsatChainKey;
    }

    /// @notice Verify an Attestcoin proof for a transaction that called
    ///         `receiveUtxoFact` on our exSat EVM receiver, and record the
    ///         Bitcoin fact it carried.
    /// @param height Block height on exSat EVM where the transaction was included.
    /// @param encodedTransaction Raw encoded transaction (as required by BlockProver).
    /// @param merkleProof Merkle inclusion proof for the transaction.
    /// @param continuityProof Continuity proof anchoring the block to an attestation/checkpoint.
    function proveBitcoinUtxoFact(
        uint64 height,
        bytes calldata encodedTransaction,
        IBlockProver.TransactionMerkleProof calldata merkleProof,
        IBlockProver.ContinuityProof calldata continuityProof
    ) external returns (bytes32 txid, uint32 index, uint64 value) {
        bool ok = blockProver.verifyAndEmit(exsatChainKey, height, encodedTransaction, merkleProof, continuityProof);
        require(ok, "Attestcoin: proof verification failed");

        (txid, index, value) = _decodeUtxoFact(encodedTransaction);

        provenUtxoValue[txid][index] = value;
        emit BitcoinFactProven(txid, index, value, height);
    }

    /// @dev Extracts (txid, index, value) from the calldata of a
    ///      `receiveUtxoFact(bytes32,uint32,uint64)` call embedded inside
    ///      the attested transaction. `encodedTransaction` is the raw
    ///      transaction as passed to the precompile — its calldata portion
    ///      is what we decode here. The exact transaction encoding (RLP
    ///      layout, where calldata starts) is NOT yet independently
    ///      verified against a real attested transaction — TODO before
    ///      relying on this in production: confirm `encodedTransaction`'s
    ///      format against an actual `verifyAndEmit` call in the existing
    ///      tutorials (ccnext-testnet-bridge-examples), not just this
    ///      precompile's Rust source.
    function _decodeUtxoFact(bytes calldata encodedTransaction)
        private
        pure
        returns (bytes32 txid, uint32 index, uint64 value)
    {
        // Placeholder extraction assuming encodedTransaction's calldata
        // portion starts with the 4-byte selector followed by the three
        // ABI-encoded words, identical to what BitcoinWitnessReceiver
        // expects on exSat EVM. NOT YET WIRED to real transaction RLP
        // decoding — see TODO above.
        revert("TODO: decode encodedTransaction (see NatSpec TODO above)");
    }
}
