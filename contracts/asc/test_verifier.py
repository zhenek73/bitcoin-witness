"""
Tests for BitcoinFactVerifier — the Creditcoin-side contract that turns a
proven Attestcoin query into a recorded Bitcoin fact.

Uses MockAttestcoinProver to feed result segments directly, so these tests
exercise OUR authentication logic (source chain, emitter, event signature,
receipt status, replay guard) without needing a live Creditcoin node. They
prove the consumer contract is correct; they do not test Attestcoin itself.

Negative paths matter more than the happy path here: a verifier that accepts
the happy case but also accepts a forged emitter is worse than useless.

Run: python3 contracts/asc/test_verifier.py
"""
import hashlib

import solcx
from eth_tester import EthereumTester
from web3 import Web3
from web3.providers.eth_tester import EthereumTesterProvider

CHAIN_KEY = 42  # Attestcoin chain_key our exSat devnet is registered under (test value)
EVENT_SIG = bytes.fromhex("8ada6206a51055064d662d325820d3282b8bff502d55098f7182a1d8a64187fe")
TXID = hashlib.sha256(b"bitcoin txid under test").digest()
INDEX = 7
VALUE = 1797928002


def word(value) -> bytes:
    if isinstance(value, bytes):
        assert len(value) == 32
        return value
    if isinstance(value, str):  # address
        return bytes(12) + bytes.fromhex(value[2:])
    return value.to_bytes(32, "big")


def compile_all():
    solcx.set_solc_version("0.8.24")
    sources = {
        "BitcoinFactVerifier.sol": {"content": open("contracts/asc/BitcoinFactVerifier.sol").read()},
        "MockAttestcoinProver.sol": {"content": open("contracts/asc/MockAttestcoinProver.sol").read()},
    }
    # the mock imports "./BitcoinFactVerifier.sol"
    out = solcx.compile_standard(
        {
            "language": "Solidity",
            "sources": sources,
            "settings": {"outputSelection": {"*": {"*": ["abi", "evm.bytecode.object"]}}},
        }
    )
    return out["contracts"]


def deploy(w3, acct, compiled, filename, name, args=()):
    c = compiled[filename][name]
    Contract = w3.eth.contract(abi=c["abi"], bytecode=c["evm"]["bytecode"]["object"])
    tx = Contract.constructor(*args).transact({"from": acct})
    addr = w3.eth.get_transaction_receipt(tx)["contractAddress"]
    return w3.eth.contract(address=addr, abi=c["abi"])


def expect_revert(fn, expect_substring, label):
    try:
        fn()
    except Exception as e:
        assert expect_substring in str(e), f"{label}: reverted, but not with '{expect_substring}': {e}"
        print(f"  PASS (correctly rejected): {label}")
        return
    raise AssertionError(f"{label}: expected revert, but the call SUCCEEDED")


def main():
    compiled = compile_all()
    w3 = Web3(EthereumTesterProvider(EthereumTester()))
    acct = w3.eth.accounts[0]

    mock = deploy(w3, acct, compiled, "MockAttestcoinProver.sol", "MockAttestcoinProver")
    emitter = w3.eth.accounts[1]  # stands in for BitcoinWitnessReceiver's address on exSat
    impostor = w3.eth.accounts[2]

    verifier = deploy(
        w3, acct, compiled, "BitcoinFactVerifier.sol", "BitcoinFactVerifier", (mock.address, CHAIN_KEY, emitter)
    )

    def segments(rx_status=1, tx_to=None, ev_addr=None, ev_sig=EVENT_SIG, txid=TXID, index=INDEX, value=VALUE):
        return [
            word(rx_status),
            word(tx_to or emitter),
            word(ev_addr or emitter),
            word(ev_sig),
            word(txid),
            word(index),
            word(value),
        ]

    def set_query(qid: bytes, words, chain_id=CHAIN_KEY, height=840000):
        mock.functions.setQueryDetails(qid, 1, chain_id, height, 0, words).transact({"from": acct})

    def record(qid: bytes):
        return verifier.functions.recordProvenFact(qid).transact({"from": acct})

    # --- happy path ---
    qid = hashlib.sha256(b"query-1").digest()
    set_query(qid, segments())
    record(qid)
    value, proven = verifier.functions.getProvenValue(TXID, INDEX).call()
    assert proven and value == VALUE, (value, proven)
    print(f"  PASS (happy path): recorded {VALUE} sats for txid[{INDEX}]")

    # --- replay of the same query must fail ---
    expect_revert(lambda: record(qid), "query already used", "same queryId replayed")

    # --- forged emitter: right event, wrong contract emitted it ---
    q2 = hashlib.sha256(b"query-2").digest()
    set_query(q2, segments(ev_addr=impostor))
    expect_revert(lambda: record(q2), "wrong event emitter", "event emitted by an impostor contract")

    # --- right emitter, but transaction was sent somewhere else ---
    q3 = hashlib.sha256(b"query-3").digest()
    set_query(q3, segments(tx_to=impostor))
    expect_revert(lambda: record(q3), "wrong tx recipient", "transaction sent to a different contract")

    # --- our contract address, but on an unregistered/other chain ---
    q4 = hashlib.sha256(b"query-4").digest()
    set_query(q4, segments(), chain_id=CHAIN_KEY + 1)
    expect_revert(lambda: record(q4), "wrong source chain", "same address but different source chain")

    # --- a different event from the same contract ---
    q5 = hashlib.sha256(b"query-5").digest()
    set_query(q5, segments(ev_sig=hashlib.sha256(b"SomeOtherEvent").digest()))
    expect_revert(lambda: record(q5), "wrong event signature", "different event from our contract")

    # --- source transaction reverted ---
    q6 = hashlib.sha256(b"query-6").digest()
    set_query(q6, segments(rx_status=0))
    expect_revert(lambda: record(q6), "did not succeed", "source transaction reverted")

    # --- query not finished proving (no result segments) ---
    q7 = hashlib.sha256(b"query-7").digest()
    set_query(q7, [])
    expect_revert(lambda: record(q7), "unexpected segment layout", "query with no results yet")

    # --- a second, distinct fact still records fine after all the rejections ---
    q8 = hashlib.sha256(b"query-8").digest()
    other_txid = hashlib.sha256(b"another bitcoin txid").digest()
    set_query(q8, segments(txid=other_txid, index=0, value=5000))
    record(q8)
    v, p = verifier.functions.getProvenValue(other_txid, 0).call()
    assert p and v == 5000
    print("  PASS (still works after rejections): second distinct fact recorded")

    print("\nAll BitcoinFactVerifier tests passed.")


if __name__ == "__main__":
    main()
