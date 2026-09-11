/**
 * Runs attestation.forceElection so a registered, Idle attestor is pulled into
 * the active set. Sudo-signed by //Alice (the --dev sudo key) — signing with
 * any other account fails with sudo.RequireSudo.
 *
 * Needed separately from bootstrap-devnet.mjs because an attestor registered in
 * the same batch is often not seated by the election that runs immediately
 * after; running this once more a block or two later seats it. The attestor
 * binary logs "⏲️ waiting on election..." until that happens.
 *
 * Usage: node force-election.mjs [epoch] [chainKey] [ws://127.0.0.1:9944]
 */
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';

const EPOCH = Number(process.argv[2] ?? 1);
const CHAIN_KEY = Number(process.argv[3] ?? 7);
const ENDPOINT = process.argv[4] ?? 'ws://127.0.0.1:9944';

const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
const alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');

await new Promise((resolve, reject) => {
  api.tx.sudo.sudo(api.tx.attestation.forceElection(EPOCH))
    .signAndSend(alice, ({ status, dispatchError, events }) => {
      if (dispatchError) { console.log('forceElection failed:', dispatchError.toString()); resolve(); }
      else if (status.isInBlock) {
        const evs = events.filter(({ event }) => event.section === 'attestation').map(({ event }) => event.method);
        console.log('forceElection ok:', evs.join(','));
        resolve();
      }
    }).catch(reject);
});

console.log(`activeAttestors(${CHAIN_KEY}):`,
  JSON.stringify((await api.query.attestation.activeAttestors(CHAIN_KEY)).toHuman()));
await api.disconnect();
