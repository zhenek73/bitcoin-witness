// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Attestcoin Prover interface
/// @notice Minimal interface to Creditcoin's Attestcoin Prover contract.
/// @dev Structs and signatures taken verbatim from the Prover ABI shipped in
///      Gluwa's official tutorial repo (`ccnext-testnet-bridge-examples`,
///      src/contract-abis/prover.json), not reconstructed by hand.
///
///      How the query model works: the attested payload is an ABI encoding of
///      the source transaction *and its receipt*. Rather than decoding that
///      blob on-chain, a query declares `LayoutSegment{offset,size}` entries
///      naming the fields it wants, and the prover returns exactly those as
///      `ResultSegment{offset, abiBytes}` — one 32-byte word each, in the
///      order requested. Segments are built off-chain with Gluwa's
///      QueryBuilder (see scripts/).
interface IAttestcoinProver {
    struct LayoutSegment {
        uint64 offset;
        uint64 size;
    }

    struct ChainQuery {
        uint64 chainId; // Attestcoin chain_key of the source chain (NOT the EVM chainId)
        uint64 height; // block height on the source chain
        uint64 index; // transaction index within that block
        LayoutSegment[] layoutSegments;
    }

    struct ResultSegment {
        uint256 offset;
        bytes32 abiBytes;
    }

    struct QueryDetails {
        uint8 state;
        ChainQuery query;
        uint256 escrowedAmount;
        address principal;
        uint256 estimatedCost;
        uint256 timestamp;
        ResultSegment[] resultSegments;
    }

    function getQueryDetails(bytes32 queryId) external view returns (QueryDetails memory);
}

/// @title Bitcoin Fact Verifier
/// @notice Deployed on Creditcoin. Consumes a proven Attestcoin query for a
///         transaction that called `BitcoinWitnessReceiver.receiveUtxoFact`
///         on exSat's EVM layer, authenticates it, and records the Bitcoin
///         fact it carried as proven on Creditcoin.
///
/// @dev v1 scope: the (txid, index) -> value fact. See docs/ARCHITECTURE.md.
///
///      The query this contract expects must be built with exactly this
///      layout, in this order (see scripts/ for the QueryBuilder script):
///        [0] RxStatus              — receipt status (1 == success)
///        [1] TxTo                  — transaction recipient
///        [2] event address         — contract that emitted the event
///        [3] event signature       — topic0
///        [4] event arg `txid`
///        [5] event arg `index`
///        [6] event arg `value`
contract BitcoinFactVerifier {
    IAttestcoinProver public immutable prover;

    /// Attestcoin chain_key under which our exSat source chain is registered.
    /// NOTE: chain_key is Attestcoin's own registry id and is NOT the EVM
    /// chainId — they differ (e.g. Ethereum mainnet is chainId 1 but
    /// chain_key 3). Set at construction to whatever `register_chain`
    /// assigned.
    uint64 public immutable exsatChainKey;

    /// Address of our `BitcoinWitnessReceiver` on exSat's EVM layer. Facts
    /// are only accepted if they were emitted by this contract, in a
    /// transaction sent to this contract.
    address public immutable expectedEmitter;

    /// keccak256("BitcoinUtxoAttested(bytes32,uint32,uint64,address)")
    bytes32 public constant EVENT_SIGNATURE = 0x8ada6206a51055064d662d325820d3282b8bff502d55098f7182a1d8a64187fe;

    uint256 private constant SEG_RX_STATUS = 0;
    uint256 private constant SEG_TX_TO = 1;
    uint256 private constant SEG_EVENT_ADDRESS = 2;
    uint256 private constant SEG_EVENT_SIGNATURE = 3;
    uint256 private constant SEG_TXID = 4;
    uint256 private constant SEG_INDEX = 5;
    uint256 private constant SEG_VALUE = 6;
    uint256 private constant SEGMENT_COUNT = 7;

    /// Proven UTXO values, keyed by (txid, vout index).
    mapping(bytes32 => mapping(uint32 => uint64)) public provenUtxoValue;
    /// True once a (txid, index) pair has been proven — distinguishes a
    /// genuinely proven zero value from "never proven".
    mapping(bytes32 => mapping(uint32 => bool)) public isProven;

    /// Replay guard. NOTE: a queryId identifies a *transaction*, not an
    /// individual event — if one transaction ever emits several facts, this
    /// guard would drop all but the first. v1 relays exactly one fact per
    /// transaction, so this is correct here; revisit before batching.
    mapping(bytes32 => bool) public queryUsed;

    event BitcoinFactProven(bytes32 indexed txid, uint32 index, uint64 value, uint64 height, bytes32 queryId);

    constructor(address proverAddress, uint64 _exsatChainKey, address _expectedEmitter) {
        prover = IAttestcoinProver(proverAddress);
        exsatChainKey = _exsatChainKey;
        expectedEmitter = _expectedEmitter;
    }

    /// @notice Record a Bitcoin UTXO fact from an already-proven Attestcoin query.
    /// @param queryId Id of a query that has completed proving on the Prover contract.
    function recordProvenFact(bytes32 queryId) external returns (bytes32 txid, uint32 index, uint64 value) {
        require(!queryUsed[queryId], "BitcoinWitness: query already used");
        queryUsed[queryId] = true;

        IAttestcoinProver.QueryDetails memory details = prover.getQueryDetails(queryId);
        IAttestcoinProver.ResultSegment[] memory segments = details.resultSegments;

        // A query that has not finished proving has no result segments.
        require(segments.length == SEGMENT_COUNT, "BitcoinWitness: unexpected segment layout");

        // Authenticate the source: the fact is only meaningful if it came
        // from OUR contract, on the chain we registered. Checking the
        // emitter without the chain_key would be forgeable — the same
        // contract address can exist on another chain and emit an
        // indistinguishable event.
        require(details.query.chainId == exsatChainKey, "BitcoinWitness: wrong source chain");
        require(_toAddress(segments[SEG_TX_TO].abiBytes) == expectedEmitter, "BitcoinWitness: wrong tx recipient");
        require(
            _toAddress(segments[SEG_EVENT_ADDRESS].abiBytes) == expectedEmitter, "BitcoinWitness: wrong event emitter"
        );
        require(segments[SEG_EVENT_SIGNATURE].abiBytes == EVENT_SIGNATURE, "BitcoinWitness: wrong event signature");

        // A reverted transaction can still be included in a block; its
        // events would not exist, but the status check makes the intent
        // explicit rather than relying on that.
        require(uint256(segments[SEG_RX_STATUS].abiBytes) == 1, "BitcoinWitness: source tx did not succeed");

        txid = segments[SEG_TXID].abiBytes;
        index = uint32(uint256(segments[SEG_INDEX].abiBytes));
        value = uint64(uint256(segments[SEG_VALUE].abiBytes));

        provenUtxoValue[txid][index] = value;
        isProven[txid][index] = true;

        emit BitcoinFactProven(txid, index, value, details.query.height, queryId);
    }

    /// @notice Read a previously proven UTXO value.
    /// @return value satoshis, `proven` false if this pair was never proven.
    function getProvenValue(bytes32 txid, uint32 index) external view returns (uint64 value, bool proven) {
        return (provenUtxoValue[txid][index], isProven[txid][index]);
    }

    function _toAddress(bytes32 word) private pure returns (address) {
        return address(uint160(uint256(word)));
    }
}
