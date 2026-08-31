# UI concept — "The Witness Trail"

## The design problem

This project is plumbing. Nothing it does is visible: a table read, an inline action, a log,
an attestation, a storage write. A judge watching a terminal sees text scroll and has to take
our word for all of it.

So the interface has exactly one job, and it is not "look impressive":

> **Make an unfalsifiable-looking claim falsifiable in ninety seconds.**

Every design decision below serves that. The winning reaction is not "nice UI" — it is a judge
clicking one of our links, landing on a third-party explorer we don't control, and seeing the
same number.

Corollary: **we never render a value we cannot source.** Every number on screen carries the
endpoint it came from. No spinners hiding fake progress, no pre-recorded happy path.

---

## Surface 1 — The Trail (the hero screen)

A single vertical track, five stations, one Bitcoin fact travelling down it in real time.

```
┌──────────────────────────────────────────────────────────────────┐
│  BITCOIN WITNESS                          exSat ▸ Attestcoin ▸ CC │
│                                                                  │
│  txid  4a5e1e4b…3ac0   vout 0        [ Prove this UTXO ]         │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ①  BITCOIN                                          ✓ 0.4 s     │
│  │   indexed to height 959,115 · 166,186,512 UTXOs               │
│  │   value 5,000,000,000 sats (50.0 BTC)                         │
│  │   utxo_id 9f2c…a71b   ↗ verify on eos.greymass.com            │
│  ●                                                               │
│  ②  exSAT NATIVE  (EOS mainnet)                      ✓ 1.2 s     │
│  │   btcwitness::relayutxo → inline action → evm.xsat            │
│  │   antelope tx 8d3f…c105     ↗ verify on bloks.io              │
│  ●                                                               │
│  ③  exSAT EVM  (chain 7200)                          ✓ 3.1 s     │
│  │   BitcoinUtxoAttested emitted · block 59,225,940              │
│  │   topics[1] = txid   topics[2] = relayer 0xbbbbbbbb3e51…      │
│  │   evm tx 0x71ba…9e0d        ↗ verify on scan.exsat.network    │
│  ●                                                               │
│  ④  ATTESTCOIN                                    ⣾ waiting…     │
│  │   quorum 1/1 · digest 0x9768a07f…                             │
│  │   header hash matches exSat RPC  ✓                            │
│  ●                                                               │
│  ⑤  CREDITCOIN                                        · pending  │
│      BitcoinFactProven(txid, 0, 5000000000, 59225940)            │
│      ↗ verify on the Creditcoin explorer                         │
└──────────────────────────────────────────────────────────────────┘
```

### Station anatomy

Every station is the same component, so the eye learns it once:

| slot | content | why |
|---|---|---|
| number + name | which chain/runtime we're in | the whole point is that these are *different worlds* |
| status | `pending` → `running` → `✓ 1.2 s` → `✗ reason` | elapsed time is the honest progress bar |
| payload | 2–3 lines of the *actual* data at this hop | not a description of what happens — what happened |
| hash | the real tx/digest, monospace, truncated middle | copyable in full on click |
| **verify link** | third-party explorer, opens in a new tab | the load-bearing element of the entire UI |

### The connectors matter more than the boxes

Between stations, the connector line is labelled with **what kind of hop it is** — because the
central technical claim of this project is that these hops are not what people assume:

- ① → ② `multi_index read · same chain · no permission needed`
- ② → ③ `inline action · same chain · not a bridge`
- ③ → ④ `attestation · BLS quorum`
- ④ → ⑤ `BlockProver precompile · on-chain verification`

A dot travels the connector while the hop is in flight. That is the only animation in the
product, and it exists because it encodes information (which hop is slow) rather than decoration.

### States that must be designed, not improvised

- **UTXO not found** — the honest and *common* case (spent, or above indexed height). Station ①
  shows `not in the set at height 959,115` and offers "try a known-good UTXO". Never a generic
  error toast. This is a feature: it demonstrates that we read real state and cannot invent it.
- **Attestation lag** — station ④ sits in `waiting` for as long as it takes, showing
  `attested height 59,225,912 · need 59,225,940 · ~4 blocks behind`. Waiting with a number is
  credible; a spinner is not.
- **Relayer mismatch** — station ⑤ fails with `rejected: relayer is not btcwitness`. See Surface 3.

---

## Surface 2 — The Ledger (why anyone would use this)

The Trail proves the mechanism. The Ledger shows the product.

A proof-of-reserves view: paste a set of UTXO ids (an exchange's published reserve list), and get
one page that a reader can act on.

```
RESERVE ATTESTATION · 4 of 6 UTXOs proven on Creditcoin

  ████████████░░░░   1,842.50 BTC proven      of   2,150.00 BTC claimed

  txid 4a5e…3ac0:0    50.00 BTC   proven at exSat block 59,225,940   4 min ago
  txid 9c31…f0a2:1   792.50 BTC   proven at exSat block 59,225,901  22 min ago
  txid 71b0…9e0d:0  1000.00 BTC   proven at exSat block 59,225,880  41 min ago
  txid 0cda…16c8:2      —         not proven — never submitted
  txid e2f8…f652:0      —         not proven — UTXO not in exSat's set
```

Two deliberate choices here:

- **"Proven at block N, T ago" is shown on every row.** A proof is a statement about a past
  height, not a live balance — the UTXO could have been spent since. Showing freshness is what
  separates an honest tool from the PDF-attestation theatre we are criticising.
- **Unproven rows stay visible, with the reason.** A dashboard that only shows successes is the
  same genre of lie as a custodian's report. The gap between "claimed" and "proven" is the
  product.

---

## Surface 3 — The Forgery Test (the strongest 20 seconds of the demo)

A small panel with one button: **"Try to prove a fake UTXO."**

It genuinely runs: submits a fabricated fact into `BitcoinWitnessReceiver` from an ordinary EOA,
waits for it to be attested (it will be — the transaction is real), and submits it to
`BitcoinFactVerifier` on Creditcoin. Which rejects it:

```
✗  rejected by BitcoinFactVerifier
   the event was emitted, attested and proven — all genuine
   but topics[2] = 0x9a3f…c221, not btcwitness's relayer address
   → an attested transaction is not the same thing as a true fact
```

Why this earns its place: every judge at a crypto hackathon has seen "trustless" claimed and
never tested. Testing our own system against ourselves, live, is the single most credible thing
we can put on screen — and it teaches the one subtlety in the design (attestation proves
*occurrence*, our verifier proves *authorship*) better than any diagram.

> **Prerequisite, now met:** this panel is only honest because `BitcoinFactVerifier` checks
> the relayer topic (see `docs/AUDIT-2026-08-29.md`, CRITICAL-1, fixed 2026-08-29). Before
> that fix this attack succeeded, which is exactly why the panel is worth showing.

---

## Visual language

Deliberately restrained — the content is hashes and numbers, and any styling that competes with
them costs credibility.

- **Layout:** single column, max ~760px, generous vertical rhythm. Reads on a phone and in a
  screen recording without zooming.
- **Type:** one UI sans (Inter) + one mono (JetBrains Mono). Every chain-derived value is mono.
  Everything we wrote ourselves is sans. That split alone tells the reader what is data and what
  is narration.
- **Colour:** near-monochrome shell (dark and light both, theme-aware). Exactly four accents,
  each meaning one thing and never used decoratively:
  - amber → Bitcoin-derived data
  - violet → exSat (native + EVM)
  - teal → Creditcoin / Attestcoin
  - red → rejected / not proven
- **No logos-and-arrows hero.** The Trail *is* the hero. A static architecture diagram lives one
  scroll below, for the reader who wants the map after seeing the territory.
- **Motion:** one travelling dot, one elapsed-time counter. Nothing else moves.

---

## Build plan

**Stack:** a single self-contained HTML page — no build step, no framework. `ethers` for exSat
EVM and Creditcoin, `fetch` for the EOS RPC, `@polkadot/api` only if we need Substrate state
directly. A tiny local read-only server holds the RPC calls if CORS bites.

Everything the page displays already exists as a function in `scripts/demo.ts` — the UI is a
second front-end onto the same code path, not a reimplementation. Refactor `demo.ts` to export
its steps, then drive them from the page.

**Order of work, cut from the bottom if time runs out:**

1. The Trail, read-only (stations ①③④⑤ from live endpoints, historical tx) — *demo-able alone*
2. The Trail, live (station ② firing a real relay)
3. The Forgery Test — *highest value per hour, but needs CRITICAL-1 fixed first*
4. The Ledger — *the "why", worth cutting only if the mechanism isn't yet solid*
5. Static architecture diagram below the fold

**Recording budget (3 minutes):** 20 s problem → 70 s one full Trail run → 20 s Forgery Test →
30 s Ledger → 20 s trust model, honestly stated. The Trail is the demo; everything else is
framing.
