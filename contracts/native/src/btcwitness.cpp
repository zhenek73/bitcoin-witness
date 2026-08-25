#include "btcwitness.hpp"
#include "evm_runtime.hpp"
#include "utxomng_xsat.hpp"

namespace bitcoinwitness {

void btc_witness::relayutxo(const checksum256& txid, const uint32_t index, const std::vector<uint8_t>& evm_to,
                             const uint64_t gas_limit) {
    require_auth(get_self());
    check(evm_to.size() == 20, "evm_to must be a 20-byte EVM address");

    // Cross-contract read of exSat's `utxomng.xsat` `utxos` table. This is a
    // plain multi_index read scoped to their account — no permission from
    // exSat is required, Antelope contract tables are public.
    exsat::utxo_table utxos(exsat::UTXOMNG_ACCOUNT, exsat::UTXOMNG_ACCOUNT.value);
    auto by_id = utxos.get_index<"byutxoid"_n>();
    auto it = by_id.find(exsat::utxo_row::compute_utxo_id(txid, index));
    check(it != by_id.end(), "utxo not found in utxomng.xsat (spent, never existed, or not yet indexed)");

    auto calldata = encode_calldata(txid, index, it->value);

    // We are not attaching any EVM-native value to this call, only calldata.
    std::vector<char> zero_value(32, 0);
    std::vector<char> to(evm_to.begin(), evm_to.end());

    exsat::evm_call(get_self(), to, zero_value, calldata, gas_limit);
}

std::vector<char> btc_witness::encode_calldata(const checksum256& txid, uint32_t index, uint64_t value) {
    // Solidity ABI encoding for receiveUtxoFact(bytes32,uint32,uint64) — all
    // three params are static (32-byte-word) types, so this is a fixed
    // layout: selector(4) + txid(32) + index(32, right-padded) + value(32,
    // right-padded). No dynamic-type offset/length encoding needed for v1.
    //
    // Selector = keccak256("receiveUtxoFact(bytes32,uint32,uint64)")[:4]
    //          = 0x67b449eb (computed and verified against contracts/evm/).
    static const unsigned char selector[4] = {0x67, 0xb4, 0x49, 0xeb};

    std::vector<char> out;
    out.reserve(4 + 32 + 32 + 32);
    out.insert(out.end(), (const char*)selector, (const char*)selector + 4);

    auto txid_bytes = txid.extract_as_byte_array();
    out.insert(out.end(), txid_bytes.begin(), txid_bytes.end());

    std::vector<char> index_word(32, 0);
    index_word[28] = (char)((index >> 24) & 0xFF);
    index_word[29] = (char)((index >> 16) & 0xFF);
    index_word[30] = (char)((index >> 8) & 0xFF);
    index_word[31] = (char)(index & 0xFF);
    out.insert(out.end(), index_word.begin(), index_word.end());

    std::vector<char> value_word(32, 0);
    for (int i = 0; i < 8; ++i) {
        value_word[31 - i] = (char)((value >> (8 * i)) & 0xFF);
    }
    out.insert(out.end(), value_word.begin(), value_word.end());

    return out;
}

}  // namespace bitcoinwitness
