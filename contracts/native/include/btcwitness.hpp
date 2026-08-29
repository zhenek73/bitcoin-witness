#pragma once
#include <eosio/eosio.hpp>
#include <eosio/crypto.hpp>

// Bitcoin Witness — native relay contract (deployed on exSat's Antelope
// native layer, account name `btcwitness11`).
//
// Reads a single Bitcoin UTXO fact directly from exSat's own `utxomng.xsat`
// table and relays it into an EVM transaction on exSat's EVM layer, whose
// event is what Creditcoin's Attestcoin protocol later attests and
// verifies. See ../../../docs/ARCHITECTURE.md for the full picture.
//
// DEPLOYMENT REQUIREMENT: this contract sends an inline action to `evm.xsat`
// authorized as itself, so its own account needs `<account>@eosio.code` in its
// `active` permission:
//
//   cleos set account permission <account> active --add-code
//
// Without it the very first relayutxo call fails with "missing required
// authority", which reads like a contract bug but is a permissions gap.
//
// exSat's native contracts (utxomng.xsat, evm.xsat) are accounts on EOS mainnet,
// so RAM/CPU/NET are paid in EOS as usual. The EVM they expose is a separate
// execution environment (chain id 7200) whose state lives in evm.xsat's tables —
// see docs/ARCHITECTURE.md "How exSat relates to EOS".
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

        // A bare emit costs ~30k gas; 50k leaves headroom without being a
        // blank cheque. See relayutxo() for why both bounds matter.
        static constexpr uint64_t MIN_GAS_LIMIT = 50000;
        static constexpr uint64_t MAX_GAS_LIMIT = 1000000;

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
