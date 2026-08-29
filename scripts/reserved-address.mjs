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
 * Layout: 0xbbbbbbbb ‖ name_u64 (8 bytes, big-endian) ‖ 8 zero bytes.
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
  return getAddress('0xbbbbbbbb' + packed + '0'.repeat(16));
}

const [name] = process.argv.slice(2);
if (!name) {
  console.error('Usage: node reserved-address.mjs <antelope-account>');
  process.exit(1);
}
console.log(reservedAddress(name));
