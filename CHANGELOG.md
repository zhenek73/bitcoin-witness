# Changelog

## 2026-08-25 (3)
### Added
- `contracts/evm/test_receiver.py`: automated round-trip test. Verifies the calldata layout our
  native contract builds by hand is byte-for-byte identical to web3.py's own ABI encoder for
  `receiveUtxoFact(bytes32,uint32,uint64)`, and that sending it to a real deployed instance of
  `BitcoinWitnessReceiver` emits `BitcoinUtxoAttested` with the exact values. Passes.
- `contracts/asc/BitcoinFactVerifier.sol`: v1 Creditcoin-side verification contract. Interfaces
  Creditcoin's BlockProver precompile (address confirmed two ways — official docs and the actual
  `gluwa/creditcoin3` runtime source, `AddressU64<4050>`), calls `verifyAndEmit`, and records the
  proven Bitcoin fact. Compiles. Proof→fact decoding is an explicit TODO (see NatSpec in the file)
  pending confirmation of the exact `encodedTransaction` format against a real attested tx.
- Noted exSat's current infrastructure status in `docs/ARCHITECTURE.md` (testnet unreachable,
  public self-hosting fallback) — doesn't change the architecture, only where it's deployed.

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
