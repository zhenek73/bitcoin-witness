"""
Tests for BitcoinFactVerifier's payload decoding — the part of the Creditcoin
side that turns an attested exSat transaction into a Bitcoin fact.

The payloads here are built to match Attestcoin's V1 encoding exactly:
    abi.encode(uint8 txType, bytes[] chunks)
      chunks[0]  = (nonce, gasLimit, from, toIsNull, to, value, data)
      chunks[-1] = (status, gasUsed, logs, logsBloom)
(verified against Gluwa's own encoder, cc-next-query-builder encoding/abi/v1.js)

These tests cover our decoding and authentication logic. They deliberately do
not exercise the BlockProver precompile itself — that runs only on a real
Creditcoin node, and mocking it would test the mock, not Attestcoin. What the
precompile guarantees (that the payload genuinely occurred at that height) is
assumed here; what we must get right ourselves is everything after that.

Run: python3 contracts/asc/test_verifier.py
"""
import hashlib

import solcx
from eth_abi import encode as abi_encode
from eth_tester import EthereumTester
from web3 import Web3
from web3.providers.eth_tester import EthereumTesterProvider

CHAIN_KEY = 42
EVENT_SIG = bytes.fromhex("8ada6206a51055064d662d325820d3282b8bff502d55098f7182a1d8a64187fe")
TXID = hashlib.sha256(b"bitcoin txid under test").digest()
INDEX = 7
VALUE = 1797928002


def build_payload(
    to: str,
    log_addr: str,
    topics=None,
    status: int = 1,
    index: int = INDEX,
    value: int = VALUE,
    extra_logs=(),
    tx_type: int = 2,
):
    """Builds an Attestcoin V1 payload the way Gluwa's encoder does."""
    if topics is None:
        topics = [EVENT_SIG, TXID, bytes(32)]

    common = abi_encode(
        ["uint64", "uint64", "address", "bool", "address", "uint256", "bytes"],
        [1, 100000, to, False, to, 0, b""],
    )
    type_specific = abi_encode(["uint64", "uint128"], [840000, 1])

    logs = list(extra_logs) + [(log_addr, topics, abi_encode(["uint32", "uint64"], [index, value]))]
    receipt = abi_encode(
        ["uint8", "uint64", "(address,bytes32[],bytes)[]", "bytes"],
        [status, 21000, logs, b"\x00" * 8],
    )

    return abi_encode(["uint8", "bytes[]"], [tx_type, [common, type_specific, receipt]])


def expect_revert(fn, substring, label):
    try:
        fn()
    except Exception as e:
        assert substring in str(e), f"{label}: reverted, but not with '{substring}': {e}"
        print(f"  PASS (correctly rejected): {label}")
        return
    raise AssertionError(f"{label}: expected revert, but the call SUCCEEDED")


def main():
    solcx.set_solc_version("0.8.24")
    compiled = solcx.compile_standard(
        {
            "language": "Solidity",
            "sources": {
                "BitcoinFactVerifier.sol": {"content": open("contracts/asc/BitcoinFactVerifier.sol").read()},
                "ExtractFactHarness.sol": {"content": open("contracts/asc/ExtractFactHarness.sol").read()},
            },
            "settings": {"outputSelection": {"*": {"*": ["abi", "evm.bytecode.object"]}}},
        }
    )["contracts"]

    w3 = Web3(EthereumTesterProvider(EthereumTester()))
    acct = w3.eth.accounts[0]
    emitter = w3.eth.accounts[1]  # stands in for BitcoinWitnessReceiver on exSat
    impostor = w3.eth.accounts[2]

    c = compiled["ExtractFactHarness.sol"]["ExtractFactHarness"]
    Harness = w3.eth.contract(abi=c["abi"], bytecode=c["evm"]["bytecode"]["object"])
    tx = Harness.constructor(CHAIN_KEY, emitter).transact({"from": acct})
    addr = w3.eth.get_transaction_receipt(tx)["contractAddress"]
    harness = w3.eth.contract(address=addr, abi=c["abi"])

    call = lambda payload: harness.functions.extractFact(payload).call()

    # --- happy path ---
    txid, index, value = call(build_payload(to=emitter, log_addr=emitter))
    assert txid == TXID and index == INDEX and value == VALUE, (txid, index, value)
    print(f"  PASS (happy path): decoded {VALUE} sats for txid[{INDEX}] from a real V1 payload")

    # --- the event was emitted by some other contract ---
    expect_revert(
        lambda: call(build_payload(to=emitter, log_addr=impostor)),
        "no matching event",
        "event emitted by an impostor contract",
    )

    # --- transaction went somewhere other than our receiver ---
    expect_revert(
        lambda: call(build_payload(to=impostor, log_addr=emitter)),
        "wrong tx recipient",
        "transaction sent to a different contract",
    )

    # --- a different event from our own contract ---
    expect_revert(
        lambda: call(
            build_payload(to=emitter, log_addr=emitter, topics=[hashlib.sha256(b"Other").digest(), TXID, bytes(32)])
        ),
        "no matching event",
        "different event from our contract",
    )

    # --- source transaction reverted ---
    expect_revert(
        lambda: call(build_payload(to=emitter, log_addr=emitter, status=0)),
        "did not succeed",
        "source transaction reverted",
    )

    # --- an event with our signature but the wrong topic arity ---
    expect_revert(
        lambda: call(build_payload(to=emitter, log_addr=emitter, topics=[EVENT_SIG, TXID])),
        "no matching event",
        "our signature but wrong number of topics",
    )

    # --- our event sits behind unrelated logs from other contracts ---
    noise = (impostor, [hashlib.sha256(b"Noise").digest()], b"")
    txid2, index2, value2 = call(build_payload(to=emitter, log_addr=emitter, extra_logs=[noise, noise]))
    assert (txid2, index2, value2) == (TXID, INDEX, VALUE)
    print("  PASS (log scanning): found our event past unrelated logs")

    # --- a legacy (type 0) transaction still decodes: chunk positions hold ---
    txid3, _, value3 = call(build_payload(to=emitter, log_addr=emitter, tx_type=0))
    assert txid3 == TXID and value3 == VALUE
    print("  PASS (tx type independence): legacy type-0 payload decoded the same way")

    # --- boundary values survive the uint32/uint64 decode ---
    big_index, big_value = 2**32 - 1, 2**64 - 1
    _, i4, v4 = call(build_payload(to=emitter, log_addr=emitter, index=big_index, value=big_value))
    assert i4 == big_index and v4 == big_value, (i4, v4)
    print("  PASS (boundaries): max uint32 index and max uint64 value decoded intact")

    print("\nAll BitcoinFactVerifier decoding tests passed.")


if __name__ == "__main__":
    main()
