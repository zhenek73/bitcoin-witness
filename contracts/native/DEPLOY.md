# Deploying the native relay contract

The native side runs on **EOS mainnet** (that is where exSat's contracts live — see
`docs/ARCHITECTURE.md`). Standard Antelope deployment, with one easily-missed permission step.

## Build

```bash
./build.sh          # -> build/btcwitness.wasm (~11 KB), build/btcwitness.abi
```

## Cost

RAM is the only meaningful cost. At the spot price read from `eosio`'s `rammarket`
(~0.3409 EOS/KB at time of writing), an 11 KB contract is roughly **3.8 EOS**, plus a little for
the ABI and table rows. CPU/NET are staked, not spent.

## Deploy

```bash
cleos -u https://eos.greymass.com set contract <account> ./build btcwitness.wasm btcwitness.abi
```

## Required: `@eosio.code`

The contract sends an inline action to `evm.xsat` authorized as itself, which Antelope refuses
unless the account's `active` permission includes its own code:

```bash
cleos -u https://eos.greymass.com set account permission <account> active --add-code
```

Skipping this makes the first `relayutxo` call fail with `missing required authority` — which
reads like a contract bug but is a permissions gap.

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
