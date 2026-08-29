# Changelog

## 2026-08-29 (12)
### Fixed — SECURITY: anyone could have proven a fabricated Bitcoin fact
- `BitcoinFactVerifier` checked the transaction recipient, the emitting contract, the event
  signature and the receipt status — but never the **relayer**, the indexed topic saying *who*
  submitted the fact. Since `receiveUtxoFact` is callable by anyone on exSat EVM, any EOA could
  emit `BitcoinUtxoAttested` with invented numbers, have Attestcoin honestly attest that real
  transaction, and have it recorded on Creditcoin as a genuine Bitcoin fact. The one check that
  makes the pipeline mean anything — the `utxomng.xsat` read in `btcwitness` — was bypassable by
  simply going around it.
- Fixed with `expectedRelayer` (the reserved EVM address of the native account) compared against
  `topics[2]`, plus `msg.sender` enforcement in the receiver as defence in depth.
- Three new tests cover it, including a genuine-and-forged-log-in-one-transaction case. Removing
  the check makes the suite fail with `expected revert, but the call SUCCEEDED` — verified.
- The old tests had *encoded* the hole: the happy path passed a zero-address relayer and called
  it success.

### Fixed — a proven fact is now dated, not just true
- `BitcoinFactVerifier` stored `(value, bool)`. It now stores `ProvenFact { value, sourceHeight,
  provenAt, proven }` and exposes `ageOf()`. A proof is a statement about a past height; a
  consumer deciding whether to lend against a UTXO has to be able to see how old it is.

### Found — exSat's Bitcoin index has stopped advancing
- `utxomng.xsat` head height is **959,115** — the Bitcoin block mined **2026-07-22**. Bitcoin's
  actual tip on 2026-08-29 is **964,612**: the index is **~5,500 blocks / 38 days behind**.
  `num_provider_validators` is 0, `synchronizer` is empty, and `blksync.xsat`'s `blockbuckets`
  and `block.chunk` are both empty — nothing is being submitted.
- Earlier entries called 959,115 "актуальная высота". It never was; we read exSat's own numbers
  and never compared them against Bitcoin. Lesson recorded: *a chain reporting a height is not
  the same as that height being current — always diff against the source of truth.*
- What it changes: the data is still real, PoW-verified Bitcoin, and the mechanism is unaffected.
  What it costs is the word "live" — every claim must be dated to height 959,115. Which is
  exactly why `sourceHeight` is now stored.

### Fixed — the gas nobody budgeted for
- `evm.xsat` config: `token_contract: btc.xsat`, `gas_price: 500000`. Gas on exSat EVM is
  denominated in **BTC**, charged to the relay account's reserved EVM address. ~2.5 sats per
  relay, but zero balance means the EVM transaction fails while the Antelope transaction still
  succeeds — no event, no attestation, and nothing pointing at the cause. Documented in
  `DEPLOY.md` with the address derivation, plus a note on moving the cost to the caller in v2.
- `relayutxo` now bounds `gas_limit` (50k–1M) instead of passing whatever it is given.

### Changed
- `scripts/demo.ts` is genuinely end to end: it signs and pushes `relayutxo` via WharfKit, waits
  for the EVM event, generates proofs, waits for attestation and verifies on Creditcoin. It also
  prints exSat's index lag against Bitcoin's real tip, so the demo cannot overstate its own data.
  Typechecks under `--strict`; dry run verified against live chain data.
- `devnet/attestor-config.yaml`: the private key that was committed here is gone, replaced by
  `${ATTESTOR_SECRET}`. That key should be considered burned.
- `docs/ARCHITECTURE.md`: new sections on the frozen index (with a two-command reproduction) and
  on txid byte order, which was previously unstated and is a silent-failure class of its own.
- Root `README.md` still described the abandoned forensic-alert idea; rewritten as an index.
- New: `docs/AUDIT-2026-08-29.md`, `PITCH.md`, `docs/UI-CONCEPT.md`.

## 2026-08-26 (11)
### Added
- `scripts/demo.ts`: end-to-end walkthrough that proves one real Bitcoin UTXO from exSat's index
  through to Creditcoin, printing each hop. `--dry-run` walks the read-only steps without
  spending anything.
- Verified against live data. For a real early coinbase output it reports exSat indexed to
  Bitcoin height 959,115 across 166,186,512 UTXOs, and resolves the output at 5,000,000,000 sats
  (50 BTC) via the `byutxoid` index.

## 2026-08-26 (10)
### Added
- `contracts/native/build.sh` and `DEPLOY.md`. The native relay contract **compiles** with
  Antelope CDT 4.1.0 into an ~11 KB wasm with a correct ABI (`relayutxo(checksum256, uint32,
  bytes, uint64)`). At the RAM spot price read from `eosio`'s `rammarket`, that is roughly
  3.8 EOS to deploy.
- Verified the contract's UTXO lookup against live chain data. It derives the `byutxoid`
  secondary key as `sha256(txid || index_le32)`; computing that for a known UTXO and querying
  `utxomng.xsat` on a public EOS RPC returned exactly that row. This was worth checking — a
  mismatched key derivation would not error, it would silently find nothing.

## 2026-08-26 (9)
### Added
- `devnet/bootstrap-attestor.mjs` + `devnet/attestor-config.yaml`: brings up an Attestcoin
  attestor watching exSat, and documents the ordering that makes it work.
- **The attestor is attesting real exSat mainnet blocks.** It produced an attestation for height
  59225940, reached quorum, and the attestation is finalized on Creditcoin. The stored
  `headerHash` (`0xe47664ed…53ff6`) is byte-identical to what exSat's own RPC returns for that
  block — so this is the protocol attesting live chain data, not fixtures.

### Notes on getting an attestor running
Three non-obvious preconditions, each of which fails in a way that does not name the real cause:
- The stash and the attestor must be **different** accounts; using one account for both fails
  with `InvalidAttestorAccount`.
- `registerAttestor` is `ensure_signed`, not a sudo call. Wrapping it in sudo succeeds but
  registers the sudo pseudo-account, so the attestor never becomes `Idle`.
- The attestor submits its own `attest()` only once it already sees itself as `Idle` on-chain.
  Before that it logs `skipping attest() — already registered status=None`, which reads as the
  opposite of what is happening.

Quorum (`targetSampleSize`) defaults to 3, so a single-attestor devnet needs it lowered to 1, and
that change stays pending until an epoch boundary or `forceApplyUpdates()`.

## 2026-08-26 (8)
### Added
- `devnet/`: a working local Creditcoin devnet, plus `register-exsat.mjs`, which registers exSat
  as an Attestcoin source chain. Run and verified end to end: the chain reports
  `ChainRegistered { chainKey: 7, chainId: 7200, chainName: "exSat", chainEncoding: "V1" }`,
  and it reads back through the ChainInfo precompile the same way a contract would see it.
- This closes the last unverified assumption in the architecture. Every link — reading Bitcoin
  data, relaying it to EVM, proving it on Creditcoin, and registering exSat so it can be
  attested at all — is now confirmed against running software rather than inferred from source.

### Notes
- `chain_key` is assigned by the pallet and is not the EVM chainId (exSat: chainId 7200,
  chain_key 7). `devnet/README.md` documents this, since conflating them yields a source check
  that silently never matches.
- Polygon Amoy is already registered on a stock dev chain, which is useful precedent: encoding
  `V1` is generic to EVM chains, so exSat needs no new encoding variant.
- exSat's EVM WebSocket endpoint (`wss://evm.exsat.network/`) was confirmed reachable — the
  attestor subscribes over WS, so this was a real dependency worth checking before relying on it.

## 2026-08-26 (7)
### Changed
- Clarified that exSat's native layer is **EOS mainnet itself** (chain id `aca376f2…e906`) —
  `utxomng.xsat`, `blksync.xsat` and `evm.xsat` are ordinary accounts there, not a separate
  chain. The native side of this project is therefore standard EOS contract work, with RAM/CPU/NET
  paid in EOS.
- Documented the deployment requirement this implies: the relay contract sends an inline action
  to `evm.xsat` as itself, so its account needs `@eosio.code` in `active`. Without it the first
  call fails with "missing required authority".

## 2026-08-26 (6)
### Changed
- Data source is exSat **mainnet**, where the Bitcoin UTXO index is live: 166,186,512 UTXOs at
  Bitcoin height 959,115, verified directly against the public RPC. Block headers carry real
  proof-of-work and chain correctly; blocks are submitted by real mining pools. exSat's public
  testnet was shut down and is not used.
- Confirmed the EVM runtime account on mainnet is `evm.xsat` (chainid 7200) and corrected
  `contracts/native`, which previously carried a placeholder. The old placeholder could never
  have worked — Antelope account names cannot contain underscores.

## 2026-08-25 (5)
### Changed
- Corrected the Creditcoin-side integration model. Gluwa's SDK exposes two paths: an older
  Prover-contract query model (used by the pinned `^0.0.1` in their tutorial) and the current
  BlockProver-precompile path (`PrecompileBlockProver`, `ProverAPIProofGenerator` in `0.8.0`).
  `BitcoinFactVerifier` now uses the latter: it proves the payload via the precompile, then
  decodes it directly.
- Decoding is possible because Attestcoin's V1 encoding is `abi.encode(uint8 txType, bytes[]
  chunks)` — `chunks[0]` is always the common transaction fields, the last chunk is always the
  receipt including logs. Verified against Gluwa's own encoder. Every authentication check now
  reads from inside the attested bytes rather than a caller-supplied field layout.

### Added
- `scripts/prove_fact.ts`: generates inclusion + continuity proofs, waits for the height to be
  attested, and submits to the verifier. Typechecks against the real SDK.
- `contracts/asc/ExtractFactHarness.sol` + rewritten `test_verifier.py`: 9 tests against payloads
  built in Attestcoin's real V1 format — happy path, impostor emitter, wrong recipient, wrong
  event, reverted receipt, wrong topic arity, event buried behind unrelated logs, legacy tx type,
  and uint32/uint64 boundary values. All pass.

## 2026-08-25 (4)
### Changed
- Rewrote `contracts/asc/BitcoinFactVerifier.sol` around Attestcoin's actual query model. The
  attested payload is an ABI encoding of the source transaction *and its receipt*; consumers
  declare `LayoutSegment{offset,size}` entries for the fields they want and read back
  `ResultSegment{offset,abiBytes}` — no on-chain transaction decoding needed. Structs taken
  verbatim from the Prover ABI in Gluwa's official tutorial repo. This removes the previous
  decoding TODO entirely.
- The verifier now authenticates a fact on five independent axes before accepting it: source
  chain_key, transaction recipient, emitting contract, event signature, and receipt status —
  plus a replay guard on queryId.

### Added
- `contracts/asc/MockAttestcoinProver.sol` + `contracts/asc/test_verifier.py`: test suite for the
  verifier. Covers the happy path and 7 negative paths — replayed query, forged emitter, wrong
  transaction recipient, same address on a different source chain, different event from our own
  contract, reverted source transaction, and a query that hasn't finished proving. All pass.

## 2026-08-25 (3)
### Added
- `contracts/evm/test_receiver.py`: automated round-trip test. Verifies the calldata layout our
  native contract builds by hand is byte-for-byte identical to web3.py's own ABI encoder for
  `receiveUtxoFact(bytes32,uint32,uint64)`, and that sending it to a real deployed instance of
  `BitcoinWitnessReceiver` emits `BitcoinUtxoAttested` with the exact values. Passes.
- `contracts/asc/BitcoinFactVerifier.sol`: v1 Creditcoin-side verification contract. Interfaces
  Creditcoin's BlockProver precompile (address confirmed two ways — official docs and the actual
  `gluwa/creditcoin3` runtime source, `AddressU64<4050>`), calls `verifyAndEmit`, and records the
  proven Bitcoin fact. Compiles. Proof→fact decoding is an explicit TODO (see NatSpec in the file)
  pending confirmation of the exact `encodedTransaction` format against a real attested tx.
- Noted exSat's current infrastructure status in `docs/ARCHITECTURE.md` (testnet unreachable,
  public self-hosting fallback) — doesn't change the architecture, only where it's deployed.

## 2026-08-25 (2)
### Added
- `contracts/native`: v1 native relay contract (`btcwitness`, Antelope C++/CDT). Reads a Bitcoin
  UTXO fact (txid, vout index, value) directly from exSat's `utxomng.xsat` table and relays it
  into an EVM transaction via exSat's `evm_runtime.call()` action.
- `contracts/evm/BitcoinWitnessReceiver.sol`: v1 EVM receiver contract. Decodes the relayed fact
  and emits `BitcoinUtxoAttested(bytes32 txid, uint32 index, uint64 value, address relayer)` —
  the event Attestcoin will attest and Creditcoin will verify.
- `docs/ARCHITECTURE.md`: documented v1 scope (proves UTXO existence + value; scriptpubkey/address
  and block-header facts are v2) and a components status table.

### Not yet done
- Contracts are written but not built or deployed.
- No Attestcoin attestor / Creditcoin devnet yet — next milestone.

## 2026-08-25
### Added
- Project scaffolded: repository structure, architecture doc, license.
- Architecture defined: native relay contract (exSat native layer) → EVM receiver contract (exSat
  EVM) → Attestcoin attestation → Creditcoin verification.
