# Bitcoin Witness — pitch

**Proving Bitcoin without moving Bitcoin.**
BUIDL CTC 2026 Fall · exSat + Attestcoin + Creditcoin

---

## 1. The problem, in one paragraph

Every wrapped Bitcoin carries exactly one promise: **the supply on this chain never exceeds
the BTC held in reserve.**

Let us be precise about the state of the art, because the lazy version of this pitch is
wrong. That promise *is* monitored today. Chainlink publishes a WBTC proof-of-reserve feed,
and its Secure Mint pattern already gates minting on it. The problem is not that nobody
looks.

**The problem is what the contract is actually looking at.** A reserve feed is an
*assertion*. A committee of oracle nodes reads a Bitcoin node off chain, agrees on a number,
signs it, and posts it. The consuming contract cannot check that number against anything — it
can only trust the signers, and trust the address list those signers were pointed at. The
reserve is reported to the chain, never proven to it.

That was not laziness on anyone's part. **Bitcoin state has never been natively readable by a
Creditcoin contract.** Other approaches to the general problem — BTC Relay, SPV light clients,
threshold-signature designs like tBTC — each make their own trade-off in gas, liveness or
signer sets. Bitcoin Witness takes a different route: it uses exSat's already-indexed Bitcoin
state and makes one specific fact verifiable inside a Creditcoin contract.

Bitcoin Witness changes what arrives. The reserve reaches Creditcoin as a fact derived from
Bitcoin's own proof-of-work-verified UTXO set, carried by an Attestcoin attestation over a
real exSat block, and checked on chain by the BlockProver precompile. The contract verifies
evidence instead of trusting a reporter — and then refuses to mint against reserves that are
not there. An unbacked mint is not flagged afterwards. It reverts.

## 2. The insight

exSat already maintains a complete, native, on-chain index of the Bitcoin UTXO set —
166 million UTXOs, currently at Bitcoin height 959,115, kept current by real mining pools
submitting real blocks with real proof-of-work. It is one of the most under-used pieces of
infrastructure in crypto: a Bitcoin state machine that smart contracts can read.

Except they can't, quite. That index lives on exSat's *native* (Antelope) layer. Solidity
contracts live on exSat's *EVM* layer. exSat's own documentation says the EVM layer *"will
in the near future"* be able to read that data. Today it cannot. And a contract on another
chain has no way to reach those tables either — not because they are secret, but because
reading is not verifying. Anyone can query them over a public EOS RPC; what no smart contract
elsewhere can do is check their contents as part of its own execution. **RPC-readable is not
the same thing as contract-verifiable, and that gap is the whole problem.**

**Bitcoin Witness builds that missing link — and then carries it one chain further, to
Creditcoin.**

## 3. What we built

```
Bitcoin ──► exSat native index ──► exSat EVM ──► Attestcoin ──► Creditcoin ──► ReserveGuard
            (utxomng.xsat)        (event)       (attestation)  (proven fact)  (mint reverts)
```

Five pieces, all deployed and all running:

1. **`btcwitness11`** — an Antelope C++ contract, live on **EOS mainnet**, that reads a Bitcoin
   UTXO straight out of exSat's `utxomng.xsat` table and relays it into exSat's EVM through an
   inline action to `evm.xsat`. Not a bridge, not a message — a table read and a function call,
   inside one chain.

2. **`BitcoinWitnessReceiver`** — a Solidity contract live on **exSat EVM mainnet** (chain 7200)
   at `0xBF823785C5749532AE927d7285093Eae279fe16C`, which turns the relayed fact into a standard
   EVM event. It has emitted **12 real `BitcoinUtxoAttested` events**, all publicly checkable.

3. **A live Attestcoin attestor watching exSat.** exSat was not a registered Attestcoin source
   chain — so we ran our own Creditcoin node, registered it (`chain_key 7`), bootstrapped an
   attestor, and it now attests real exSat mainnet blocks continuously.

4. **`BitcoinFactVerifier`** — a Creditcoin contract at `0xc01Ee7f10EA4aF4673cFff62710E1D7792aBa8f3`
   that proves the attested payload through the BlockProver precompile, then authenticates the fact
   *from inside the attested bytes*: right recipient, right emitting contract, right event
   signature, right relayer, successful receipt. A caller chooses only *which* proven transaction
   to submit — never what it says. 9 tests, 5 of them negative paths.

5. **`ReserveGuard` + `GuardedWBTC`** — the part that turns a proven fact into a safety
   property. `ReserveGuard` sums the proven, still-fresh value of the outpoints an issuer has
   declared as reserve, and `GuardedWBTC.mint` consults it before creating a single token.
   One external view call stands between an attacker and unbacked supply.

**Five different Bitcoin UTXOs have gone the whole way and read back `proven = true` on
Creditcoin.** Five, not one — this is reproducible, not a lucky run.

### The one line that matters

```solidity
function mint(address to, uint256 amount) external onlyIssuer {
    guard.checkMint(amount);   // reverts unless supply stays within proven Bitcoin reserves
    _mint(to, amount);
}
```

`scripts/demo_solvency.mjs` runs this against the live devnet, in five beats, all on chain:

| # | | Result |
|---|---|---|
| 1 | issuer declares its five proven Bitcoin outpoints as reserve | 250 BTC counted |
| 2 | backed mint of 50 gwBTC | **succeeds** |
| 3 | attacker mints 250,000 gwBTC | **reverts** — `Insolvent(250050, 250, 0)` |
| 4 | *same attack on an unguarded token* | **succeeds** — 249,750 unbacked, no error |
| 5 | reserve proof allowed to age out | even **1 satoshi reverts** |

Beat 4 is the control case, deployed on purpose. It is what a mint path looks like with no
reserve constraint it can verify: a valid transaction by every rule the chain knows, because
the chain does not know what the reserve is.

Beat 5 is the property that makes this safe to rely on. Proofs have latency, so the number is
always the reserve as of some minutes ago — and a deposit not yet proven is simply **not
counted**. Lag makes the guard stricter, never more permissive. It fails closed by
construction.

We can make a stronger claim than "it ran once", because we were forced to prove it. A machine
restart wiped the devnet chain — the node had been running without persistent storage, so the
registered source chain, the elected attestor and the deployed verifier all vanished at once.
Rebuilding from genesis took one command and about ten minutes, and the pipeline proved a fresh
UTXO again on the new chain. The stand is now reproducible from scratch by design, not by luck:
`devnet/bootstrap-devnet.mjs`.

## 4. What we found on the way

exSat's EVM layer serves **`receiptsRoot` and `stateRoot` as 32 zero bytes in every block header**
— not one bad RPC node, but structurally, on every block. Gluwa's Attestcoin attestor recomputes
those roots from the block's own data and compares them to the header. For an empty block the
comparison happens to pass; on the **first block containing a transaction** the computed root is a
real hash that can never equal a permanent zero, so the attestor rejects the block as a "possible
reorg", retries forever, and never advances again. exSat simply cannot be attested by stock
Attestcoin — and the error message points at the wrong cause entirely.

We diagnosed it, proved which parts of the chain are and aren't sound, and got past it:

- exSat's **`transactionsRoot` is genuine and canonical** — we recomputed the Merkle-Patricia root
  from each block's own transactions and matched the header byte for byte. That is the field
  inclusion proofs are actually built on.
- The block hash is `keccak(rlp(header))` **including** those zeros, so exSat's headers are
  internally self-consistent and its hash chain is sound.
- In Gluwa's own source, `receipts_root` appears in exactly one place — that comparison. The
  attested digest is `hash(block_number, merkle_root, prev_digest)`; **the receipts root enters no
  attestation and no proof.**

So we run a transparent WS proxy that fills in that one always-zero field from the block's own real
receipts and relays everything else byte for byte. Nothing that a proof rests on is touched, and
nothing is fabricated — the substituted value is derived from the chain's own data.

The clean upstream fix is smaller still: Attestcoin **already** skips exactly this check for
pre-Byzantium Ethereum mainnet, for exactly this class of reason, with a comment noting that the
transaction-root check still guards against reorgs. exSat needs the same exemption.

Both defects are written up in [`docs/`](docs/) and **filed upstream against Gluwa's repository**:

- [gluwa/creditcoin3#1355](https://github.com/gluwa/creditcoin3/issues/1355) — the attestor cannot
  follow any chain without a receipts trie, and reports it as a reorg that never happened.
- [gluwa/creditcoin3#1356](https://github.com/gluwa/creditcoin3/pull/1356) — a merged-ready patch
  for the second defect: `register_bls` logs "already registered" for an account that is not
  registered at all, which sends operators looking in exactly the wrong place.

## 5. What we are honest about

Most hackathon projects say "trustless" and stop. Here is the actual trust model:

- We do **not** run SPV or validate Bitcoin headers ourselves. We inherit exSat's Bitcoin
  consensus — miners' PoW plus exSat's synchronizer/validator set — which is exactly the
  assumption exSat's own users already make.
- Below that sits **EOS mainnet finality**: `utxomng.xsat` and `evm.xsat` are ordinary accounts
  on EOS mainnet (chain id `aca376f2…e906`), so the index is as live as EOS is, independent of
  exSat's corporate roadmap.
- Above it sits **Attestcoin's quorum** over exSat EVM blocks.
- exSat's Bitcoin index is currently **frozen at Bitcoin height 959,115** (22 July) — its
  block-endorsement consensus has stalled. We found this ourselves and did not paper over it:
  every proven fact carries its `sourceHeight` on-chain, and `demo.ts` prints how far behind
  Bitcoin's tip that is. An oracle that shows the age of its data is more honest than one that
  pretends it is always fresh.

What we removed is not *all* trust. It is **discretionary** trust — the party who could simply
choose to report a different number. Every remaining assumption is a public, adversarial,
economically-secured consensus that anyone can check.

We are careful about how that compares to an oracle reserve feed, because the difference is
real but it is not "trust versus no trust". Both designs end in a quorum. The difference is
what the quorum is asked to do: an oracle committee is asked to *assert a balance it read off
chain*, and the contract has no way to disagree; Attestcoin's quorum is asked to attest a
**block header**, and the contract then verifies, itself, that the fact was inside that block
and that the block belongs to the chain. Corrupting the first produces a wrong number nobody
can detect from on chain. Corrupting the second means forging exSat's history — which also
means forging the Bitcoin data exSat's validators endorsed under proof of work.

We also scoped v1 down on purpose: it proves *"UTXO (txid, index) exists and holds N sats."*
Not the script, not the address, not spend history. One fact, all the way through, verifiable
by a judge in real time — instead of five facts half-wired.

And the guard has three limits we would rather state than have someone find:

- **It stops inflation, not theft.** An attacker who drains already-backed tokens out of a
  pool leaves supply and reserves both unchanged; the invariant holds and the guard will not
  object. The claim is "you cannot print what is not there" — never "funds cannot be stolen".
- **The issuer declares which outpoints are its reserve.** A lying issuer is still a lying
  issuer. What changes is that the lie becomes a single public, permanent, checkable statement
  instead of a recurring private assertion — and because outpoints are globally unique, two
  issuers claiming the same reserve is detectable by anyone.
- **A proven UTXO can be spent the next block.** That is what the freshness window is for, and
  why it fails closed: a fact past its window stops counting toward reserves entirely.

Proving a UTXO exists is *not* a liquidatable collateral claim, and we do not pitch it as one.
Seizing Bitcoin on default needs a lock on the Bitcoin side — multisig, timelock, DLC,
covenant. Bitcoin Witness is the proof layer such a lock would report through; it is not the
lock. We would rather ship a narrow claim that holds than a broad one that does not.

## 6. Why this matters beyond the demo

Once a Creditcoin contract can read a Bitcoin fact, the things built on top are not exotic:

- **Solvency as a transaction precondition.** Any issuer of a Bitcoin-backed token can adopt
  `ReserveGuard` as-is. The exploit class that cost the industry billions — mint more than is
  locked, exit in the same block — stops being profitable, because the mint does not execute.
- **Proof of reserves that is actually a proof.** Not a number a committee signed after
  reading a node, but one the reading contract verifies for itself, at outpoint granularity,
  in the same transaction it acts on.
- **Proof of payment.** A payment is an event, not a balance, so a point-in-time proof is
  exactly the right instrument for it — "this borrower sent 0.4 BTC to this address at height
  N", recorded by Creditcoin as loan repayment. That is Creditcoin's own product: a credit
  history made of real settlements rather than self-reported ones.
- **Creditworthiness without seizure.** "This address has controlled 2 BTC for three years" is
  a strong underwriting signal for undercollateralized credit — which is Creditcoin's thesis —
  and it needs no ability to take the Bitcoin at all.
- **A general Bitcoin-fact oracle.** Block headers, spends, script conditions — same pipe,
  richer payloads. The hard part was the pipe.

## 7. Why us

The pipeline crosses three runtimes that almost nobody writes in at once: Antelope C++, Solidity,
and Substrate. Our native side is not a first attempt — we ship production Antelope contracts on
EOS mainnet already. That is why the unglamorous half of this project (RAM economics, inline-action
permissions, `@eosio.code`, secondary-index key derivation) is done and correct rather than
hand-waved. It is also why, when the pipeline broke in three genuinely obscure places — a
cross-contract secondary index addressed by declaration order, two separate `evm.xsat` balance
ledgers, and a reserved-address layout that differs from its own documentation — each one was
root-caused against live chain data rather than guessed at.

## 8. Status

| Piece | State |
|---|---|
| Native relay contract | **deployed, EOS mainnet** (`btcwitness11`), 12 real relays |
| EVM receiver | **deployed, exSat EVM mainnet**, 12 `BitcoinUtxoAttested` events |
| Creditcoin devnet + exSat registered | **working** (`chain_key 7`), rebuildable in one command |
| Attestor against exSat mainnet | **working** — attesting live exSat blocks |
| Creditcoin verifier | **deployed**, 9 tests incl. 5 negative paths |
| `ReserveGuard` + `GuardedWBTC` + control | **deployed**, 5-beat solvency demo passing |
| Live end-to-end run | **done — 5 UTXOs proven**, transcript in repo |

Everything above was verified against running software and live chain queries, not inferred from
source.

---

*Demo, part one — prove a Bitcoin fact:
`npx tsx scripts/demo.ts --txid <btc_txid> --index <vout>` — prints every hop, with an
explorer link for each, so you can check the claim rather than take it.*

*Demo, part two — put that fact to work:
`node scripts/demo_solvency.mjs` — declares the proven UTXO as reserve, mints against it,
then watches an unbacked mint revert on chain while the unguarded control mints it happily.*
