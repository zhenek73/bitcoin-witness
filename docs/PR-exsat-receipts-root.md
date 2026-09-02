# fix(eth): skip the receipt-root check for exSat, which never populates it

## What happens today

An attestor pointed at exSat's EVM layer (chain id 7200) advances through empty blocks
and then stops permanently at the **first block containing a transaction**, repeating
this forever:

```
ERROR stream_eth::roots: Eth connection error
      err=Computed transactions/receipts roots do not match block header for block 59226042
      (possible reorg between RPC calls)
WARN  stream_eth::roots: Reconnecting to Eth...
```

It is not a reorg, and it is not transient. It repeats on the identical block number
indefinitely, across restarts, and would recur on every subsequent transaction-bearing
block. `last_attested_block` never moves again.

## Why

exSat's EVM layer does not maintain a receipts trie or a state trie. Every block header
it serves reports `receiptsRoot` and `stateRoot` as 32 zero bytes — on every block,
whether or not it has transactions:

```console
$ curl -s -X POST https://evm.exsat.network -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x38DB18A",true]}'
# block 59801418 — txCount 1
#   transactionsRoot 0x4f8a21e5839d3c1e9249ce90a972119380cce4a477ad23027058bfb2d38ae7bf
#   receiptsRoot     0x0000000000000000000000000000000000000000000000000000000000000000
#   stateRoot        0x0000000000000000000000000000000000000000000000000000000000000000
```

Verified across many consecutive blocks, with and without transactions — this is
structural, not one bad RPC replica.

`EthBlock::try_create` (`common/eth/src/lib.rs`) recomputes the receipt root and compares
it to the header. For an **empty** block the comparison is skipped by the existing
early return, so those pass. For a block with at least one transaction the recomputed
root is a real non-zero hash which can never equal a permanent zero, so every such block
is rejected as `BlockHeaderRootsMismatch` — surfaced to the operator as a reorg, which
sends debugging in exactly the wrong direction.

## Why skipping the check is safe here

Three things were verified independently against the live chain before proposing this:

1. **`transactionsRoot` is genuine and canonical on exSat.** Recomputing the
   Merkle-Patricia root from each block's own transactions matches the header byte for
   byte (checked on both the block that stalls the attestor, 59226042, and a later one,
   59801416). The transaction-root check above therefore still does its job, including
   guarding against reorg-induced cross-fetch mismatches — the same reasoning the
   existing pre-Byzantium exemption already relies on.

2. **exSat's headers are internally self-consistent.** The reported block hash equals
   `keccak(rlp(header))` computed *including* the zero roots, so the header hash chain is
   sound and nothing about it is ambiguous.

3. **The receipts root is not part of anything attested or proven.** In this repository
   `receipts_root` appears in exactly one place — the comparison this PR touches. The
   attested digest is `Block::hash_payload(block_number, root, prev_digest)`, where `root`
   is the merkle root the inclusion proofs are built on. Skipping the comparison changes
   no attestation, no digest and no proof — only whether the block is accepted for
   processing at all.

## The change

Extends the existing `skip_receipt_root` exemption — already present for pre-Byzantium
Ethereum mainnet, for an unrelated but structurally identical reason — to cover exSat, and
expands the comment to explain both cases. No behaviour changes for any other chain.

```rust
const EXSAT_CHAIN_ID: u64 = 7200;

let skip_receipt_root = (chain_id == ETHEREUM_MAINNET_CHAIN_ID
    && expected_number < ETHEREUM_BYZANTIUM_BLOCK)
    || chain_id == EXSAT_CHAIN_ID;
```

## Alternative, if you prefer it

Hard-coding a second chain id follows the existing style, but a per-chain
`skip_receipt_root_check` flag in the source-chain config would generalise better — exSat
is unlikely to be the last L2 that skips the receipts trie. Happy to rework it that way;
this version was kept minimal to match what is already there.

## Context

Found while building [Bitcoin Witness](https://github.com/zhenek73/bitcoin-witness), which
attests exSat EVM blocks in order to prove Bitcoin UTXO facts on Creditcoin. Until this is
fixed upstream, running an attestor against exSat requires a proxy that fills the zeroed
field in from the block's own receipts, which is a workaround nobody should need.
