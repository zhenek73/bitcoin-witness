# Bitcoin Witness

**Proving Bitcoin without moving Bitcoin.**
Powered by [exSat](https://exsat.network) + [Attestcoin](https://docs.creditcoin.org) + [Creditcoin](https://creditcoin.org)

Built for [BUIDL CTC 2026 Fall](https://dorahacks.io/hackathon/buidl-ctc-2026-fall/detail).

---

## The problem

Today, using Bitcoin in DeFi on another chain almost always means wrapping it — WBTC, cbBTC,
tBTC — which means trusting a custodian to hold the real BTC and honestly report what it holds.
That custodian can lie, get hacked, or disappear. The Bitcoin itself never has to move for the
*fact* about it to be useful — a lending protocol doesn't need your BTC, it needs to know it's
real.

## What Bitcoin Witness does

Bitcoin Witness lets a smart contract on Creditcoin cryptographically verify a fact about Bitcoin
— "this UTXO exists and is worth N sats" or "this specific transaction happened" — **without**
wrapping, bridging, or moving the underlying BTC, and without trusting a custodian's word for it.

[exSat](https://exsat.network) already maintains a full, native on-chain index of the Bitcoin UTXO
set on its Antelope (native) layer. Its own documentation states that its EVM layer *"will in the
near future"* be able to read that data directly — today, it can't. Bitcoin Witness builds that
missing link: a native contract that reads the Bitcoin fact from exSat's native layer and relays
it into an exSat EVM transaction, whose event is then attested and verified into Creditcoin
through the Attestcoin protocol (Creditcoin's cross-chain readability oracle).

```
Bitcoin
   │   (exSat's native consensus over BTC blocks)
   ▼
exSat Native Layer  —  utxomng.xsat / blksync.xsat
   │
   │   Bitcoin Witness native contract reads the fact,
   │   relays it into the EVM layer
   ▼
exSat EVM Layer  —  contract receives the fact, emits a provable event
   │
   ▼
Attestcoin  —  attests the transaction + event
   │
   ▼
Creditcoin  —  verifies the proof on-chain, exposes the Bitcoin fact
```

No bridge. No wrapped token. No custodian. The BTC never leaves Bitcoin.

## Status

🚧 Active development for the hackathon. See `CHANGELOG.md` for day-by-day progress.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full technical breakdown.

## License

[MIT](LICENSE)
