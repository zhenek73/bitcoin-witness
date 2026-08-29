# Architecture

## Components

1. **Native relay contract** (Antelope C++/CDT, deployed on EOS mainnet)

   See "How exSat relates to EOS" below — the short version is that exSat's native contracts are
   accounts on EOS mainnet, so this is standard EOS contract work: RAM/CPU/NET paid in EOS.

   The contract reads a Bitcoin fact — a UTXO or a block header — directly from exSat's contracts
   `utxomng.xsat` (UTXO set, spent history) and `blksync.xsat` / the `blocks` table (Bitcoin block
   headers: hash, previous hash, merkle root, timestamp, bits, nonce, cumulative work). Antelope
   contract tables are publicly readable by any other contract on the chain, so this is a direct
   in-contract read, not an external call.

2. **Relay to EVM**
   The native contract calls the `call(from, to, value, data, gas_limit)` action on `evm.xsat`,
   encoding the Bitcoin fact as `data` and targeting our EVM contract's address. This pushes a
   real, state-changing transaction onto exSat's EVM (chain id 7200).

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
   signature, **correct relayer**, successful receipt status. Every one of those checks reads from
   inside the attested bytes, so a caller chooses only *which* proven transaction to submit —
   never what it says.

   The relayer check is the one that carries the trust. `receiveUtxoFact` is callable by anyone
   on exSat EVM, so "this event was emitted by our contract in a successful, attested
   transaction" is *not* the same statement as "this is a real Bitcoin fact". Attestation proves
   **occurrence**; the indexed relayer topic proves **authorship** — that the fact came through
   `btcwitness`, the only code path that ever reads `utxomng.xsat`. Without that check the
   pipeline proves nothing at all; see `contracts/asc/test_verifier.py`, which fails loudly if it
   is removed.

## Why this needs no one's permission

- `evm.xsat`'s `call()` action requires only the caller's own signature — no allowlist, no
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
| Native relay contract (`contracts/native`) | **builds** with CDT 4.1.0 (~11 KB wasm); UTXO key derivation verified against live chain data; not yet deployed |
| EVM receiver contract (`contracts/evm`) | v1 written; calldata layout verified end-to-end against a real compiled+deployed instance (`contracts/evm/test_receiver.py`) |
| Creditcoin devnet + exSat registration (`devnet/`) | **working** — exSat registered as source chain (chain_key 7, chainId 7200, encoding V1), confirmed via the ChainInfo precompile |
| Attestcoin attestor against exSat | **working** — attesting live exSat mainnet blocks; attestation for height 59225940 finalized on Creditcoin, header hash matches exSat's own RPC exactly |
| Creditcoin verification contract (`contracts/asc`) | v1 written; decoding + authentication covered by 12 tests against real V1-format payloads, incl. 7 negative paths and 3 explicit forgery attempts (`contracts/asc/test_verifier.py`) |
| Proof generation + submission script (`scripts/prove_fact.ts`) | v1 written, typechecks; not yet run against a live network |

## How exSat relates to EOS

This trips people up, so it is worth stating precisely — both halves are true at different levels:

**exSat's native contracts are accounts on EOS mainnet.** `utxomng.xsat`, `blksync.xsat`,
`btc.xsat` and `evm.xsat` all live on the chain whose id is `aca376f206b8fc25a6ed44dbdc66547c36c
6c33e3a119ffbeaef943642f0e906` — the canonical EOS mainnet id. Verified not only through exSat's
own RPC but through two independent EOS providers (Greymass, EOS Nation) that have nothing to do
with exSat: all three accounts resolve there, with `utxomng.xsat` holding ~84.7 GB of RAM for the
Bitcoin UTXO index. Block production and finality come from EOS block producers. (EOS and
"Vaulta" are the same chain — a rebrand, not a fork; the chain id is unchanged.)

**exSat's EVM is nevertheless a distinct execution environment.** `evm.xsat` implements a full
EVM with its own chain id (7200), its own address space, its own block numbering (~59M), and its
own contracts — USDT on exSat is an ERC20 living in that EVM, not an `eosio.token` contract. You
develop against it in Solidity with MetaMask, not in C++.

The way to hold both facts at once: **the EVM's entire state is stored in `evm.xsat`'s Antelope
tables.** Querying `evm.xsat`'s `account` table on a plain EOS RPC returns rows of
`{eth_address, nonce, balance, code_id}` — that *is* the exSat EVM state, ~704 MB of it, paid for
in EOS RAM. So exSat EVM is a real EVM chain to a Solidity developer, and simultaneously a
contract on EOS mainnet to an Antelope developer.

Practical consequence for this project: the native relay is EOS work (C++/CDT, EOS RAM/CPU), the
receiver contract is EVM work (Solidity, chain id 7200), and the hop between them is an Antelope
inline action — not a bridge, not a cross-chain message.

Not to be confused with **EOS EVM** (`eosio.evm`, chain id 17777), a separate and now-defunct EVM
on the same EOS mainnet. Different chain id, unrelated to exSat.

## Data source: exSat mainnet — real, but frozen

Bitcoin data is read from exSat's **mainnet** index, `utxomng.xsat`, on EOS mainnet. The data is
real: **166,186,512 UTXOs**, block headers carrying genuine proof-of-work, chaining correctly
parent-to-child, submitted by real mining pools (`f2pool.sat`).

**It has also stopped advancing.** Checked 2026-08-29 against EOS mainnet and against Bitcoin
itself:

| | |
|---|---|
| `utxomng.xsat` head height | **959,115** — the block mined **2026-07-22** |
| Bitcoin's actual tip that day | **964,612** |
| lag | **~5,500 blocks ≈ 38 days** |
| `num_provider_validators` / `synchronizer` | `0` / empty |
| `blksync.xsat` `blockbuckets` / `block.chunk` | empty — nothing is being submitted |

So the honest description of the data source is: *a real, PoW-verified snapshot of the Bitcoin
UTXO set as of 2026-07-22, no longer being extended.* It is a frozen archive, not a live feed —
consistent with exSat's team having redirected the project away from BTC scaling (see
`docs/stream/DECISIONS.md`).

What this does and does not change:

- **The mechanism is unaffected.** Everything this project builds — reading the index from a
  contract, relaying into the EVM, attesting, proving on Creditcoin — works identically on a
  frozen index. Every UTXO proven is still a real Bitcoin output with real proof-of-work behind
  it. Nothing here is fixtures.
- **The claim must be dated.** "This UTXO exists and holds N sats" is only defensible as "…as of
  Bitcoin height 959,115". That is exactly why `BitcoinFactVerifier` stores `sourceHeight` and
  `provenAt` rather than a bare boolean: a consumer must be able to see how old the statement is.
- **A live product needs a live index.** Either exSat's synchronizers resume, or someone runs a
  synchronizer (the role is permissionless — that is the point of exSat's design), or the same
  relay is pointed at a different Bitcoin index. The pipe does not care which.

Verify it yourself, no exSat endpoint involved:

```bash
curl -s -X POST https://eos.greymass.com/v1/chain/get_table_rows -d '{"json":true,
  "code":"utxomng.xsat","scope":"utxomng.xsat","table":"chainstate","limit":1}'
curl -s https://blockstream.info/api/blocks/tip/height
```

exSat's own public *testnet* (`chain2`/`evm2`/`scan2.exactsat.io`) was shut down and is not used
here.

Because these are EOS mainnet accounts, the index inherits EOS mainnet's liveness rather than
exSat's corporate roadmap: the data stays readable and provable for as long as EOS runs, whatever
happens to exSat as a company. Liveness of *reading* is not the same as liveness of *ingest* —
the first is guaranteed, the second currently is not.

## txid byte order

Bitcoin has two conventions for the same 32 bytes: the **internal** order used in the protocol
and in merkle trees, and the **display** order (byte-reversed) shown by explorers and returned by
most JSON APIs. Confusing them does not error — it silently matches nothing.

The rule here: **`txid` is always exactly the 32 bytes `utxomng.xsat` stores**, unmodified, all
the way through — the `byutxoid` key derivation, the native contract, the EVM calldata, the event
topic, and the `bytes32 txid` recorded on Creditcoin. Nothing in this codebase reverses it.

Practical consequence: a consumer comparing a Creditcoin-proven `txid` against a value copied
from mempool.space or Blockstream must reverse one of the two. `scripts/demo.ts` takes txids in
the same form the EOS RPC returns them, which is the same form exSat stores.

See `CHANGELOG.md` for current progress, dated.
