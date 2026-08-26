#pragma once
#include <eosio/eosio.hpp>

// Minimal interface to exSat's EVM runtime contract (`evm.xsat`) — just enough to call
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
// The EVM runtime is deployed on exSat's native mainnet under the account
// `evm.xsat` — confirmed live: its `config` table reports chainid 7200
// (exSat EVM mainnet), genesis 2024-10-09, and its ABI exposes the `call`
// action used below.
//
// Note `evm_runtime` is the contract's *project* name and is not a valid
// Antelope account name (underscores are not permitted), so it can never be
// the on-chain account. `eosio.evm` also exists on this chain but reports
// chainid 17777 (EOS EVM) — a different network, not our target.

namespace exsat {
    using namespace eosio;

    static constexpr eosio::name EVM_RUNTIME_ACCOUNT = "evm.xsat"_n;

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
