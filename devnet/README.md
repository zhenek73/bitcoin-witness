# Local Creditcoin devnet

## Why this exists

Attestcoin attests only source chains that have been registered on-chain via the
`register_chain` extrinsic, which is gated by the **Operators** origin. Creditcoin's public
network has Ethereum, Sepolia, Polygon Amoy and a few local test chains registered — exSat is not
among them, and adding it is not something an outside developer can request.

Running our own CC3 instance makes us the operator *of that instance*, so we can register exSat
and point attestors at it. This runs the real Creditcoin protocol from the official
`gluwa/creditcoin3` image — it is not a mock or a stand-in for Attestcoin.

## Running it

```bash
docker compose up -d          # CC3 node on ws://127.0.0.1:9944
npm install
npm run register              # registers exSat as a source chain
```

Verified 2026-08-26. `npm run register` prints:

```
registered: {"chainKey":"7","chainId":"7,200","chainName":"exSat","chainEncoding":"V1","maturityStrategy":"EvmSafe"}
```

## The chain_key is assigned, not chosen

The pallet allocates the next free `chain_key`; it is **not** the EVM chainId. exSat has EVM
chainId 7200 but was assigned chain_key 7 here. Read the value from the registration event (or
from the ChainInfo precompile at `0x…0fd3`, `get_supported_chains()`) and pass it to
`BitcoinFactVerifier`'s constructor. Conflating the two produces a source check that silently
never matches.

For reference, what a fresh dev chain already has registered:

| chain_key | chainId | name |
|---|---|---|
| 1 | 1 | Ethereum |
| 2 | 31337 | Anvil1 |
| 3 | 11155111 | Sepolia ethereum |
| 4 | 31338 | Anvil2 |
| 5 | 31339 | Anvil3 |
| 6 | 80002 | Polygon amoy testnet |
| 7 | 7200 | exSat *(registered by this script)* |

Polygon Amoy being there is a useful precedent: encoding `V1` is not Ethereum-specific, it
applies to EVM chains generally — which is why exSat needs no new encoding variant.

## Bootstrapping an attestor

A registered chain still needs an attestor watching it. The sequence that works — each step
exists because the previous one is a precondition, and skipping one fails in a way that does not
name the real cause:

```bash
node bootstrap-attestor.mjs      # stash bonds, registers the attestor, sets quorum, elects
docker compose up -d attestor    # attestor submits its BLS key and starts producing
```

Three things about this are worth knowing before debugging it yourself:

1. **The stash and the attestor must be different accounts.** `registerAttestor(chainKey,
   attestorId)` is signed by the stash (which bonds the funds) and names a *different* account as
   the attestor. Passing the same account for both fails with `InvalidAttestorAccount`.

2. **`registerAttestor` is `ensure_signed`, not a sudo call.** Wrapping it in `sudo.sudo(...)`
   succeeds — and does nothing useful, because the caller becomes the sudo pseudo-account rather
   than your stash. It has to be signed directly.

3. **The attestor only submits its own `attest()` if it already sees itself as `Idle` on-chain.**
   Its startup logs `skipping attest() — already registered status=None` when it finds no record
   at all, which reads like the opposite of what happened. Register it first, then start it.

Quorum is `targetSampleSize`. It defaults to 3, so a single-attestor devnet never reaches quorum
until you lower it to 1 — and that change lands in `pendingTargetSampleSize` until an epoch
boundary or `forceApplyUpdates()`.

## Verified end to end

Run on 2026-08-26 against live exSat mainnet:

```
📡 produced local attestation digest=0x9768a07f… height=59225940
🗳️ quorum reached digest=0x9768a07f… height=59225940 votes=1
✅ genesis attestation finalized on-chain height=59225940
```

The attestation stored on Creditcoin records `headerHash`
`0xe47664ed9713c33aeb7397b002a8ad021e48ce4ec625368846aa6b8621953ff6` for height 59225940 — which
is byte-identical to what exSat's own RPC returns for that block. Attestcoin is attesting real
exSat blocks, not fixtures.

## Attestor config

Attestors are a separate binary in the same image, configured per source chain. The relevant
settings for exSat:

```yaml
attestor:
  chain_key: 7               # as assigned above, NOT 7200
eth:
  url: "wss://evm.exsat.network/"   # verified reachable over WSS
cc3:
  url: "ws://127.0.0.1:9944"
```

exSat's EVM WebSocket endpoint was confirmed working (an `eth_blockNumber` call over
`wss://evm.exsat.network/` returns the current head), which matters because the attestor
subscribes over WS rather than polling HTTP.
