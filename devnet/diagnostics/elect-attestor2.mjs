/**
 * Registers attestor 2 and elects it into the active set.
 *
 * The detail that matters: forceElection takes an EPOCH. Running it for an
 * epoch whose election already ran is a no-op for a newly registered attestor,
 * which is why calling forceElection(1) repeatedly never seated attestor 2 —
 * epoch 1's election is where attestor 1 was seated. This walks forward from
 * the current session index instead, and stops as soon as the active set
 * contains attestor 2.
 *
 * Election does NOT require a BLS key: attestor 1 was seated with
 * blsPublicKey = null and published its key afterwards.
 *
 * Usage: node elect-attestor2.mjs [chainKey] [ws://127.0.0.1:9944]
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
const sudoKey = kr.addFromUri('//Alice');
const attestor2 = kr.addFromSeed(hexToU8a(env.ATTESTOR2_SECRET));

const send = (label, call, signer, sudo = false) => new Promise((resolve, reject) => {
  (sudo ? api.tx.sudo.sudo(call) : call).signAndSend(signer, ({ status, dispatchError, events }) => {
    if (dispatchError) {
      const msg = dispatchError.isModule
        ? (() => { const d = api.registry.findMetaError(dispatchError.asModule); return `${d.section}.${d.name}`; })()
        : dispatchError.toString();
      console.log(`  ${label}: ${msg}`); resolve(false);
    } else if (status.isInBlock) {
      console.log(`  ${label}: ok ${events.filter(({ event }) => event.section === 'attestation').map(({ event }) => event.method).join(',')}`);
      resolve(true);
    }
  }).catch(reject);
});

const isActive = async () => (await api.query.attestation.activeAttestors(CHAIN_KEY)).toHuman().includes(attestor2.address);

console.log('attestor2', attestor2.address);
await send('registerAttestor', api.tx.attestation.registerAttestor(CHAIN_KEY, attestor2.address), stash);

const epoch = api.query.session?.currentIndex ? (await api.query.session.currentIndex()).toNumber() : 1;
console.log('current session index:', epoch);

for (let e = epoch + 1; e <= epoch + 4; e++) {
  await send(`forceElection(${e})`, api.tx.attestation.forceElection(e), sudoKey, true);
  if (await isActive()) { console.log(`\nattestor2 is ACTIVE (elected at epoch ${e})`); break; }
  console.log(`  attestor2 not seated yet after epoch ${e}`);
}

console.log('activeAttestors:', JSON.stringify((await api.query.attestation.activeAttestors(CHAIN_KEY)).toHuman()));
await api.disconnect();
