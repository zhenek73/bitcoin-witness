# Architecture

## Components

1. **Native relay contract** (Antelope C++/CDT, deployed on exSat's native layer)
   Reads a Bitcoin fact — a UTXO or a block header — directly from exSat's native contracts
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
   The attested payload is an ABI encoding of the source transaction *together with its receipt*
   (so the emitted event is part of what gets proven). Rather than decoding that blob on-chain, a
   query declares `LayoutSegment{offset,size}` entries naming the exact fields it wants; once
   proving completes, the Prover contract returns those fields as `ResultSegment{offset,abiBytes}`.

   `contracts/asc/BitcoinFactVerifier.sol` reads a completed query and authenticates it before
   accepting the fact: correct source chain_key, correct transaction recipient, correct emitting
   contract, correct event signature, successful receipt status, and a replay guard on queryId.
   Only then is the Bitcoin fact recorded on Creditcoin.

   (Creditcoin also exposes a lower-level BlockProver precompile taking an explicit Merkle +
   continuity proof. The query/Prover flow above is the documented path used by Gluwa's own
   tutorials, and is what this project builds on.)

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
| Native relay contract (`contracts/native`) | v1 skeleton written, not yet built/deployed |
| EVM receiver contract (`contracts/evm`) | v1 written; calldata layout verified end-to-end against a real compiled+deployed instance (`contracts/evm/test_receiver.py`) |
| Attestcoin attestor + Creditcoin devnet | not started |
| Creditcoin verification contract (`contracts/asc`) | v1 written; authentication logic covered by tests incl. 7 negative paths (`contracts/asc/test_verifier.py`) |
| Off-chain query submission script | not started — needs Gluwa's QueryBuilder to emit the layout this contract expects |

## A note on exSat's current status

exSat's public testnet endpoints are currently unreachable, and public information suggests the
team has shifted its product focus away from Bitcoin L2 infrastructure. This does not affect the
architecture above: `utxomng.xsat`, `blksync.xsat`, and `evm_runtime` are open-source contracts
(see the exSat GitHub organization) that can be run on a self-hosted devnet, independent of
exSat's own infrastructure or current roadmap. If self-hosted, real Bitcoin block data is
independently synced and cryptographically verified (proof-of-work + Merkle proofs) rather than
read from exSat's live network — the same verification logic, just run by us against real Bitcoin
data. See `CHANGELOG.md` for how this evolves.

See `CHANGELOG.md` for current progress, dated.
