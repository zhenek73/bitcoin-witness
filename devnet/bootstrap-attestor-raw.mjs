/**
 * Same as bootstrap-attestor.mjs, but registers an attestor identity derived
 * from a raw 32-byte hex seed instead of the sr25519 soft-junction "//Bob".
 *
 * Why: the attestor binary's --secret flag only accepts a bare BIP39
 * mnemonic or a raw hex seed (confirmed via --help and a real rejection:
 * "invalid mnemonic or hex seed: mnemonic has an invalid word count: 1" when
 * given "//Bob"). It does not parse sp-core junction syntax at all, so an
 * account derived via addFromUri('//Bob') can never be reproduced by the CLI
 * -- the registered attestor and the signing key were two different
 * accounts. Registering the address that Keyring.addFromSeed(sameRawSeed)
 * produces keeps both sides using the identical key.
 *
 * Usage: node bootstrap-attestor-raw.mjs <hexSeed> [chainKey] [ws://127.0.0.1:9944]
 */
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { hexToU8a } from '@polkadot/util';

const HEX_SEED = process.argv[2];
if (!HEX_SEED || !/^0x[0-9a-fA-F]{64}$/.test(HEX_SEED)) {
  console.error('usage: node bootstrap-attestor-raw.mjs 0x<64 hex chars> [chainKey] [ws url]');
  process.exit(1);
}
const CHAIN_KEY = Number(process.argv[3] ?? 7);
const ENDPOINT = process.argv[4] ?? 'ws://127.0.0.1:9944';

const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
const kr = new Keyring({ type: 'sr25519' });
const stash = kr.addFromUri('//Alice');           // bonds the funds; junction is fine, nothing signs with this via the CLI
const attestor = kr.addFromSeed(hexToU8a(HEX_SEED)); // must match what the attestor binary derives from the same seed

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

await send('registerAttestor', api.tx.attestation.registerAttestor(CHAIN_KEY, attestor.address), stash);
await send('setTargetSampleSize(1)', api.tx.attestation.setTargetSampleSize(CHAIN_KEY, 1), stash, true);
await send('forceApplyUpdates', api.tx.attestation.forceApplyUpdates(), stash, true);
await send('forceElection', api.tx.attestation.forceElection(1), stash, true);

const attestors = await api.query.attestation.attestors.entries();
console.log('\nattestors:', JSON.stringify(attestors.map(([k, v]) => [k.toHuman(), v.toHuman().status])));
await api.disconnect();
