## Summary

An attestor cannot follow any EVM chain that does not maintain a receipts trie. It walks
through empty blocks fine, then stops **permanently** at the first block containing a
transaction, and reports the failure as a reorg that never happened.

This is not hypothetical — it is reproducible today against exSat's EVM layer (chain id
7200), and the misleading error cost us a full day of debugging in the wrong direction.

## Reproduction

Point an attestor at `wss://evm.exsat.network/` and let it run:

```
ERROR stream_eth::roots: Eth connection error
      err=Computed transactions/receipts roots do not match block header for block 59226042
      (possible reorg between RPC calls)
WARN  stream_eth::roots: Reconnecting to Eth...
```

It repeats on the identical block number every ~2 minutes, indefinitely, across restarts.
`last_attested_block` never moves again.

## Root cause

exSat does not maintain a receipts trie or a state trie. Every header it serves reports
`receiptsRoot` and `stateRoot` as 32 zero bytes — on every block, with or without
transactions:

```console
$ curl -s -X POST https://evm.exsat.network -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x38EF2C8",false]}'
# block 59801416 — 1 transaction
#   transactionsRoot 0x4f8a21e5839d3c1e9249ce90a972119380cce4a477ad23027058bfb2d38ae7bf
#   receiptsRoot     0x0000000000000000000000000000000000000000000000000000000000000000
#   stateRoot        0x0000000000000000000000000000000000000000000000000000000000000000
```

Checked across many consecutive blocks — structural, not one bad RPC replica.

In `EthBlock::try_create` (`common/eth/src/lib.rs`) the recomputed receipt root is compared
to the header. Empty blocks are unaffected because of the early return above it. Any block
with at least one transaction produces a real non-zero computed root, which can never equal
a permanent zero, so it is rejected as `BlockHeaderRootsMismatch` — surfaced to the operator
as a suspected reorg.

## Why the diagnosis is expensive

The error names the wrong cause. A "possible reorg between RPC calls" sends an operator to
look at RPC stability, load balancers and chain health, none of which are the problem. It
also looks transient, so the natural reaction is to wait or restart — and both appear to
work briefly, because the attestor advances through the next run of empty blocks before
hitting the next transaction-bearing one.

## What we verified before proposing anything

1. **exSat's `transactionsRoot` is genuine and canonical.** Recomputing the
   Merkle-Patricia root from each block's own transactions matches the header byte for byte
   (checked on the stalling block 59226042 and on 59801416). So the transaction-root check
   above still does its job.
2. **exSat's headers are internally self-consistent.** The reported block hash equals
   `keccak(rlp(header))` computed *including* the zero roots.
3. **The receipts root is not part of anything attested.** In this repository
   `receipts_root` appears in exactly one place — that comparison. The attested digest is
   `Block::hash_payload(block_number, root, prev_digest)`. Skipping the comparison changes
   no attestation, no digest and no proof.

## Suggested fix

`skip_receipt_root` already exists for pre-Byzantium Ethereum mainnet, for an unrelated but
structurally identical reason, with a comment noting the transaction-root check still guards
against reorgs. This is the same situation.

A proof-of-concept patch is attached as a PR — it extends that exemption to exSat, which
keeps the change in the shape already there. **A per-chain `skip_receipt_root_check` config
flag would generalise better**, since exSat is unlikely to be the last L2 that skips the
receipts trie; we did not implement that version because it would mean guessing at your
preferred config API. Happy to rework it either way.

Separately — and independent of any fix — **the error message deserves to distinguish "the
receipts root does not match" from "the transactions root does not match"**. They have
completely different causes, and only the second one implies a reorg.

## Context

Found while building [Bitcoin Witness](https://github.com/zhenek73/bitcoin-witness), which
attests exSat EVM blocks to prove Bitcoin UTXO facts on Creditcoin. Until this is addressed,
running an attestor against exSat requires a proxy that fills the zeroed field in from the
block's own receipts — a workaround nobody should need.
