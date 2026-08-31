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

Four pieces, all working:

1. **`btcwitness`** — an Antelope C++ contract that reads a Bitcoin UTXO straight out of
   exSat's `utxomng.xsat` table and relays it into exSat's EVM through an inline action to
   `evm.xsat`. Not a bridge, not a message — a table read and a function call, inside one
   chain. *Compiles with CDT 4.1.0 into an 11 KB wasm; UTXO key derivation verified against
   live chain data.*

2. **`BitcoinWitnessReceiver`** — a Solidity contract on exSat EVM (chain id 7200) that turns
   the relayed fact into a standard EVM event. *Calldata layout verified byte-for-byte against
   a real deployed instance.*

3. **A live Attestcoin attestor watching exSat.** exSat was not a registered Attestcoin source
   chain — so we ran our own Creditcoin node, registered it (`chain_key 7`), bootstrapped an
   attestor, and it is now attesting real exSat mainnet blocks. The attestation stored on
   Creditcoin for height 59,225,940 carries header hash `0xe47664ed…53ff6` — byte-identical to
   what exSat's own RPC returns for that block.

4. **`BitcoinFactVerifier`** — a Creditcoin contract that proves the attested payload through
   the BlockProver precompile, then authenticates the fact *from inside the attested bytes*:
   right recipient, right emitting contract, right event signature, right relayer, successful
   receipt. A caller chooses only *which* proven transaction to submit — never what it says.
   *9 tests against real V1-format payloads, 5 of them negative paths.*

## 4. What we are honest about

Most hackathon projects say "trustless" and stop. Here is the actual trust model:

- We do **not** run SPV or validate Bitcoin headers ourselves. We inherit exSat's Bitcoin
  consensus — miners' PoW plus exSat's synchronizer/validator set — which is exactly the
  assumption exSat's own users already make.
- Below that sits **EOS mainnet finality**: `utxomng.xsat` and `evm.xsat` are ordinary accounts
  on EOS mainnet (chain id `aca376f2…e906`), so the index is as live as EOS is, independent of
  exSat's corporate roadmap.
- Above it sits **Attestcoin's quorum** over exSat EVM blocks.

What we removed is not *all* trust. It is **discretionary** trust — the custodian who could
choose to lie. Every remaining assumption is a public, adversarial, economically-secured
consensus that anyone can check. That is a categorically different thing from a multisig
promising an audit next quarter.

We also scoped v1 down on purpose: it proves *"UTXO (txid, index) exists and holds N sats."*
Not the script, not the address, not spend history. One fact, all the way through, verifiable
by a judge in real time — instead of five facts half-wired.

## 5. Why this matters beyond the demo

Once a Creditcoin contract can read a Bitcoin fact, the things built on top are not exotic:

- **Proof of reserves that isn't a PDF.** An exchange publishes UTXO ids; anyone proves the
  balances on-chain, no custodian statement involved.
- **BTC-collateralized credit without wrapping.** Creditcoin is a credit chain. Underwriting a
  loan against Bitcoin you can *verify* but never *touch* is the exact shape of its thesis.
- **A general Bitcoin-fact oracle.** Block headers, spends, script conditions — same pipe,
  richer payloads. The hard part was the pipe.

## 6. Why us

The pipeline crosses three runtimes that almost nobody writes in at once: Antelope C++, Solidity,
and Substrate. Our native side is not a first attempt — we ship production Antelope contracts on
EOS mainnet already. That is why the unglamorous half of this project (RAM economics, inline-action
permissions, `@eosio.code`, secondary-index key derivation) is done and correct rather than
hand-waved.

## 7. Status

| Piece | State |
|---|---|
| Native relay contract | builds (11 KB wasm), key derivation verified on live chain |
| EVM receiver | written, round-trip verified on a real EVM |
| Creditcoin devnet + exSat registered | **working** (chain_key 7) |
| Attestor against exSat mainnet | **working** — real blocks attested, hash-matched |
| Creditcoin verifier | written, 9 tests incl. 5 negative paths |
| Live end-to-end run | deploying now |

Everything above was verified against running software, not inferred from source. Where it isn't
done, this table says so.

---

*Demo: `npx tsx scripts/demo.ts --txid <btc_txid> --index <vout>` — prints every hop, with an
explorer link for each, so you can check the claim rather than take it.*
