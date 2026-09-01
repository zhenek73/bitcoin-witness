#!/usr/bin/env node
/**
 * Derive the exSat-EVM "reserved address" of an Antelope account.
 *
 * evm.xsat runs `call(from, ...)` as this address, so it is what the receiver
 * sees as msg.sender and what ends up in the relayer log topic. Three places
 * need it and all three must agree:
 *
 *   BitcoinWitnessReceiver(relayer)
 *   BitcoinFactVerifier(chainKey, emitter, relayer)
 *   the account you actually deploy btcwitness to
 *
 * Getting it wrong does not error at deploy time. It errors much later, as
 * every proof being rejected with "no matching event" — which reads like a
 * decoding bug rather than a one-character difference in an account name.
 * Hence a script instead of a value pasted into a doc: `btcwitness` and
 * `btcwitness11` differ by two characters and produce different addresses.
 *
 * Layout: 0xbb * 12 (12 bytes) ‖ name_u64 (8 bytes, big-endian, low-order).
 *
 * CORRECTED 2026-09-01: this used to be documented/implemented as
 * `0xbbbbbbbb ‖ name_u64 ‖ 8 zero bytes` (4-byte prefix, name in the middle,
 * zero-padded tail). That was wrong, and it was the actual root cause of
 * every real on-chain relay call reverting with the receiver's `NotRelayer`
 * custom error (which prints no console text, since it's a typed error, not
 * a require-string — that's exactly why this looked like a silent/opaque
 * failure for so long). Ground truth, extracted directly from a real,
 * already-executed `evm.xsat::call` transaction on EOS mainnet
 * (`oracle.xsat`, tx a660275b0a60d005af23f783065ed0abf7921238a949ab695a4ee5afa22ab306,
 * decoded via `eth_getTransactionByHash` on evm.exsat.network — this is the
 * node's own ground-truth `from`, not an inference): the sender address it
 * actually used was `0xbbbbbbbbbbbbbbbbbbbbbbbba5cc88a81dc1b200` — twelve
 * 0xbb bytes, then the account's 8-byte name value in the LOW-order
 * (rightmost) position. Every prior deployment of BitcoinWitnessReceiver and
 * BitcoinFactVerifier used the old wrong formula for their `relayer`
 * constructor argument and must be redeployed with the corrected address.
 *
 * Usage: node reserved-address.mjs btcwitness11
 */
import { getAddress } from 'ethers';

const CHARMAP = '.12345abcdefghijklmnopqrstuvwxyz';

/** Antelope name -> uint64, the same base-32 packing nodeos uses. */
export function nameToUint64(name) {
  if (!/^[.1-5a-z]{1,13}$/.test(name)) throw new Error(`not a valid Antelope name: ${name}`);
  let value = 0n;
  for (let i = 0; i < 13; i++) {
    const c = i < name.length ? BigInt(CHARMAP.indexOf(name[i])) : 0n;
    // The first 12 characters take 5 bits each; the 13th only gets 4.
    if (i < 12) value |= (c & 0x1fn) << (64n - 5n * BigInt(i + 1));
    else value |= c & 0x0fn;
  }
  return value;
}

export function reservedAddress(name) {
  const packed = nameToUint64(name).toString(16).padStart(16, '0');
  // getAddress applies the EIP-55 checksum, so the value is safe to paste anywhere.
  return getAddress('0x' + 'bb'.repeat(12) + packed);
}

// Only run the CLI when this file is executed directly -- importing
// `reservedAddress` from another script (deploy_receiver.mjs,
// deploy_verifier.mjs) must not also trigger this usage check against
// *their* argv.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [name] = process.argv.slice(2);
  if (!name) {
    console.error('Usage: node reserved-address.mjs <antelope-account>');
    process.exit(1);
  }
  console.log(reservedAddress(name));
}
