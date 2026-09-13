# Bitcoin Witness

**Proving Bitcoin without moving Bitcoin.**
Powered by [exSat](https://exsat.network) + [Attestcoin](https://docs.creditcoin.org) + [Creditcoin](https://creditcoin.org)

Built for [BUIDL CTC 2026 Fall](https://dorahacks.io/hackathon/buidl-ctc-2026-fall/detail).

---

**Bitcoin Witness is a verifiable Bitcoin data source for Creditcoin.** exSat provides the
Bitcoin state data; Attestcoin carries an attestation of exSat's EVM history to Creditcoin,
where `BitcoinFactVerifier` checks the fact inside it; `ReserveGuard` is the first consumer
built on top, and it exists to show the primitive is worth something rather than to be the
project itself.

---

## The problem

Every wrapped Bitcoin rests on one invariant: the supply on this chain never exceeds the BTC
held in reserve.

That invariant *is* monitored today — Chainlink publishes a WBTC proof-of-reserve feed, and
mints can already be gated on it. The problem is not that nobody looks. The problem is what
the contract is looking at: a reserve feed is an **assertion**. A committee of oracle nodes
reads a Bitcoin node off chain, agrees on a number, signs it, and posts it. The consuming
contract cannot check that number against anything — it can only trust the signers and the
address list they were pointed at. The reserve is reported to the chain, never proven to it.

That was the only thing available, because **Bitcoin state has never been natively readable by
a Creditcoin contract.** The BTC never has to move for the *fact* about it to be useful — what
was missing was a way to move the fact, as evidence rather than as testimony.

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

### What the fact is for

A proven Bitcoin fact is only interesting if something acts on it. `ReserveGuard` is the first
consumer: it sums the proven, still-fresh value of the outpoints an issuer has declared as
reserve, and `GuardedWBTC.mint` refuses to create a token that would push wrapped supply above
that number.

```solidity
function mint(address to, uint256 amount) external onlyIssuer {
    guard.checkMint(amount);   // reverts unless supply stays within proven Bitcoin reserves
    _mint(to, amount);
}
```

The number it reads is not one anybody asserted. It comes from Bitcoin's own
proof-of-work-verified UTXO set, through an Attestcoin attestation over a real exSat block,
and the BlockProver precompile checks it on chain. `NaiveWBTC`, the same token without the
guard, is deployed alongside as the control case, so the difference can be demonstrated rather
than asserted: `node scripts/demo_solvency.mjs`.

It stops **inflation**, not theft — an attacker draining already-backed tokens leaves the
invariant intact. And latency makes it stricter, never looser: an unproven or stale reserve
simply stops counting, so the guard fails closed.

## Status

**Working end to end on live networks.** Five real Bitcoin UTXOs have been carried from exSat's
on-chain Bitcoin index all the way to a verified, readable fact on Creditcoin — and a wrapped
token on Creditcoin now mints against one of them under an on-chain solvency check.

| Component | Where | Address / identity |
|---|---|---|
| Native relay contract | **EOS mainnet** | [`btcwitness11`](https://bloks.io/account/btcwitness11) |
| EVM receiver | **exSat EVM mainnet** (chain 7200) | [`0xBF823785C5749532AE927d7285093Eae279fe16C`](https://scan.exsat.network/address/0xBF823785C5749532AE927d7285093Eae279fe16C) |
| Attestcoin attestor | self-hosted CC3 devnet | attesting live exSat blocks, `chain_key 7` |
| Fact verifier | self-hosted CC3 devnet | `0xc01Ee7f10EA4aF4673cFff62710E1D7792aBa8f3` |
| Reserve guard | self-hosted CC3 devnet | `0x21cb3940e6Ba5284E1750F1109131a8E8062b9f1` |
| Guarded wrapped BTC | self-hosted CC3 devnet | `0x3469E1DaC06611030AEce8209F07501E9A7aCC69` |
| Unguarded control token | self-hosted CC3 devnet | `0x7d4567B7257cf869B01a47E8cf0EDB3814bDb963` |

**7 real relays** emitted `BitcoinUtxoAttested` on exSat EVM mainnet; **5 of them are proven on
Creditcoin** with `proven = true`. Five different UTXOs, not one lucky run.

The devnet addresses above are local by nature — a self-hosted CC3 chain is rebuilt from
genesis by `devnet/bootstrap-devnet.mjs`, and the deployment scripts write the current
addresses into `scripts/verifier-deployment.json` and `scripts/guard-deployment.json`.

Full transcripts of complete runs:
[six-step pipeline](docs/demo-transcript-2026-09-01.txt) ·
[solvency guard](docs/demo-solvency-transcript-2026-09-12.txt).

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

Then put the proven fact to work:

```bash
node scripts/deploy_guard.mjs      # ReserveGuard + GuardedWBTC + the unguarded control
node scripts/demo_solvency.mjs     # declare reserve, mint, watch an unbacked mint revert
```

`demo_solvency.mjs` runs five beats against the live devnet: declare a real Bitcoin outpoint as
reserve, mint 10 gwBTC against 50 BTC proven, watch a 50,000 gwBTC mint revert with
`Insolvent(...)`, watch the *unguarded* token accept the same attack without complaint, and
finally let the reserve proof age out and see even one satoshi refused.

## Documentation

**[`docs/OVERVIEW.md`](docs/OVERVIEW.md) is the single document that covers everything** — the
problem, the data path hop by hop, every deployed address, the solvency layer, the full trust
model, what the project cannot claim, the tests, the upstream findings, and how to run the whole
stand from nothing. Start there.

Narrower documents: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (component-level detail) ·
[`PITCH.md`](PITCH.md) (the argument) · [`CHANGELOG.md`](CHANGELOG.md) (dated history, including
every mistake).

## License

[MIT](LICENSE)
