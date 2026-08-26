/**
 * Bootstraps an attestor for exSat on the local CC3 devnet.
 *
 * Ordering matters and the failure modes are misleading, so each step below
 * notes what breaks without it. Verified working 2026-08-26.
 *
 * Usage: node bootstrap-attestor.mjs [chainKey] [ws://127.0.0.1:9944]
 */
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';

const CHAIN_KEY = Number(process.argv[2] ?? 7);
const ENDPOINT = process.argv[3] ?? 'ws://127.0.0.1:9944';

const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
const kr = new Keyring({ type: 'sr25519' });
const stash = kr.addFromUri('//Alice');   // bonds the funds
const attestor = kr.addFromUri('//Bob');  // runs the attestor binary

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

console.log('stash   ', stash.address);
console.log('attestor', attestor.address, '\n');

// Signed by the stash, naming a DIFFERENT account as attestor. Same account for
// both -> InvalidAttestorAccount. Wrapped in sudo -> silently registers the sudo
// pseudo-account instead of the stash, and the attestor never becomes Idle.
await send('registerAttestor', api.tx.attestation.registerAttestor(CHAIN_KEY, attestor.address), stash);

// Quorum. Defaults to 3, so a single attestor can never satisfy an election.
await send('setTargetSampleSize(1)', api.tx.attestation.setTargetSampleSize(CHAIN_KEY, 1), stash, true);

// The change above lands in pendingTargetSampleSize until an epoch boundary.
await send('forceApplyUpdates', api.tx.attestation.forceApplyUpdates(), stash, true);

// Elect the waiting attestor into the active set.
await send('forceElection', api.tx.attestation.forceElection(1), stash, true);

const attestors = await api.query.attestation.attestors.entries();
console.log('\nattestors:', JSON.stringify(attestors.map(([k, v]) => [k.toHuman(), v.toHuman().status])));
console.log('Start the attestor binary now — it will submit attest() once it sees itself as Idle.');
await api.disconnect();
