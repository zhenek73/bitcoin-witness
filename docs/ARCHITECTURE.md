# Architecture

## Components

1. **Native relay contract** (Antelope C++/CDT, deployed on EOS mainnet)

   exSat's "native layer" is **EOS mainnet itself** — `utxomng.xsat`, `blksync.xsat` and
   `evm.xsat` are ordinary accounts there (chain id `aca376f2…e906`). So this is standard EOS
   contract work: RAM/CPU/NET are paid in EOS, and the Bitcoin index lives alongside every other
   EOS contract rather than on a separate chain of its own.

   The contract reads a Bitcoin fact — a UTXO or a block header — directly from exSat's contracts
   `utxomng.xsat` (UTXO set, spent history) and `blksync.xsat` / the `blocks` table (Bitcoin block
   headers: hash, previous hash, merkle root, timestamp, bits, nonce, cumulative work). Antelope
   contract tables are publicly readable by any other contract on the chain, so this is a direct
   in-contract read, not an external call.

2. **Relay to EVM**
   The native contract calls exSat's `evm_runtime` contract's `call(from, to, value, data,
   gas_limit)` action, encoding the Bitcoin fact as `data` and targeting our EVM contract's
   address. This pushes a real, state-changing EVM transaction.

3. **EVM receiver contract** (Solidity, deployed on exSat EVM)
   Decodes the calldata and emits a event containing the Bitcoin fact (e.g. txid, output index,
   value, script, block height).

4. **Attestor** (Creditcoin's Attestcoin protocol, run against exSat)
   Watches the exSat EVM chain via standard RPC, reaches quorum, and submits an attestation of the
   transaction + event to Creditcoin.

5. **Creditcoin verification**
   The attested payload is not a raw RLP transaction. Attestcoin's V1 encoding is
   `abi.encode(uint8 txType, bytes[] chunks)`, where `chunks[0]` always holds the common
   transaction fields and the last chunk always holds the receipt — including its logs. That makes
   the emitted event recoverable with plain `abi.decode`.

   `contracts/asc/BitcoinFactVerifier.sol` calls the BlockProver precompile to prove the payload
   genuinely occurred at that height on that chain, then decodes it and authenticates the fact
   before recording it: correct transaction recipient, correct emitting contract, correct event
   signature, successful receipt status. Every one of those checks reads from inside the attested
   bytes, so a caller chooses only *which* proven transaction to submit — never what it says.

## Why this needs no one's permission

- exSat's `evm_runtime.call()` action requires only the caller's own signature — no allowlist, no
  third-party approval.
- Creditcoin's `register_chain` extrinsic (which adds a new source chain to Attestcoin) is gated
  only by the chain operator's own `OperatorsOrigin` — self-service on infrastructure the operator
  controls.
- Both protocols are open source.

## V1 scope

A single, complete, working slice — proving one concrete Bitcoin fact end to end — rather than a
general-purpose oracle for arbitrary Bitcoin data.

**The fact proved in v1:** *"UTXO (txid, vout index) exists on Bitcoin and is worth N satoshis"*
— read from exSat's `utxomng.xsat` table, relayed to `BitcoinWitnessReceiver.receiveUtxoFact
(bytes32 txid, uint32 index, uint64 value)` on exSat EVM.

**Deliberately out of scope for v1:**
- `scriptpubkey` / Bitcoin address — a dynamic-length field. Including it means real Solidity
  ABI dynamic-type encoding (offset + length + data) on the native side, which is a well-defined
  v2 extension, not a v1 blocker. v1 proves *that value exists*, not *who can spend it* — still a
  useful, honest fact (e.g. proof of reserves by UTXO id).
- Block headers (`blksync.xsat` / `blocks` table) — same relay mechanism works for these too, but
  v1 ships one fact type end to end rather than two half-done ones.
- Spent-UTXO / historical proofs — v1 only proves current, unspent state.

This scoping is a deliberate product decision, not a technical limitation: the hard, previously
unverified part of this project was proving the *relay mechanism itself* works permissionlessly
end to end (see `docs/stream/` research — not in this repo). Once that pipe exists and is proven
with one fact type, extending it to richer facts is incremental, not architectural.

## Components status

| Component | Status |
|---|---|
| Native relay contract (`contracts/native`) | v1 written; target account for `evm.xsat` confirmed live on mainnet; not yet built/deployed |
| EVM receiver contract (`contracts/evm`) | v1 written; calldata layout verified end-to-end against a real compiled+deployed instance (`contracts/evm/test_receiver.py`) |
| Attestcoin attestor + Creditcoin devnet | not started |
| Creditcoin verification contract (`contracts/asc`) | v1 written; decoding + authentication covered by 9 tests against real V1-format payloads, incl. 5 negative paths (`contracts/asc/test_verifier.py`) |
| Proof generation + submission script (`scripts/prove_fact.ts`) | v1 written, typechecks; not yet run against a live network |

## Data source: exSat mainnet

Bitcoin data is read from exSat's **mainnet**, where the UTXO index is live and current. Verified
directly against `https://rpc-sg.exsat.network` on 2026-08-26:

- `utxomng.xsat` holds **166,186,512 UTXOs** at Bitcoin height **959,115**
- block headers carry real proof-of-work (19 leading zeros) and chain correctly parent-to-child
- blocks are being submitted by real mining pools (e.g. `f2pool.sat`)

This matters for what the project can honestly claim: the facts it proves are about **real
Bitcoin**, not a testnet or self-generated fixtures.

exSat's own public *testnet* (`chain2`/`evm2`/`scan2.exactsat.io`) was shut down and is not used
here. The EVM runtime is the account `evm.xsat` (chainid 7200); `eosio.evm` on the same chain is
EOS EVM (chainid 17777), a different network.

Because these are EOS mainnet accounts, the Bitcoin index does not depend on exSat operating a
chain of its own — it keeps advancing as long as synchronizers submit blocks.

See `CHANGELOG.md` for current progress, dated.
