# Changelog

## 2026-08-25 (2)
### Added
- `contracts/native`: v1 native relay contract (`btcwitness`, Antelope C++/CDT). Reads a Bitcoin
  UTXO fact (txid, vout index, value) directly from exSat's `utxomng.xsat` table and relays it
  into an EVM transaction via exSat's `evm_runtime.call()` action.
- `contracts/evm/BitcoinWitnessReceiver.sol`: v1 EVM receiver contract. Decodes the relayed fact
  and emits `BitcoinUtxoAttested(bytes32 txid, uint32 index, uint64 value, address relayer)` —
  the event Attestcoin will attest and Creditcoin will verify.
- `docs/ARCHITECTURE.md`: documented v1 scope (proves UTXO existence + value; scriptpubkey/address
  and block-header facts are v2) and a components status table.

### Not yet done
- Contracts are written but not built or deployed.
- No Attestcoin attestor / Creditcoin devnet yet — next milestone.

## 2026-08-25
### Added
- Project scaffolded: repository structure, architecture doc, license.
- Architecture defined: native relay contract (exSat native layer) → EVM receiver contract (exSat
  EVM) → Attestcoin attestation → Creditcoin verification.
