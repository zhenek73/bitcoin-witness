/**
 * Registers and elects the SECOND attestor (see attestor2-config.yaml for why a
 * second one is required at all: gossipsub will not publish to a topic with no
 * other subscriber, so a lone attestor queues every vote forever with
 * NoPeersSubscribedToTopic).
 *
 * Two things differ from bootstrap-attestor-raw.mjs:
 *
 *  1. A DIFFERENT stash (//Charlie). A stash bonds the funds for the attestor
 *     it registers; //Alice is already the stash for attestor 1.
 *  2. targetSampleSize is raised to 2, not 1. With a sample size of 1 only one
 *     attestor is ever in the active set, and an attestor only subscribes to
 *     the gossip topic AFTER it is elected -- so a sample size of 1 recreates
 *     exactly the deadlock we are trying to escape, just with a different
 *     attestor holding the lone seat.
 *
 * The secret is read from .env, never passed on the command line.
 *
 * Usage: node bootstrap-attestor2.mjs [chainKey] [ws://127.0.0.1:9944]
 */
import { readFileSync } from 'node:fs';
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { hexToU8a } from '@polkadot/util';

const env = Object.fromEntries(
  readFileSync(new URL('.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const HEX_SEED = env.ATTESTOR2_SECRET;
if (!HEX_SEED || !/^0x[0-9a-fA-F]{64}$/.test(HEX_SEED)) {
  console.error('ATTESTOR2_SECRET missing or not a 0x-prefixed 32-byte hex seed in devnet/.env');
  process.exit(1);
}
const CHAIN_KEY = Number(process.argv[2] ?? 7);
const ENDPOINT = process.argv[3] ?? 'ws://127.0.0.1:9944';

const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
const kr = new Keyring({ type: 'sr25519' });
// //Charlie bonds attestor 2 (a stash bonds one attestor; //Alice already
// bonds attestor 1). But the sudo KEY on a --dev chain is //Alice, so the
// sudo-wrapped governance calls below must be signed by Alice, not Charlie --
// signing them with Charlie fails with sudo.RequireSudo.
const stash = kr.addFromUri('//Charlie');
const sudoKey = kr.addFromUri('//Alice');
const attestor = kr.addFromSeed(hexToU8a(HEX_SEED));

const send = (label, call, signer, sudo = false) => new Promise((resolve, reject) => {
  (sudo ? api.tx.sudo.sudo(call) : call).signAndSend(signer, ({ status, dispatchError, events }) => {
    if (dispatchError) {
      const msg = dispatchError.isModule
        ? (() => { const d = api.registry.findMetaError(dispatchError.asModule); return `${d.section}.${d.name}`; })()
        : dispatchError.toString();
      console.log(`  ${label}: ${msg}`);
      resolve(false);
    } else if (status.isInBlock) {
      const evs = events.filter(({ event }) => event.section === 'attestation').map(({ event }) => event.method);
      console.log(`  ${label}: ok ${evs.join(',')}`);
      resolve(true);
    }
  }).catch(reject);
});

console.log('stash    ', stash.address);
console.log('attestor2', attestor.address, '\n');

// attestation.AlreadyAttestor here is success, not failure: the attestor binary
// submits attest() for itself on startup once it has a balance, so by the time
// this runs the identity is usually already registered.
await send('registerAttestor(attestor2)', api.tx.attestation.registerAttestor(CHAIN_KEY, attestor.address), stash);
await send('setTargetSampleSize(2)', api.tx.attestation.setTargetSampleSize(CHAIN_KEY, 2), sudoKey, true);
await send('forceApplyUpdates', api.tx.attestation.forceApplyUpdates(), sudoKey, true);
await send('forceElection', api.tx.attestation.forceElection(1), sudoKey, true);

const attestors = await api.query.attestation.attestors.entries();
console.log('\nattestors:', JSON.stringify(attestors.map(([k, v]) => [k.toHuman(), v.toHuman().status])));
await api.disconnect();
