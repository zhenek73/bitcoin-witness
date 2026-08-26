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

## Attestors

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
