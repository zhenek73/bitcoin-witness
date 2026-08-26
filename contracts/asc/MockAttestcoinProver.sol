// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BitcoinFactVerifier.sol";

/// @title Mock Attestcoin Prover
/// @notice Test-only stand-in for Creditcoin's Prover contract, letting us
///         exercise BitcoinFactVerifier's authentication logic without a live
///         Creditcoin node. Mirrors the real `getQueryDetails` shape exactly
///         (taken from the official prover ABI).
/// @dev NOT for deployment. This mock does no proving whatsoever — it just
///      returns whatever result segments a test puts in. It verifies our
///      consumer logic, not Attestcoin itself.
contract MockAttestcoinProver {
    mapping(bytes32 => IAttestcoinProver.QueryDetails) private _details;

    function setQueryDetails(
        bytes32 queryId,
        uint8 state,
        uint64 chainId,
        uint64 height,
        uint64 index,
        bytes32[] calldata words
    ) external {
        IAttestcoinProver.QueryDetails storage d = _details[queryId];
        d.state = state;
        d.query.chainId = chainId;
        d.query.height = height;
        d.query.index = index;

        delete d.resultSegments;
        for (uint256 i = 0; i < words.length; i++) {
            d.resultSegments.push(IAttestcoinProver.ResultSegment({offset: i, abiBytes: words[i]}));
        }
    }

    function getQueryDetails(bytes32 queryId) external view returns (IAttestcoinProver.QueryDetails memory) {
        return _details[queryId];
    }
}
