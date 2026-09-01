# Attestcoin attestor cannot follow a chain whose headers omit `receiptsRoot`

**For:** Gluwa / Creditcoin (`gluwa/creditcoin3`)
**Component:** `attestor` (binary version `3.131.0`, image `gluwa/creditcoin3`) and
`proof-gen-api-server`
**Severity:** the attestor stops permanently and reports a misleading cause
**Source chain:** exSat EVM mainnet, chainId 7200, `https://evm.exsat.network`

## Summary

On exSat, the attestor stops at the first block containing a transaction and never
advances again. It reports the failure as a suspected reorg:

```
ERROR stream_eth::roots: Eth connection error
  err=Computed transactions/receipts roots do not match block header
      for block 59226042 (possible reorg between RPC calls)
WARN  stream_eth::roots: Reconnecting to Eth...
```

It is not a reorg. exSat's EVM layer does not maintain a receipts trie or an
Ethereum-style state trie, and reports **`receiptsRoot` and `stateRoot` as 32 zero bytes
in every block header**. The attestor recomputes the receipts root from the block's own
receipts and compares it to that constant zero, so for any block with at least one
transaction the comparison can never succeed. The retry loop is therefore infinite: we
observed the identical error on the identical block every ~2 minutes for over 15 minutes,
across a container restart, with `last_attested_block` frozen the entire time.

`proof-gen-api-server` performs the same check and fails the same way, reporting
`block body or receipts inconsistent with header from this RPC peer`.

## Evidence

Block 59226042 (`0x387b7ba`) via `eth_getBlockByNumber`, abridged:

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

`eth_getBlockReceipts` for the same block returns a well-formed receipt with
`status: "0x1"` and a real log. The transaction and its receipt are fine; only the header
field is absent.

This is not specific to one block or one RPC replica. Consecutive blocks
59226040–59226044 (a mix of empty and transaction-bearing) all report the same all-zero
`receiptsRoot` and `stateRoot` from the same endpoint.

**`transactionsRoot` is genuine and canonical.** Recomputing the Merkle-Patricia root
from each block's transactions reproduces the header value byte-for-byte — verified for
59226042, for 59791789, and for an empty block (where it is the canonical empty-trie hash
`0x56e81f17…`).

## Why the failure starts at one specific block

The attestor passes empty blocks without complaint even though their header is equally
zero: block 59226041's true receipts root is the canonical empty-trie hash
`0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421`, which also differs
from the header's zeros, and the attestor advanced past it normally. Block 59226042 is
simply the first transaction-bearing block after the configured start height. So the wall
is not one bad block — it is every block that contains a transaction.

## Impact

- An attestor pointed at exSat halts permanently at the first transaction-bearing block
  after its start height.
- The reported cause ("possible reorg between RPC calls") sends operators looking for an
  RPC or reorg problem. Diagnosing the real cause took hours; a reorg that reproduces on
  the identical block number across restarts is what finally ruled that explanation out.
- `proof-gen-api-server` is affected identically, so even a manually-advanced attestor
  would not yield proofs.

## Reproduce

1. Register exSat (chainId 7200) as a source chain with an attestation genesis a few
   hundred blocks below any transaction-bearing block.
2. Run the attestor against `wss://evm.exsat.network/`.
3. It advances through empty blocks and stops at the first block containing a
   transaction, repeating the error above indefinitely.

## Suggested fixes

1. **Do not treat a root mismatch as a transient reorg.** A genuine reorg does not
   reproduce on the same block number across reconnects and restarts. Distinguishing
   "header disagrees consistently" from "header changed between calls" would have made
   this diagnosable in minutes rather than hours.
2. **Allow the receipts-root check to be relaxed per chain.** There is currently no
   config or CLI option for it (`attestor --help` on 3.131.0 has none), and
   `registerChain`'s `chainEncoding` has only the `V1` variant, described as generic
   across EVM chains. A chain that does not maintain a receipts trie cannot be attested
   at all today, even though the data an inclusion proof depends on — the transactions
   trie — is completely sound on such a chain.
3. Consider whether the receipts root needs checking for the proof types actually
   supported. `proveBitcoinFact`-style inclusion proofs consume
   `bytes encodedTransaction` and a transaction Merkle proof; they are built on the
   transactions trie, not on receipts.

## Workaround we used

A transparent WebSocket JSON-RPC proxy between the Attestcoin components and exSat that
relays every message verbatim except that, for blocks that actually contain transactions,
it fills the zeroed `receiptsRoot` with the root computed from that block's own real
receipts (fetched from the same upstream node). Empty blocks are left untouched, so
previously-working behaviour is unchanged. Block hash, parent hash, transactions,
`transactionsRoot`, receipts and logs all pass through unmodified.

With `eth_rpc_url` pointed at that proxy in both `attestor-config.yaml` and
`proofgen-config.yaml`, the attestor cleared the wall immediately and has tracked the
chain head since, and the proof API returns proofs that verify on Creditcoin through the
BlockProver precompile.

Happy to share the proxy source if it is useful as a reproduction harness.
