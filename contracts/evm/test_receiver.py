"""
Round-trip test for BitcoinWitnessReceiver.sol.

Verifies two things end to end, against a REAL compiled contract deployed to
a real (local) EVM — not just a code read-through:

1. The calldata layout our native contract (`contracts/native`) builds by
   hand (selector + txid + index + value, all Solidity-ABI-correct) is
   byte-for-byte identical to what web3.py's own official ABI encoder
   produces for `receiveUtxoFact(bytes32,uint32,uint64)`.
2. Sending that exact calldata to a deployed BitcoinWitnessReceiver emits
   `BitcoinUtxoAttested` with the same values we put in.

This does not touch exSat or Bitcoin — it only proves our own two contracts
(native encoder logic, mirrored in Python here, and the Solidity receiver)
agree with each other. It's the piece of the pipeline we can verify without
depending on exSat's (currently dead) testnet.

Run: pip install web3 eth-tester py-evm py-solc-x --break-system-packages
     python3 contracts/evm/test_receiver.py
"""
import hashlib
import json

import solcx
from eth_tester import EthereumTester
from web3 import Web3
from web3.providers.eth_tester import EthereumTesterProvider

RECEIVER_SOL_PATH = "contracts/evm/BitcoinWitnessReceiver.sol"
SELECTOR = bytes.fromhex("67b449eb")  # keccak256("receiveUtxoFact(bytes32,uint32,uint64)")[:4]


def build_calldata_like_native_contract(txid: bytes, index: int, value: int) -> bytes:
    """Mirrors bitcoinwitness::btc_witness::encode_calldata() in
    contracts/native/src/btcwitness.cpp byte for byte."""
    assert len(txid) == 32
    return SELECTOR + txid + index.to_bytes(32, "big") + value.to_bytes(32, "big")


def main():
    solcx.set_solc_version("0.8.24")
    with open(RECEIVER_SOL_PATH) as f:
        source = f.read()
    compiled = solcx.compile_source(source, output_values=["abi", "bin"])
    key = [k for k in compiled if "BitcoinWitnessReceiver" in k][0]
    abi, bytecode = compiled[key]["abi"], compiled[key]["bin"]

    w3 = Web3(EthereumTesterProvider(EthereumTester()))
    acct = w3.eth.accounts[0]

    Contract = w3.eth.contract(abi=abi, bytecode=bytecode)
    deploy_tx = Contract.constructor().transact({"from": acct})
    addr = w3.eth.get_transaction_receipt(deploy_tx)["contractAddress"]
    contract = w3.eth.contract(address=addr, abi=abi)

    txid = hashlib.sha256(b"example bitcoin txid for round-trip test").digest()
    index, value = 1, 1797928002

    ours = build_calldata_like_native_contract(txid, index, value)
    official = bytes.fromhex(contract.encode_abi("receiveUtxoFact", args=[txid, index, value])[2:])
    assert ours == official, "native-style calldata diverged from Solidity ABI encoding!"
    print("PASS: native-contract calldata layout matches web3.py's ABI encoder, byte for byte")

    tx = w3.eth.send_transaction({"from": acct, "to": addr, "data": "0x" + ours.hex()})
    receipt = w3.eth.get_transaction_receipt(tx)
    assert receipt["status"] == 1

    [log] = contract.events.BitcoinUtxoAttested().process_receipt(receipt)
    assert log["args"]["txid"] == txid
    assert log["args"]["index"] == index
    assert log["args"]["value"] == value
    print("PASS: BitcoinUtxoAttested emitted with exact txid/index/value")


if __name__ == "__main__":
    main()
