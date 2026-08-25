#pragma once
#include <eosio/eosio.hpp>
#include <eosio/crypto.hpp>

// Mirrors the on-chain layout of exSat's `utxomng.xsat` contract so we can
// read its public tables directly, from our own contract, with no
// permission from exSat needed (Antelope contract tables are publicly
// readable by any other contract on the same chain).
//
// Source of truth (do not hand-edit without re-checking against upstream):
// https://github.com/exsat-network/contract-of-consensus
//   contracts/utxomng.xsat/utxomng.xsat.hpp

namespace exsat {
    using namespace eosio;

    static constexpr eosio::name UTXOMNG_ACCOUNT = "utxomng.xsat"_n;

    struct [[eosio::table("utxos"), eosio::contract("utxomng.xsat")]] utxo_row {
        uint64_t id;
        checksum256 txid;
        uint32_t index;
        std::vector<uint8_t> scriptpubkey;
        uint64_t value;

        uint64_t primary_key() const { return id; }

        checksum256 by_utxo_id() const { return compute_utxo_id(txid, index); }

        static checksum256 compute_utxo_id(const checksum256& txid, uint32_t index) {
            std::vector<char> buf(36);
            eosio::datastream<char*> ds(buf.data(), buf.size());
            ds << txid;
            ds << index;
            return eosio::sha256(buf.data(), buf.size());
        }
    };

    typedef eosio::multi_index<
        "utxos"_n, utxo_row,
        eosio::indexed_by<"byutxoid"_n, const_mem_fun<utxo_row, checksum256, &utxo_row::by_utxo_id>>>
        utxo_table;
}
