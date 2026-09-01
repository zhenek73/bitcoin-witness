/**
 * Bootstraps the existing attestor identity onto a chain key (default 8, the
 * "exSat2" registration whose attestation genesis is 59791700).
 *
 * Same sequence as bootstrap-attestor-raw.mjs, with two corrections learned the
 * hard way:
 *  - the sudo-wrapped calls must be signed by the SUDO key (//Alice on --dev);
 *    signing them with another stash fails with sudo.RequireSudo;
 *  - attestation.AlreadyAttestor on registerAttestor is a success, not an error.
 *
 * Usage: node bootstrap-chain8.mjs [chainKey] [ws://127.0.0.1:9944]
 */
import { readFileSync } from 'node:fs';
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { hexToU8a } from '@polkadot/util';

const env = Object.fromEntries(
  readFileSync(new URL('.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const CHAIN_KEY = Number(process.argv[2] ?? 8);
const api = await ApiPromise.create({ provider: new WsProvider(process.argv[3] ?? 'ws://127.0.0.1:9944'), noInitWarn: true });
const kr = new Keyring({ type: 'sr25519' });
const stash = kr.addFromUri('//Alice');
const attestor = kr.addFromSeed(hexToU8a(env.ATTESTOR_SECRET));

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

console.log('chainKey', CHAIN_KEY, '\nattestor', attestor.address, '\n');
await send('registerAttestor', api.tx.attestation.registerAttestor(CHAIN_KEY, attestor.address), stash);
await send('setTargetSampleSize(1)', api.tx.attestation.setTargetSampleSize(CHAIN_KEY, 1), stash, true);
await send('forceApplyUpdates', api.tx.attestation.forceApplyUpdates(), stash, true);
await send('forceElection', api.tx.attestation.forceElection(1), stash, true);
console.log('\nactiveAttestors:', JSON.stringify((await api.query.attestation.activeAttestors(CHAIN_KEY)).toHuman()));
console.log('genesis        :', JSON.stringify((await api.query.attestation.attestationChainGenesisBlockNumber(CHAIN_KEY)).toHuman()));
await api.disconnect();
