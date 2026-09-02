/**
 * Moves the attestation start point for a chain forward.
 *
 * Why: register-exsat.mjs set the chain's attestation genesis to 59225940 —
 * correct on 2026-08-26 ("set this near the current head when you run it"), but
 * exSat's EVM head is now ~59.79M. The attestor catches up at roughly 230
 * blocks/min, so grinding from the old genesis to the block we actually need
 * (59791789, where our BitcoinUtxoAttested event lives) would take ~40 hours of
 * pure catch-up over data nobody will ever ask about.
 *
 * This is not a shortcut around verification: the attestor still attests every
 * block it covers from the new start point, exactly as before. It only changes
 * where the (arbitrary, operator-chosen) attestation history begins — the same
 * choice register-exsat.mjs made in the first place.
 *
 * Usage: node advance-genesis.mjs <height> [chainKey] [ws://127.0.0.1:9944]
 */
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
const HEIGHT = Number(process.argv[2]);
const CHAIN_KEY = Number(process.argv[3] ?? 7);
if (!Number.isInteger(HEIGHT)) { console.error('usage: node advance-genesis.mjs <height> [chainKey] [ws]'); process.exit(1); }
const api = await ApiPromise.create({ provider: new WsProvider(process.argv[4] ?? 'ws://127.0.0.1:9944'), noInitWarn: true });
const alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');

const send = (label, call) => new Promise((resolve, reject) => {
  api.tx.sudo.sudo(call).signAndSend(alice, ({ status, dispatchError, events }) => {
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

console.log('before: lastDigest =', JSON.stringify((await api.query.attestation.lastDigest(CHAIN_KEY)).toHuman()));
await send(`setAttestationChainGenesisBlockNumber(${HEIGHT})`, api.tx.attestation.setAttestationChainGenesisBlockNumber(CHAIN_KEY, HEIGHT));
console.log('genesis storage:', JSON.stringify((await api.query.attestation.attestationChainGenesisBlockNumber(CHAIN_KEY)).toHuman()));
console.log('after : lastDigest =', JSON.stringify((await api.query.attestation.lastDigest(CHAIN_KEY)).toHuman()));
await api.disconnect();
