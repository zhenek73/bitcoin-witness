#pragma once
#include <eosio/eosio.hpp>
#include <eosio/crypto.hpp>

// Bitcoin Witness — native relay contract (deployed on exSat's Antelope
// native layer, account name `btcwitness`).
//
// Reads a single Bitcoin UTXO fact directly from exSat's own `utxomng.xsat`
// table and relays it into an EVM transaction on exSat's EVM layer, whose
// event is what Creditcoin's Attestcoin protocol later attests and
// verifies. See ../../../docs/ARCHITECTURE.md for the full picture.
//
// v1 scope (deliberately narrow, see docs/ARCHITECTURE.md "V1 scope"):
// proves *existence + value* of one unspent Bitcoin output (txid, vout
// index, value in satoshis). scriptpubkey / address is out of scope for
// v1 — it's a dynamic-length field and adding it means real Solidity ABI
// dynamic-encoding, which is a deliberate v2 step, not a v1 blocker.

namespace bitcoinwitness {
    using namespace eosio;

    class [[eosio::contract("btcwitness")]] btc_witness : public contract {
       public:
        using contract::contract;

        /**
         * ## ACTION `relayutxo`
         *
         * - **authority**: `get_self()`
         *
         * Look up a Bitcoin UTXO by (txid, vout index) in exSat's
         * `utxomng.xsat` table and relay its existence + value into an EVM
         * transaction on exSat's EVM layer, targeting `evm_to` (a deployed
         * `BitcoinWitnessReceiver` contract implementing
         * `receiveUtxoFact(bytes32,uint32,uint64)`).
         *
         * Fails if the UTXO is not found (spent, never existed, or not yet
         * indexed by exSat).
         *
         * ### params
         * - `{checksum256} txid` — Bitcoin transaction id
         * - `{uint32_t} index` — vout index
         * - `{vector<uint8_t>} evm_to` — 20-byte EVM address of the receiver contract
         * - `{uint64_t} gas_limit` — EVM gas limit for the relayed call
         */
        [[eosio::action]]
        void relayutxo(const checksum256& txid, const uint32_t index, const std::vector<uint8_t>& evm_to,
                       const uint64_t gas_limit);

       private:
        static std::vector<char> encode_calldata(const checksum256& txid, uint32_t index, uint64_t value);
    };
}
