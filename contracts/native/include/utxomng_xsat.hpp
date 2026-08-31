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
//
// IMPORTANT (found the hard way, via a real "not found" against a UTXO that
// eos.greymass.com's own get_table_rows confirmed exists): cross-contract
// secondary-index reads in Antelope are addressed by DECLARATION POSITION,
// not by the `_n` name -- the name is only a local alias for
// `get_index<Name>()` within your own multi_index type. The real
// `utxos` table declares TWO secondary indexes, in this order:
//   1. "scriptpubkey"  (index_position 2)
//   2. "byutxoid"      (index_position 3)
// Our first cut of this mirror declared only "byutxoid" alone, which put it
// at position 2 in OUR type -- silently reading utxomng.xsat's real
// *scriptpubkey* index instead. The fix is to replicate BOTH indexes, in the
// same order, even though we never query the first one -- only its presence
// (occupying a slot) matters, not its correctness.
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

        // Position 2 on-chain. Never queried by us -- declared only so
        // "byutxoid" below lands in the correct slot (position 3).
        checksum256 by_scriptpubkey() const {
            return eosio::sha256((const char*)scriptpubkey.data(), scriptpubkey.size());
        }

        // Position 3 on-chain -- this is the one we actually read.
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
        eosio::indexed_by<"scriptpubkey"_n, const_mem_fun<utxo_row, checksum256, &utxo_row::by_scriptpubkey>>,
        eosio::indexed_by<"byutxoid"_n, const_mem_fun<utxo_row, checksum256, &utxo_row::by_utxo_id>>>
        utxo_table;
}
