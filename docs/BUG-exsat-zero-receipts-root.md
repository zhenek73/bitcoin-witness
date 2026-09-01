# exSat EVM block headers report `receiptsRoot` and `stateRoot` as all zeros

**For:** exSat
**Component:** exSat EVM layer / `evm.xsat`, as served by `https://evm.exsat.network`
**Question:** is this intentional, and is it expected to stay this way?

## What we observed

Every exSat EVM block header we have inspected reports both `receiptsRoot` and
`stateRoot` as 32 zero bytes, regardless of whether the block contains transactions.

Block 59226042 (`0x387b7ba`), abridged:

```json
{
  "number": "0x387b7ba",
  "hash": "0x39ebc33c0654509912788f1d9fb81fc76e521d87b10fa54de449311d1af7f16e",
  "transactionsRoot": "0xb7d37bff497570b7a1efbcaa45cdee3e57d1a840b0b91410da3c57dd2c2205d1",
  "receiptsRoot": "0x0000000000000000000000000000000000000000000000000000000000000000",
  "stateRoot":    "0x0000000000000000000000000000000000000000000000000000000000000000",
  "transactions": [ { "hash": "0xe0d72ff5...", "type": "0x0", ... } ]
}
```

The block has one transaction, `eth_getBlockReceipts` returns a well-formed receipt for
it with `status: "0x1"` and a real log, and the computed receipts root for that data is
`0x928f305f777dd24e77adb8abca2f0e318f2f677b89834f19cb8babe2b7224e3d` — but the header
carries zeros.

Consecutive blocks 59226040–59226044, a mix of empty and non-empty, all show the same
pattern, so this is not a single bad block or a single inconsistent replica.

`transactionsRoot`, by contrast, is genuine and canonical: recomputing the
Merkle-Patricia root from a block's transactions reproduces the header value
byte-for-byte, including the canonical empty-trie hash for empty blocks. So the header is
self-consistent and the block hash chain is verifiable — only these two fields are
unpopulated.

## Why it matters

Standard Ethereum tooling that cross-checks a block body against its header treats this
as corruption or a reorg. Concretely, Gluwa's Attestcoin `attestor` (the component that
lets Creditcoin verify facts from other chains) recomputes the receipts root and compares
it to the header. It passes empty blocks, then halts permanently at the first block
containing a transaction, reporting:

```
Computed transactions/receipts roots do not match block header
for block 59226042 (possible reorg between RPC calls)
```

It then retries the same block forever. We hit this while building a Bitcoin-UTXO oracle
that relays facts from exSat's `utxomng.xsat` index to Creditcoin, and it cost a
substantial amount of debugging time before the cause was clear — the error points at
reorgs and RPC peers, not at a missing header field.

We expect any other integration that verifies receipts against headers — light clients,
bridges, indexers with integrity checks, cross-chain provers — to hit the same wall.

## What we would like to know

1. Is the absence of a receipts trie and an Ethereum-style state trie a deliberate design
   choice for exSat's EVM layer (for example because Antelope's state model does not map
   onto a Merkle-Patricia state trie)?
2. If so, is it documented anywhere for integrators? We could not find it, and the
   zero-valued fields look like a bug rather than a documented deviation.
3. Would populating `receiptsRoot` — which is computable from data the node already has —
   be feasible? Unlike `stateRoot`, it does not require maintaining a state trie, and it
   is the field most integrations actually check.

We worked around it locally with a proxy that fills in the computed receipts root for
transaction-bearing blocks, which was enough to make the whole pipeline work. Happy to
share details if useful.
