/**
 * Runs attestation.forceElection so a newly-registered, Idle attestor is pulled
 * into the active set. Sudo-signed by //Alice (the --dev sudo key).
 *
 * Needed separately from bootstrap-attestor2.mjs because targetSampleSize only
 * takes effect after forceApplyUpdates, and the election that fills the newly
 * available seat has to happen after that.
 *
 * Usage: node force-election.mjs [epochs] [ws://127.0.0.1:9944]
 */
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
const EPOCHS = Number(process.argv[2] ?? 1);
const api = await ApiPromise.create({ provider: new WsProvider(process.argv[3] ?? 'ws://127.0.0.1:9944'), noInitWarn: true });
const alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
await new Promise((resolve, reject) => {
  api.tx.sudo.sudo(api.tx.attestation.forceElection(EPOCHS)).signAndSend(alice, ({ status, dispatchError, events }) => {
    if (dispatchError) { console.log('forceElection failed:', dispatchError.toString()); resolve(); }
    else if (status.isInBlock) {
      console.log('forceElection ok:', events.filter(({ event }) => event.section === 'attestation').map(({ event }) => event.method).join(','));
      resolve();
    }
  }).catch(reject);
});
const active = await api.query.attestation.activeAttestors(7);
console.log('activeAttestors now:', JSON.stringify(active.toHuman()));
await api.disconnect();
