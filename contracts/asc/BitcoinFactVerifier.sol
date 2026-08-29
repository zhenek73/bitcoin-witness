// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Attestcoin BlockProver precompile
/// @dev Address and signature confirmed three ways: the official docs, the
///      Creditcoin runtime source (`runtime/src/precompiles.rs`:
///      `PrecompileAt<AddressU64<4050>, BlockProverPrecompile<R>, ...>` —
///      4050 == 0xFD2), and Gluwa's SDK
///      (`BLOCK_PROVER_PRECOMPILE_ADDRESS` in the cc-next-query-builder
///      package published by Gluwa).
///
///      NOTE: `verify` reverts on failure — it does not return false. Treat a
///      successful return as proof; there is no falsy branch to check.
interface IBlockProver {
    struct MerkleProofEntry {
        bytes32 hash;
        bool isLeft;
    }

    struct TransactionMerkleProof {
        bytes32 root;
        MerkleProofEntry[] siblings;
    }

    struct ContinuityProof {
        bytes32 lowerEndpointDigest;
        bytes32[] roots;
    }

    function verifyAndEmit(
        uint64 chainKey,
        uint64 height,
        bytes calldata encodedTransaction,
        TransactionMerkleProof calldata merkleProof,
        ContinuityProof calldata continuityProof
    ) external returns (bool);
}

/// @title Bitcoin Fact Verifier
/// @notice Deployed on Creditcoin. Verifies, entirely on-chain, that a
///         transaction really occurred on exSat's EVM layer in which our
///         `BitcoinWitnessReceiver` emitted a Bitcoin UTXO fact — then records
///         that fact.
///
/// @dev The attested payload is not a raw RLP transaction. Attestcoin's V1
///      encoding is `abi.encode(uint8 txType, bytes[] chunks)`, where
///      `chunks[0]` always holds the common transaction fields and the LAST
///      chunk always holds the receipt (status, gasUsed, logs, logsBloom).
///      That makes the emitted logs recoverable with plain `abi.decode`, so
///      this contract can authenticate the fact itself rather than trusting a
///      caller-supplied field layout. Layout verified against Gluwa's own
///      encoder (cc-next-query-builder package, encoding/abi/v1.js).
///
///      v1 scope: the (txid, index) -> value fact. See docs/ARCHITECTURE.md.
contract BitcoinFactVerifier {
    struct EvmLog {
        address addr;
        bytes32[] topics;
        bytes data;
    }

    IBlockProver public constant BLOCK_PROVER = IBlockProver(0x0000000000000000000000000000000000000FD2);

    /// Attestcoin chain_key for our exSat source chain, as assigned by
    /// `register_chain`. NOT the EVM chainId — the two differ (Ethereum
    /// mainnet is chainId 1 but chain_key 3), and confusing them yields a
    /// source check that silently never matches.
    uint64 public immutable exsatChainKey;

    /// Our `BitcoinWitnessReceiver` on exSat's EVM layer.
    address public immutable expectedEmitter;

    /// The EVM-mapped ("reserved") address of the native `btcwitness` account —
    /// the only address whose relayed facts we accept.
    ///
    /// This check is what makes the whole pipeline mean anything.
    /// `receiveUtxoFact` is callable by anyone on exSat EVM, so "this event was
    /// emitted by our contract, in a successful transaction, and Attestcoin
    /// proved it happened" is NOT the same statement as "this is a real Bitcoin
    /// fact". Attestation proves *occurrence*; only the relayer topic proves
    /// *authorship*, and authorship is what ties the claim back to the one code
    /// path that actually read `utxomng.xsat`.
    ///
    /// Derived from the Antelope account name: 0xbbbbbbbb ‖ name_u64 (8 bytes,
    /// big-endian) ‖ 8 zero bytes.
    address public immutable expectedRelayer;

    /// keccak256("BitcoinUtxoAttested(bytes32,uint32,uint64,address)")
    bytes32 public constant EVENT_SIGNATURE = 0x8ada6206a51055064d662d325820d3282b8bff502d55098f7182a1d8a64187fe;

    /// A proven fact is a statement about a *past* moment, not a live balance.
    /// `sourceHeight` is the exSat EVM height the proof was anchored at, and
    /// `provenAt` is when we recorded it. Both are stored, not just emitted,
    /// because a consumer deciding whether to lend against this UTXO needs to
    /// know how stale the claim is — and because exSat's Bitcoin index can lag
    /// Bitcoin itself by an arbitrary amount (it is only as current as its
    /// synchronizers make it). A UTXO proven unspent at height H may well have
    /// been spent since; nothing here can say otherwise.
    struct ProvenFact {
        uint64 value;        // satoshis
        uint64 sourceHeight; // exSat EVM block height the proof was anchored at
        uint64 provenAt;     // Creditcoin block timestamp when recorded
        bool proven;
    }

    mapping(bytes32 => mapping(uint32 => ProvenFact)) public facts;

    event BitcoinFactProven(bytes32 indexed txid, uint32 index, uint64 value, uint64 height);

    constructor(uint64 _exsatChainKey, address _expectedEmitter, address _expectedRelayer) {
        require(_expectedEmitter != address(0) && _expectedRelayer != address(0), "zero address");
        exsatChainKey = _exsatChainKey;
        expectedEmitter = _expectedEmitter;
        expectedRelayer = _expectedRelayer;
    }

    /// @notice Prove and record a Bitcoin UTXO fact.
    /// @param height Block height on exSat EVM containing the transaction.
    /// @param encodedTransaction Attestcoin V1-encoded transaction + receipt.
    /// @param merkleProof Inclusion proof for that transaction.
    /// @param continuityProof Proof anchoring the block to an attestation.
    /// @dev Continuity proofs are bound to attestation state at generation
    ///      time and go stale — generate one fresh per call rather than
    ///      reusing an old one.
    function proveBitcoinFact(
        uint64 height,
        bytes calldata encodedTransaction,
        IBlockProver.TransactionMerkleProof calldata merkleProof,
        IBlockProver.ContinuityProof calldata continuityProof
    ) external returns (bytes32 txid, uint32 index, uint64 value) {
        // Reverts on failure; a plain return means the payload is proven to
        // have occurred at (chainKey, height).
        BLOCK_PROVER.verifyAndEmit(exsatChainKey, height, encodedTransaction, merkleProof, continuityProof);

        (txid, index, value) = _extractFact(encodedTransaction);

        facts[txid][index] = ProvenFact({
            value: value,
            sourceHeight: height,
            provenAt: uint64(block.timestamp),
            proven: true
        });

        emit BitcoinFactProven(txid, index, value, height);
    }

    /// @dev Decodes the proven payload and pulls out our event. Everything
    ///      checked here is inside the attested bytes, so none of it can be
    ///      forged by the caller: the caller chooses only *which* proven
    ///      transaction to submit, not what it contains.
    function _extractFact(bytes calldata encodedTransaction)
        internal
        view
        returns (bytes32 txid, uint32 index, uint64 value)
    {
        (, bytes[] memory chunks) = abi.decode(encodedTransaction, (uint8, bytes[]));
        require(chunks.length >= 2, "BitcoinWitness: malformed payload");

        // Common fields are always chunk 0, across every transaction type.
        (,,,, address to,,) =
            abi.decode(chunks[0], (uint64, uint64, address, bool, address, uint256, bytes));
        require(to == expectedEmitter, "BitcoinWitness: wrong tx recipient");

        // Receipt is always the last chunk, across every transaction type.
        (uint8 status,, EvmLog[] memory logs,) =
            abi.decode(chunks[chunks.length - 1], (uint8, uint64, EvmLog[], bytes));
        require(status == 1, "BitcoinWitness: source tx did not succeed");

        for (uint256 i = 0; i < logs.length; i++) {
            EvmLog memory log = logs[i];
            if (log.addr != expectedEmitter) continue;
            // topics: [0] signature, [1] txid (indexed), [2] relayer (indexed)
            if (log.topics.length != 3 || log.topics[0] != EVENT_SIGNATURE) continue;
            // Authorship. Without this, anyone on exSat EVM can call
            // receiveUtxoFact directly with invented numbers and have them
            // proven here as genuine Bitcoin facts.
            if (log.topics[2] != bytes32(uint256(uint160(expectedRelayer)))) continue;

            // Non-indexed args, in declaration order: index (uint32), value (uint64).
            (uint32 idx, uint64 val) = abi.decode(log.data, (uint32, uint64));
            return (log.topics[1], idx, val);
        }

        revert("BitcoinWitness: no matching event in proven transaction");
    }

    /// @notice Read a proven fact together with everything needed to judge how
    ///         much it is still worth trusting.
    /// @return value satoshis at the time of proof
    /// @return sourceHeight exSat EVM height the proof was anchored at
    /// @return provenAt Creditcoin timestamp when it was recorded
    /// @return proven false if this pair was never proven — which a zero value
    ///         alone could not distinguish
    function getProvenValue(bytes32 txid, uint32 index)
        external
        view
        returns (uint64 value, uint64 sourceHeight, uint64 provenAt, bool proven)
    {
        ProvenFact memory f = facts[txid][index];
        return (f.value, f.sourceHeight, f.provenAt, f.proven);
    }

    /// @notice Seconds since this fact was recorded. Callers that care about
    ///         freshness (a lender, a reserve auditor) should gate on this
    ///         rather than on `proven` alone.
    function ageOf(bytes32 txid, uint32 index) external view returns (uint64) {
        ProvenFact memory f = facts[txid][index];
        require(f.proven, "BitcoinWitness: not proven");
        return uint64(block.timestamp) - f.provenAt;
    }
}
