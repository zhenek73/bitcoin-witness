/**
 * How far the attestor is behind exSat's head.
 *
 * Run this before recording a demo or doing a live run. A fresh relay lands at
 * exSat's current head, and demo.ts cannot finish until the attestor has
 * attested that height — so a large gap means the run will sit waiting instead
 * of completing in under a minute.
 *
 * The attestor catches up far faster than exSat produces blocks (~1400/min
 * against ~60/min), so a gap closes on its own; this just tells you whether to
 * wait. Under ~200 is fine to record.
 *
 * Usage: node gap.mjs [chainKey] [ws://127.0.0.1:9944]
 */
import { ApiPromise, WsProvider } from '@polkadot/api';

const CHAIN_KEY = Number(process.argv[2] ?? 7);
const ENDPOINT = process.argv[3] ?? 'ws://127.0.0.1:9944';
const EXSAT_RPC = process.env.EXSAT_EVM_RPC ?? 'https://evm.exsat.network';

const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });

const digest = (await api.query.attestation.lastDigest(CHAIN_KEY)).toHuman();
if (!digest) {
  console.log(`chain key ${CHAIN_KEY} has no attestations yet — is the attestor elected and running?`);
  await api.disconnect();
  process.exit(1);
}
const attested = Number(String(digest[0]).replace(/,/g, ''));

const res = await fetch(EXSAT_RPC, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
});
const head = parseInt((await res.json()).result, 16);
const gap = head - attested;

console.log(`attested : ${attested.toLocaleString('en-US')}`);
console.log(`exSat head: ${head.toLocaleString('en-US')}`);
console.log(`gap      : ${gap.toLocaleString('en-US')}`);

if (gap <= 200) {
  console.log('\nReady to record — a fresh relay will be attested within about a minute.');
} else {
  // Net closing rate, measured: attestor ~1400 blocks/min, exSat ~60 blocks/min.
  console.log(`\nStill catching up. Roughly ${Math.ceil(gap / 1340)} min to go — re-run this then.`);
}

await api.disconnect();
