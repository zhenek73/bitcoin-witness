/**
 * Unregisters attestor 2 so the attestor BINARY can register itself instead.
 *
 * The deadlock this escapes: `registerAttestor` (what bootstrap-attestor2.mjs
 * called) creates the attestor entry with blsPublicKey = null. The BLS key is
 * only published by the separate `attest(chainKey, blsPublicKey,
 * proofOfPossession)` extrinsic, which only the attestor binary can build (it
 * holds the BLS key and must produce a proof of possession). But the binary
 * submits attest() only when it finds itself NOT registered — if it is already
 * registered it just logs "waiting on election..." forever. Meanwhile the
 * election never picks an attestor with no BLS key. So pre-registering the
 * account with registerAttestor is actively harmful: it locks the attestor out
 * of the very call that would make it electable.
 *
 * Correct order: fund the account -> start the binary -> let it attest() itself
 * (registering AND publishing its BLS key) -> then forceElection.
 *
 * Usage: node unregister-attestor2.mjs [chainKey] [ws://127.0.0.1:9944]
 */
import { readFileSync } from 'node:fs';
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { hexToU8a } from '@polkadot/util';

const env = Object.fromEntries(
  readFileSync(new URL('.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const CHAIN_KEY = Number(process.argv[2] ?? 7);
const api = await ApiPromise.create({ provider: new WsProvider(process.argv[3] ?? 'ws://127.0.0.1:9944'), noInitWarn: true });
const kr = new Keyring({ type: 'sr25519' });
const stash = kr.addFromUri('//Charlie');
const attestor = kr.addFromSeed(hexToU8a(env.ATTESTOR2_SECRET));

await new Promise((resolve, reject) => {
  api.tx.attestation.unregisterAttestor(CHAIN_KEY, attestor.address).signAndSend(stash, ({ status, dispatchError }) => {
    if (dispatchError) {
      const msg = dispatchError.isModule
        ? (() => { const d = api.registry.findMetaError(dispatchError.asModule); return `${d.section}.${d.name}`; })()
        : dispatchError.toString();
      console.log('unregisterAttestor:', msg); resolve();
    } else if (status.isInBlock) { console.log('unregisterAttestor: ok'); resolve(); }
  }).catch(reject);
});

const entries = await api.query.attestation.attestors.entries();
console.log('attestors now:', JSON.stringify(entries.map(([k, v]) => [k.toHuman()[1], v.toHuman().status])));
await api.disconnect();
