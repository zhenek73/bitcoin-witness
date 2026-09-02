# Bitcoin Witness — pitch

**Proving Bitcoin without moving Bitcoin.**
BUIDL CTC 2026 Fall · exSat + Attestcoin + Creditcoin

---

## 1. The problem, in one paragraph

Every time Bitcoin is used as collateral on another chain, it gets wrapped. WBTC, cbBTC,
tBTC — all of them work the same way underneath: someone holds the real BTC, and everyone
else trusts a report about what they hold. That trust has failed before and will fail again,
and it fails in the worst possible way — silently, until the day it doesn't.

But here is the thing nobody says out loud: **a lending protocol does not need your Bitcoin.
It needs to know your Bitcoin is real.** We wrap BTC because moving the asset is the only
way we know to move the *fact* about it. That is a tooling limitation dressed up as a
financial primitive.

## 2. The insight

exSat already maintains a complete, native, on-chain index of the Bitcoin UTXO set —
166 million UTXOs, currently at Bitcoin height 959,115, kept current by real mining pools
submitting real blocks with real proof-of-work. It is one of the most under-used pieces of
infrastructure in crypto: a Bitcoin state machine that smart contracts can read.

Except they can't, quite. That index lives on exSat's *native* (Antelope) layer. Solidity
contracts live on exSat's *EVM* layer. exSat's own documentation says the EVM layer *"will
in the near future"* be able to read that data. Today it cannot. And nothing outside exSat
can read it at all.

**Bitcoin Witness builds that missing link — and then carries it one chain further, to
Creditcoin.**

## 3. What we built

```
Bitcoin  ──►  exSat native index  ──►  exSat EVM  ──►  Attestcoin  ──►  Creditcoin
              (utxomng.xsat)          (event)         (attestation)    (on-chain fact)
```

Four pieces, all deployed and all running:

1. **`btcwitness11`** — an Antelope C++ contract, live on **EOS mainnet**, that reads a Bitcoin
   UTXO straight out of exSat's `utxomng.xsat` table and relays it into exSat's EVM through an
   inline action to `evm.xsat`. Not a bridge, not a message — a table read and a function call,
   inside one chain.

2. **`BitcoinWitnessReceiver`** — a Solidity contract live on **exSat EVM mainnet** (chain 7200)
   at `0xBF823785C5749532AE927d7285093Eae279fe16C`, which turns the relayed fact into a standard
   EVM event. It has emitted **5 real `BitcoinUtxoAttested` events**, all publicly checkable.

3. **A live Attestcoin attestor watching exSat.** exSat was not a registered Attestcoin source
   chain — so we ran our own Creditcoin node, registered it (`chain_key 8`), bootstrapped an
   attestor, and it now attests real exSat mainnet blocks continuously.

4. **`BitcoinFactVerifier`** — a Creditcoin contract at `0x3ed62137c5DB927cb137c26455969116BF0c23Cb`
   that proves the attested payload through the BlockProver precompile, then authenticates the fact
   *from inside the attested bytes*: right recipient, right emitting contract, right event
   signature, right relayer, successful receipt. A caller chooses only *which* proven transaction
   to submit — never what it says. 9 tests, 5 of them negative paths.

**Three different Bitcoin UTXOs have gone the whole way and read back `proven = true` on
Creditcoin.** Three, not one — this is reproducible, not a lucky run.

## 4. What we found on the way

exSat's EVM layer serves **`receiptsRoot` and `stateRoot` as 32 zero bytes in every block header**
— not one bad RPC node, but structurally, on every block. Gluwa's Attestcoin attestor recomputes
those roots from the block's own data and compares them to the header. For an empty block the
comparison happens to pass; on the **first block containing a transaction** the computed root is a
real hash that can never equal a permanent zero, so the attestor rejects the block as a "possible
reorg", retries forever, and never advances again. exSat simply cannot be attested by stock
Attestcoin — and the error message points at the wrong cause entirely.

We diagnosed it, proved which parts of the chain are and aren't sound, and got past it:

- exSat's **`transactionsRoot` is genuine and canonical** — we recomputed the Merkle-Patricia root
  from each block's own transactions and matched the header byte for byte. That is the field
  inclusion proofs are actually built on.
- The block hash is `keccak(rlp(header))` **including** those zeros, so exSat's headers are
  internally self-consistent and its hash chain is sound.
- In Gluwa's own source, `receipts_root` appears in exactly one place — that comparison. The
  attested digest is `hash(block_number, merkle_root, prev_digest)`; **the receipts root enters no
  attestation and no proof.**

So we run a transparent WS proxy that fills in that one always-zero field from the block's own real
receipts and relays everything else byte for byte. Nothing that a proof rests on is touched, and
nothing is fabricated — the substituted value is derived from the chain's own data.

The clean upstream fix is smaller still: Attestcoin **already** skips exactly this check for
pre-Byzantium Ethereum mainnet, for exactly this class of reason, with a comment noting that the
transaction-root check still guards against reorgs. exSat needs the same exemption. Both defects
are written up in [`docs/`](docs/) and reported upstream.

## 5. What we are honest about

Most hackathon projects say "trustless" and stop. Here is the actual trust model:

- We do **not** run SPV or validate Bitcoin headers ourselves. We inherit exSat's Bitcoin
  consensus — miners' PoW plus exSat's synchronizer/validator set — which is exactly the
  assumption exSat's own users already make.
- Below that sits **EOS mainnet finality**: `utxomng.xsat` and `evm.xsat` are ordinary accounts
  on EOS mainnet (chain id `aca376f2…e906`), so the index is as live as EOS is, independent of
  exSat's corporate roadmap.
- Above it sits **Attestcoin's quorum** over exSat EVM blocks.
- exSat's Bitcoin index is currently **frozen at Bitcoin height 959,115** (22 July) — its
  block-endorsement consensus has stalled. We found this ourselves and did not paper over it:
  every proven fact carries its `sourceHeight` on-chain, and `demo.ts` prints how far behind
  Bitcoin's tip that is. An oracle that shows the age of its data is more honest than one that
  pretends it is always fresh.

What we removed is not *all* trust. It is **discretionary** trust — the custodian who could
choose to lie. Every remaining assumption is a public, adversarial, economically-secured
consensus that anyone can check. That is a categorically different thing from a multisig
promising an audit next quarter.

We also scoped v1 down on purpose: it proves *"UTXO (txid, index) exists and holds N sats."*
Not the script, not the address, not spend history. One fact, all the way through, verifiable
by a judge in real time — instead of five facts half-wired.

## 6. Why this matters beyond the demo

Once a Creditcoin contract can read a Bitcoin fact, the things built on top are not exotic:

- **Proof of reserves that isn't a PDF.** An exchange publishes UTXO ids; anyone proves the
  balances on-chain, no custodian statement involved.
- **BTC-collateralized credit without wrapping.** Creditcoin is a credit chain. Underwriting a
  loan against Bitcoin you can *verify* but never *touch* is the exact shape of its thesis.
- **A general Bitcoin-fact oracle.** Block headers, spends, script conditions — same pipe,
  richer payloads. The hard part was the pipe.

## 7. Why us

The pipeline crosses three runtimes that almost nobody writes in at once: Antelope C++, Solidity,
and Substrate. Our native side is not a first attempt — we ship production Antelope contracts on
EOS mainnet already. That is why the unglamorous half of this project (RAM economics, inline-action
permissions, `@eosio.code`, secondary-index key derivation) is done and correct rather than
hand-waved. It is also why, when the pipeline broke in three genuinely obscure places — a
cross-contract secondary index addressed by declaration order, two separate `evm.xsat` balance
ledgers, and a reserved-address layout that differs from its own documentation — each one was
root-caused against live chain data rather than guessed at.

## 8. Status

| Piece | State |
|---|---|
| Native relay contract | **deployed, EOS mainnet** (`btcwitness11`), 5 real relays |
| EVM receiver | **deployed, exSat EVM mainnet**, 5 `BitcoinUtxoAttested` events |
| Creditcoin devnet + exSat registered | **working** (`chain_key 8`) |
| Attestor against exSat mainnet | **working** — attesting live exSat blocks |
| Creditcoin verifier | **deployed**, 9 tests incl. 5 negative paths |
| Live end-to-end run | **done — 3 UTXOs proven**, transcript in repo |

Everything above was verified against running software and live chain queries, not inferred from
source.

---

*Demo: `npx tsx scripts/demo.ts --txid <btc_txid> --index <vout>` — prints every hop, with an
explorer link for each, so you can check the claim rather than take it.*
