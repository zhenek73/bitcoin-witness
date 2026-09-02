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

**Working end to end on live networks.** Three real Bitcoin UTXOs have been carried from exSat's
on-chain Bitcoin index all the way to a verified, readable fact on Creditcoin.

| Component | Where | Address / identity |
|---|---|---|
| Native relay contract | **EOS mainnet** | [`btcwitness11`](https://bloks.io/account/btcwitness11) |
| EVM receiver | **exSat EVM mainnet** (chain 7200) | [`0xBF823785C5749532AE927d7285093Eae279fe16C`](https://scan.exsat.network/address/0xBF823785C5749532AE927d7285093Eae279fe16C) |
| Attestcoin attestor | self-hosted CC3 devnet | attesting live exSat blocks, `chain_key 8` |
| Fact verifier | self-hosted CC3 devnet | `0x3ed62137c5DB927cb137c26455969116BF0c23Cb` |

**5 real relays** emitted `BitcoinUtxoAttested` on exSat EVM mainnet (blocks 59791789, 59800885,
59801138, 59801283, 59801416); **3 of them are proven on Creditcoin** with `proven = true`.
Three different UTXOs, not one lucky run.

Full transcript of a complete six-step run:
[`docs/demo-transcript-2026-09-01.txt`](docs/demo-transcript-2026-09-01.txt).

Two integration defects found and documented along the way:
[attestor](docs/BUG-attestor-zero-receipts-root.md) · [exSat](docs/BUG-exsat-zero-receipts-root.md).

## Verify the read-only half yourself

No setup, no keys, nothing of ours involved — these read public infrastructure directly:

```bash
# exSat's Bitcoin UTXO index, live on EOS mainnet
curl -X POST https://eos.greymass.com/v1/chain/get_table_rows \
  -d '{"json":true,"code":"utxomng.xsat","scope":"utxomng.xsat","table":"chainstate","limit":1}'

# our five real relays, in EOS mainnet history
curl "https://eos.hyperion.eosrio.io/v2/history/get_actions?account=btcwitness11&filter=btcwitness11:relayutxo"

# one of the relayed facts, as an event on exSat EVM mainnet
curl -X POST https://evm.exsat.network -H "Content-Type: application/json" -d '{
  "jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt",
  "params":["0x9f10a5490d28fa8885aba732dcda4ada9d03e6c231e3996b570fcf42c631a34f"]}'
```

The last one returns `status: 0x1` and one log whose first indexed topic is the Bitcoin txid
`0x230cf03a…4f65` and whose second is the relayer's exSat reserved address — the same numbers the
demo prints.

## Run the whole thing

```bash
npx tsx scripts/demo.ts --txid <btc_txid> --index <vout>
```

Prints every hop with an explorer link for each, so the claim can be checked rather than taken.
The Creditcoin half needs the self-hosted devnet from [`devnet/`](devnet/) running.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full technical breakdown.

## License

[MIT](LICENSE)
