#pragma once
#include <eosio/eosio.hpp>

// Minimal interface to exSat's `evm_runtime` contract — just enough to call
// its `call` action, which lets any Antelope account push an arbitrary
// EVM transaction (self-authorized, no allowlist). We do not compile
// against exSat's own contract; we build the inline action by hand so this
// header has no dependency on their codebase.
//
// Source of truth (do not hand-edit without re-checking against upstream):
// https://github.com/exsat-network/evm-contract
//   include/evm_runtime/evm_contract.hpp
//   void call(name from, const bytes& to, const bytes& value,
//             const bytes& data, uint64_t gas_limit);
//   -> only check inside the action is require_auth(from), so `from` can be
//      our own contract account authorizing with its own permission.
//
// TODO before real deployment: confirm the exact account name the
// evm_runtime contract is deployed under on exSat testnet (check
// https://scan2.exactsat.io or query the chain directly) — "evm_runtime" is
// the contract's project/build name, not a confirmed on-chain account name.

namespace exsat {
    using namespace eosio;

    static constexpr eosio::name EVM_RUNTIME_ACCOUNT = "evm_runtime"_n;  // TODO: verify on testnet

    inline void evm_call(eosio::name from, const std::vector<char>& to, const std::vector<char>& value,
                          const std::vector<char>& data, uint64_t gas_limit) {
        eosio::action(
            eosio::permission_level{from, "active"_n},
            EVM_RUNTIME_ACCOUNT,
            "call"_n,
            std::make_tuple(from, to, value, data, gas_limit))
            .send();
    }
}
