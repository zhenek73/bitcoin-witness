# Bitcoin Witness — complete technical overview

*One document covering the whole system: what it is, what is deployed where, how the data
actually moves, what it can and cannot claim, how it is tested, and how to run every part of it
from nothing. Current as of 2026-09-12.*

Companion documents, all of which this one links out to rather than repeats:
[`README.md`](../README.md) (quick start) · [`PITCH.md`](../PITCH.md) (the argument) ·
[`ARCHITECTURE.md`](ARCHITECTURE.md) (component-level detail) ·
[`CHANGELOG.md`](../CHANGELOG.md) (dated history, including every mistake).

---

## 1. What this is, in one paragraph

Bitcoin Witness lets a smart contract on **Creditcoin** verify a fact about **Bitcoin** — "this
UTXO exists and holds N satoshis" — without wrapping the BTC, bridging it, or trusting a
custodian's report about it. The Bitcoin never moves; only the proof does. On top of that
primitive it ships a working consumer: a reserve guard that refuses, on chain and inside the
mint transaction, to issue wrapped BTC beyond the Bitcoin actually proven to exist.

## 2. The problem, stated precisely

Every wrapped Bitcoin rests on one invariant: `supply <= reserves`.

It is tempting — and wrong — to say nobody checks it. Chainlink publishes a WBTC
proof-of-reserve feed, and its Secure Mint pattern already gates minting on that feed. Reserve
monitoring exists and it is on chain.

The real gap is narrower. **A reserve feed is an assertion.** A committee of oracle nodes reads
a Bitcoin node off chain, agrees on a number, signs it, and posts it. The consuming contract
cannot check that number against anything: it can only trust the signers, and trust the address
list those signers were pointed at. The reserve is *reported* to the chain, never *proven* to
it.

That was not a failure of imagination. **Bitcoin state has never been natively readable by a
Creditcoin contract.** Other approaches to the general problem — BTC Relay, SPV light clients,
threshold-signature designs like tBTC — each make their own trade-off in gas, liveness, or a
signer set to trust. Bitcoin Witness takes a different route: it uses exSat's already-indexed
Bitcoin state and makes one specific fact verifiable inside a Creditcoin contract.

Bitcoin Witness changes what arrives, not whether anything arrives.

## 3. The insight

exSat maintains a complete, native, on-chain index of the Bitcoin UTXO set — 166,186,512 UTXOs
at Bitcoin height 959,115 — extended by real mining pools submitting real blocks carrying real
proof of work. A Bitcoin state machine that smart contracts can read.

Except they cannot, quite. The index lives on exSat's **native** (Antelope) layer; Solidity
contracts live on exSat's **EVM** layer. exSat's own documentation says the EVM layer *"will in
the near future"* be able to read that data. Today it cannot. And a contract on another chain
has no way to reach those tables either — not because they are secret, but because reading is
not verifying. Anyone can query them over a public EOS RPC; what no smart contract elsewhere
can do is check their contents as part of its own execution. **RPC-readable is not the same
thing as contract-verifiable, and that gap is the whole problem.**

Bitcoin Witness builds that missing link, and then carries the fact one chain further, to
Creditcoin.

## 4. The data path, hop by hop

```
Bitcoin ──► exSat native index ──► exSat EVM ──► Attestcoin ──► Creditcoin ──► ReserveGuard
            utxomng.xsat           event         attestation    proven fact    mint reverts
```

**Hop 1 — Bitcoin into exSat's index.** Not ours. Synchronizers submit Bitcoin blocks to
`blksync.xsat`; validators endorse them; `utxomng.xsat` maintains the resulting UTXO set. The
proof of work is Bitcoin's own.

**Hop 2 — index into exSat EVM.** `btcwitness11`, an Antelope C++ contract live on EOS mainnet,
reads the UTXO straight out of `utxomng.xsat` (Antelope contract tables are publicly readable by
any other contract on the same chain — a direct in-contract read, not an external call), then
calls `evm.xsat::call(from, to, value, data, gas_limit)` as an **inline action**. Same chain, no
bridge, no message passing, no third party.

**Hop 3 — EVM event.** `BitcoinWitnessReceiver` on exSat EVM mainnet (chain id 7200) decodes the
calldata and emits `BitcoinUtxoAttested(bytes32 indexed txid, uint32 index, uint64 value,
address indexed relayer_)`.

**Hop 4 — attestation.** An Attestcoin attestor follows exSat EVM over RPC and submits
attestations of block headers to Creditcoin. The attested digest is
`hash(block_number, merkle_root, prev_digest)`.

**Hop 5 — on-chain verification.** `BitcoinFactVerifier` on Creditcoin calls the BlockProver
precompile at `0x...0FD2` with the encoded transaction, an inclusion proof and a continuity
proof. The precompile reverts unless the payload genuinely occurred at that height on that
chain.

**Hop 6 — authentication, then use.** Verification proves *occurrence*. It does not prove
*authorship*, and that distinction is the whole security argument — see §6.

## 5. What is deployed, and where

| Component | Network | Identity |
|---|---|---|
| Native relay contract | **EOS mainnet** | `btcwitness11` — 7 real relays in chain history |
| EVM receiver | **exSat EVM mainnet** (7200) | `0xBF823785C5749532AE927d7285093Eae279fe16C` — 7 events |
| Attestcoin attestor | self-hosted CC3 devnet | attesting live exSat blocks, `chain_key 7` |
| Fact verifier | self-hosted CC3 devnet | `0xc01Ee7f10EA4aF4673cFff62710E1D7792aBa8f3` |
| Reserve guard | self-hosted CC3 devnet | `0xD45E290062Bd0D1C640D59C350cA03CC291b37FA` |
| Guarded wrapped BTC | self-hosted CC3 devnet | `0x6eA3524AD29729b10F324fD2aF967beed9cc4E68` |
| Unguarded control token | self-hosted CC3 devnet | `0x115f277e8fcE437B1F513A293057D2E396Ac2EC1` |

Five distinct Bitcoin UTXOs have travelled the whole path and read back `proven = true`.

The Creditcoin side runs on a self-hosted CC3 devnet because **exSat was not a registered
Attestcoin source chain** — registering one is gated by the chain operator's own
`OperatorsOrigin`, so we became that operator. The chain is rebuilt from genesis by
`devnet/bootstrap-devnet.mjs`, and the deploy scripts write current addresses into
`scripts/verifier-deployment.json` and `scripts/guard-deployment.json`. After a rebuild, those
files — not this table — are the source of truth.

## 6. Why the pipeline means anything: occurrence vs authorship

`receiveUtxoFact` on exSat EVM is callable by anyone. So this statement —

> *this event was emitted by our contract, in a successful transaction, and Attestcoin proved
> that transaction happened*

— is **not** the same statement as *"this is a real Bitcoin fact"*. Any EOA could call the
receiver with invented numbers, have Attestcoin honestly attest that real transaction, and have
it recorded on Creditcoin as genuine.

Attestation proves **occurrence**. Only the indexed relayer topic proves **authorship** — that
the fact came through `btcwitness11`, the only code path in this system that reads
`utxomng.xsat`.

`BitcoinFactVerifier` therefore checks five things, all of them read from *inside* the attested
bytes, so a caller chooses only *which* proven transaction to submit and never what it contains:

1. transaction recipient is our receiver
2. emitting contract address is our receiver
3. event signature matches
4. **`topics[2]` equals the reserved EVM address of `btcwitness11`** ← the load-bearing one
5. receipt status is success

The relayer address is derived from the Antelope account name:
`0xbbbbbbbb ‖ name_u64 (8 bytes, big-endian) ‖ 8 zero bytes`.

This check was missing in an earlier version. It was found, filed and fixed as a security bug —
see `CHANGELOG.md` entry 12. `contracts/asc/test_verifier.py` fails loudly if it is removed,
including a test where a genuine and a forged log sit in the same transaction.

A proven fact is also **dated**, not merely true. `ProvenFact` stores `sourceHeight` (the exSat
EVM height the proof was anchored at) and `provenAt` (the Creditcoin timestamp), and the contract
exposes `ageOf()`. A proof is a statement about a past moment; a consumer deciding whether to act
on it must be able to see how old it is.

## 7. The solvency layer

`contracts/asc/ReserveGuard.sol` is the first consumer of a proven fact, and the one that turns
it into a safety property.

- `declareReserve(txid, index)` / `removeReserve(...)` — the issuer's registry of reserve
  outpoints. Declaring does not make an outpoint count.
- `provenReserves()` — sums the value of declared outpoints that are both **proven** through
  `BitcoinFactVerifier` and **fresh** (within `maxFactAge`). Returns `(totalSats, counted,
  stale)`.
- `checkMint(amount)` — reverts with `Insolvent(supplyAfter, provenReserves, staleOutpoints)`
  unless supply stays within reserves. A `view` function: a precondition that mutated state
  would be a second thing to get wrong.
- `solvency()` — everything a dashboard or an auditor needs in one call.

`GuardedWBTC.mint` consults it in one line:

```solidity
function mint(address to, uint256 amount) external onlyIssuer {
    guard.checkMint(amount);   // reverts unless supply stays within proven Bitcoin reserves
    _mint(to, amount);
}
```

Three design points that are easy to get backwards:

- **Supply is read from the token, never supplied by the caller.** A caller-supplied figure
  would make the check theatre.
- **Units are satoshis.** The token has 8 decimals, so one token unit is one satoshi and the
  comparison is unit-for-unit against the verifier's value. That removes a class of scaling bug
  from the one line that matters.
- **Staleness fails closed.** Proofs lag (Bitcoin confirmations, then attestation depth), so the
  reserve is always as of some minutes ago. A deposit not yet proven simply does not count, so
  latency makes the guard **stricter**, never more permissive. This is a safety property, not a
  caveat.

`NaiveWBTC` — the identical token with the guard call removed — is deployed **on purpose** as
the control case. Without a side-by-side the claim is rhetoric; with it, the difference is a
transaction receipt.

### The demo, as it actually ran

`node scripts/demo_solvency.mjs`, five beats, all on chain. Full transcript in
[`demo-solvency-transcript-2026-09-12.txt`](demo-solvency-transcript-2026-09-12.txt).

| # | Action | Result |
|---|---|---|
| 1 | issuer declares its five proven Bitcoin outpoints as reserve | 250 BTC counted |
| 2 | backed mint of 50 gwBTC | **succeeds** |
| 3 | attacker mints 250,000 gwBTC | **reverts** — `Insolvent(250050, 250, 0)` |
| 4 | the same attack on the unguarded token | **succeeds** — 249,750 unbacked, no error |
| 5 | reserve proof allowed to age out | even **1 satoshi reverts** |

## 8. Trust model, in full

We do not say "trustless" and stop. What is actually assumed, bottom to top:

- **Bitcoin's proof of work** — inherited through exSat's index. We do **not** run SPV and do
  not validate Bitcoin headers ourselves.
- **exSat's synchronizer/validator set** — the same assumption exSat's own users already make.
- **EOS mainnet finality.** `utxomng.xsat` and `evm.xsat` are ordinary accounts on EOS mainnet
  (chain id `aca376f2…e906`), so the index is as live as EOS is, independent of exSat's
  corporate roadmap. EOS and "Vaulta" are the same chain — a rebrand, not a fork.
- **Attestcoin's quorum** over exSat EVM block headers.

What was removed is not *all* trust. It is **discretionary** trust — the party who could simply
choose to report a different number.

### How this compares to an oracle reserve feed

The difference is real, but it is not "trust versus no trust": both designs end in a quorum. The
difference is **what the quorum is asked to do**.

An oracle committee is asked to *assert a balance it read off chain*, and the consuming contract
has no way to disagree. Attestcoin's quorum is asked to attest a **block header**, and the
contract then verifies for itself that the fact was inside that block and that the block belongs
to the chain.

Corrupting the first produces a wrong number that nothing on chain can detect. Corrupting the
second means forging exSat's history — and with it the Bitcoin data exSat's validators endorsed
under proof of work.

## 9. What this does not do

Stated here rather than left for someone to find.

- **Proving a UTXO exists is not a liquidatable collateral claim.** A point-in-time existence
  proof does not establish ownership on its own, the owner can spend the coin the next block,
  and the same outpoint can be pledged to several protocols at once (detectable, since outpoints
  are globally unique and public — but not preventable by proof alone). Seizing Bitcoin on
  default needs a lock on the Bitcoin side: multisig, timelock, DLC, covenant. Bitcoin Witness
  is the proof layer such a lock would report through. It is not the lock.
- **The guard stops inflation, not theft.** An attacker who drains already-backed tokens out of
  a pool leaves supply and reserves both unchanged; the invariant holds and the guard will not
  object. "You cannot print what is not there" — never "funds cannot be stolen".
- **The issuer declares its own reserve outpoints.** A lying issuer is still a lying issuer.
  What changes is that the lie becomes a single public, permanent, checkable statement instead
  of a recurring private assertion.
- **exSat's Bitcoin index is currently frozen at Bitcoin height 959,115** (22 July 2026). Block
  959,116 has 10 of 11 required endorsements and is waiting on `nodedao.sat`. We found this
  ourselves and did not paper over it: every proven fact carries its `sourceHeight` on chain,
  and `demo.ts` prints how far behind Bitcoin's tip that is.
- **v1 proves one fact type**: `(txid, index) -> value`. Not the script, not the address, not
  spend history. One fact all the way through, verifiable by a reviewer in real time, rather
  than five facts half-wired. `scriptpubkey` and block headers are incremental extensions of the
  same pipe, not architectural ones.

## 10. What we found upstream

**exSat's EVM layer serves `receiptsRoot` and `stateRoot` as 32 zero bytes in every block
header** — not one bad RPC node, but structurally, on every block.

Gluwa's attestor recomputes those roots from the block's own data and compares them to the
header. For an empty block the comparison happens to pass; on the **first block containing a
transaction** the computed root is a real hash that can never equal a permanent zero, so the
attestor rejects the block as a "possible reorg", retries forever, and never advances again.
exSat cannot be attested by stock Attestcoin, and the error names the wrong cause entirely.

What we proved before working around it:

- exSat's **`transactionsRoot` is genuine and canonical** — we recomputed the Merkle-Patricia
  root from each block's own transactions and matched the header byte for byte. That is the
  field inclusion proofs are actually built on, so proofs remain sound.
- The block hash is `keccak(rlp(header))` **including** those zeros, so exSat's headers are
  internally self-consistent and its hash chain is sound.
- In Gluwa's own source, `receipts_root` appears in exactly one place — that comparison. The
  attested digest is `hash(block_number, merkle_root, prev_digest)`; **the receipts root enters
  no attestation and no proof.**

The workaround is `devnet/exsat-shim/` — a transparent WebSocket JSON-RPC proxy that fills in
that one always-zero field from the block's own real receipts and relays everything else byte
for byte. Nothing a proof rests on is touched, and nothing is fabricated: the substituted value
is derived from the chain's own data.

The clean upstream fix is smaller still. Attestcoin **already** skips exactly this check for
pre-Byzantium Ethereum mainnet, for exactly this class of reason, with a comment noting that the
transaction-root check still guards against reorgs. exSat needs the same exemption.

Both defects are written up in this directory and filed against Gluwa's repository:

- [gluwa/creditcoin3#1355](https://github.com/gluwa/creditcoin3/issues/1355) — the attestor
  cannot follow any chain without a receipts trie, and reports it as a reorg that never
  happened. Write-up: [`ISSUE-attestor-receipts-root.md`](ISSUE-attestor-receipts-root.md).
- [gluwa/creditcoin3#1356](https://github.com/gluwa/creditcoin3/pull/1356) — a merged-ready
  patch: `register_bls` logs "already registered" for an account that is not registered at all,
  sending operators looking in exactly the wrong place. CI green.

### Two operational traps worth knowing

- **Attestation genesis height is immutable** once a chain has attestation history;
  `setAttestationChainGenesisBlockNumber` silently no-ops. The workaround is to re-register the
  same chainId under a different `chainName`, which yields a fresh `chain_key` with a genesis
  near the current head (registration is keyed on the `(chainId, chainName)` pair).
- **Attestor registration order matters.** The attestor publishes its BLS key via `attest()`
  only once it is running and sees itself *not* registered. Pre-registering the account with
  `registerAttestor` before starting the binary locks it out permanently — it waits on an
  election it can never join. Correct order: fund the account, start the binary, let it
  self-register and attest, *then* run `forceElection`.

## 11. Tests and verification

- **`contracts/asc/test_verifier.py`** — 9 tests against real Attestcoin V1-format payloads, 5
  of them negative paths: wrong recipient, wrong emitter, wrong event signature, wrong relayer,
  failed receipt. Removing the relayer check makes the suite fail with *"expected revert, but
  the call SUCCEEDED"*.
- **`contracts/evm/test_receiver.py`** — calldata layout verified end to end against a real
  compiled and deployed instance, not against a mock.
- **`scripts/demo.ts`** — the full six-step pipeline against live networks, printing an explorer
  link at every hop so each claim can be checked independently. Transcript:
  [`demo-transcript-2026-09-01.txt`](demo-transcript-2026-09-01.txt).
- **`scripts/demo_solvency.mjs`** — the five-beat solvency demo above. Transcript:
  [`demo-solvency-transcript-2026-09-12.txt`](demo-solvency-transcript-2026-09-12.txt).
- **Reproducibility, proven the hard way.** A machine restart wiped the devnet chain — the node
  had been running without persistent storage, so the registered source chain, the elected
  attestor and the deployed verifier vanished at once. Rebuilding from genesis took one command
  and about ten minutes, and the pipeline proved a fresh UTXO on the new chain. The stand is now
  reproducible by design rather than by luck.

## 12. Running the whole thing from nothing

Read-only checks first — these touch only public infrastructure and need nothing of ours:

```bash
# exSat's Bitcoin UTXO index, live on EOS mainnet
curl -s https://eos.greymass.com/v1/chain/get_table_rows \
  -d '{"json":true,"code":"utxomng.xsat","scope":"utxomng.xsat","table":"chainstate","limit":1}'
```

The full stand:

```bash
cd devnet && docker compose up -d          # CC3 node, attestor, proofgen, exSat shim
node bootstrap-devnet.mjs                  # register exSat, fund + elect the attestor
                                           # prints the chain_key to use everywhere else
node gap.mjs                               # how far the attestor is behind exSat's head

cd ../scripts
node deploy_receiver.mjs                   # exSat EVM (only if redeploying)
EXSAT_CHAIN_KEY=<n> node deploy_verifier.mjs
npx tsx demo.ts --txid <btc_txid> --index <vout>   # prove one Bitcoin fact, six hops

node deploy_guard.mjs                      # ReserveGuard + GuardedWBTC + the control
node demo_solvency.mjs                     # the five beats
node list_facts.mjs                        # every fact the verifier currently holds
```

The browser stand is `ui/index.html` — open it over `http://` (not `file://` or `https://`, or
the browser will refuse the devnet's plain-HTTP RPC) and it reads every number live, degrading
honestly to "not reachable" rather than inventing one.

## 13. Repo map

```
contracts/native/     btcwitness — Antelope C++, reads utxomng.xsat, relays into evm.xsat
contracts/evm/        BitcoinWitnessReceiver — emits the fact as an EVM event
contracts/asc/        BitcoinFactVerifier — proves + authenticates on Creditcoin
                      ReserveGuard — reserve registry and the solvency precondition
                      WrappedBTC — GuardedWBTC and NaiveWBTC (the control case)
devnet/               docker compose stand, bootstrap, attestor/proofgen config, exSat shim
scripts/              deploy, prove, demo, and inspection tooling
ui/                   the browser stand
docs/                 this file, ARCHITECTURE, bug write-ups, run transcripts, the deck
assets/               pipeline diagram, logo
```

---

*Everything in this document was verified against running software and live chain queries, not
inferred from source. Where something is unverified or broken, it says so.*
