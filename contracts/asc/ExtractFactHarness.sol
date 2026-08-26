// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BitcoinFactVerifier.sol";

/// @title Extraction test harness
/// @notice Test-only. Exposes BitcoinFactVerifier's payload decoding without
///         invoking the BlockProver precompile, which does not exist on a
///         local test EVM. Lets us prove the decoder handles a genuine
///         Attestcoin V1 payload correctly and rejects malformed ones.
/// @dev NOT for deployment. Skipping the proof step is exactly what makes this
///      unsafe in production — it is only safe here because the tests supply
///      the payload directly instead of trusting a caller.
contract ExtractFactHarness is BitcoinFactVerifier {
    constructor(uint64 chainKey, address emitter) BitcoinFactVerifier(chainKey, emitter) {}

    function extractFact(bytes calldata encodedTransaction)
        external
        view
        returns (bytes32 txid, uint32 index, uint64 value)
    {
        return _extractFact(encodedTransaction);
    }
}
