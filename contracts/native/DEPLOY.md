# Deploying the native relay contract

The native side runs on **EOS mainnet** (that is where exSat's contracts live — see
`docs/ARCHITECTURE.md`). Standard Antelope deployment, with two easily-missed steps: one
permission, one balance.

## Build

```bash
./build.sh          # -> build/btcwitness.wasm (~11 KB), build/btcwitness.abi
```

## Cost, in both currencies

The relay spends resources on **two** ledgers, and it is easy to budget only for the first.

| What | Where | Roughly |
|---|---|---|
| contract code (RAM) | EOS mainnet | ~11 KB × 0.34 EOS/KB ≈ **3.8 EOS**, one-off |
| CPU / NET | EOS mainnet | staked, not spent |
| **gas for the relayed EVM transaction** | **exSat EVM, in BTC** | ~50k gas × 500,000 wei ≈ **2.5 sats per relay** |

The last row is the one that gets missed. `evm.xsat`'s config reports
`token_contract: btc.xsat`, `gas_price: 500000` — gas on exSat EVM is denominated in **BTC**,
not EOS and not XSAT. The amount is trivial; the balance being non-zero is not optional.

## Deploy

```bash
cleos -u https://eos.greymass.com set contract <account> ./build btcwitness.wasm btcwitness.abi
```

## Required 1: `@eosio.code`

The contract sends an inline action to `evm.xsat` authorized as itself, which Antelope refuses
unless the account's `active` permission includes its own code:

```bash
cleos -u https://eos.greymass.com set account permission <account> active --add-code
```

Skipping this makes the first `relayutxo` call fail with `missing required authority` — which
reads like a contract bug but is a permissions gap.

## Required 2: fund the account's EVM address with BTC

`evm.xsat::call(from, ...)` runs the transaction as `from`'s **reserved EVM address** and
charges gas to that address's balance inside exSat EVM. The address is derived from the Antelope
account name — no registration step, it simply exists:

```
0xbbbbbbbb ‖ name_u64 (8 bytes, big-endian) ‖ 8 zero bytes
```

Do not hand-compute it — `btcwitness` and `btcwitness11` differ by two characters and give
different addresses, and a wrong one fails only much later, as every proof being rejected with
"no matching event". Use the script:

```bash
node ../../scripts/reserved-address.mjs btcwitness11
# 0xBbbBbBBb3E51C7666aC602100000000000000000
```

For the account this project deploys to, `btcwitness11`, that is:

```
0xBbbBbBBb3E51C7666aC602100000000000000000
```

Send BTC into exSat EVM by transferring from `btc.xsat` to `evm.xsat` with that address in the
memo. With a zero balance the EVM transaction fails on insufficient funds — and it fails on the
EVM side, so the Antelope transaction can still look successful while no event is ever emitted.
That failure mode is why this is a checklist item and not a footnote.

> **Who pays, longer term.** Having the relay account carry the gas is fine for a demo but wrong
> as a product: the party who wants the fact proven should pay for it. The natural v2 is a
> deposit-and-charge table on `btcwitness` (caller tops up, `relayutxo` debits their balance),
> or accepting an EOS transfer whose `memo` carries the UTXO to relay. Both keep the contract
> permissionless while moving the cost to whoever benefits.

## Deploying the two EVM-side contracts

Constructor arguments matter and are easy to get subtly wrong:

```
BitcoinWitnessReceiver(relayer)            # relayer = btcwitness's reserved address, above
BitcoinFactVerifier(chainKey, emitter, relayer)
                     │         │          └─ same reserved address
                     │         └──────────── the deployed BitcoinWitnessReceiver on exSat EVM
                     └────────────────────── chain_key from register_chain (7 on our devnet),
                                             NOT the EVM chainId 7200
```

The `relayer` argument to `BitcoinFactVerifier` is what makes a proven fact mean anything —
without it, anyone can call `receiveUtxoFact` directly and have invented numbers proven as real
Bitcoin. Do not deploy with a placeholder.

## Sanity check before relaying

The contract looks up UTXOs through `utxomng.xsat`'s `byutxoid` secondary index, whose key is
`sha256(txid_bytes || index_le32)`. You can confirm a given UTXO is present before spending gas
on it:

```bash
# utxo_id = sha256(bytes.fromhex(txid) + index.to_bytes(4, 'little'))
curl -X POST https://eos.greymass.com/v1/chain/get_table_rows -d '{
  "json": true, "code": "utxomng.xsat", "scope": "utxomng.xsat", "table": "utxos",
  "index_position": 3, "key_type": "sha256",
  "lower_bound": "<utxo_id>", "upper_bound": "<utxo_id>", "limit": 1
}'
```

`index_position` 3 is `byutxoid`; 2 is `scriptpubkey`. This exact query was used to verify the
contract's key derivation against live chain data.
