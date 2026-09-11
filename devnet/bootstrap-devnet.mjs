/**
 * Stands the whole CC3 devnet up from a fresh chain, in one command.
 *
 * Run this after `docker compose up -d cc3` on a chain with no history (a new
 * machine, or after `docker compose down -v`). It:
 *   1. reads exSat's current EVM head and picks an attestation genesis just
 *      below it -- attesting from an old height means grinding through hundreds
 *      of thousands of blocks at ~230 blocks/min, and the genesis is immutable
 *      once the chain has attestation history, so it has to be right the first
 *      time;
 *   2. registers exSat as an Attestcoin source chain and reads back the
 *      assigned chain_key (it is NOT the EVM chainId -- exSat is chainId 7200
 *      but gets a small sequential key);
 *   3. registers the attestor identity from devnet/.env, sets the sample size
 *      to 1, applies updates and elects it.
 *
 * It prints the chain key at the end. Feed that to deploy_verifier.mjs
 * (EXSAT_CHAIN_KEY) and into attestor-config.yaml / proofgen-config.yaml.
 *
 * Usage: node bootstrap-devnet.mjs [ws://127.0.0.1:9944]
 */
import { readFileSync } from 'node:fs';
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { hexToU8a } from '@polkadot/util';

const ENDPOINT = process.argv[2] ?? 'ws://127.0.0.1:9944';
const EXSAT_EVM_RPC = process.env.EXSAT_EVM_RPC ?? 'https://evm.exsat.network';
const EXSAT_EVM_CHAIN_ID = 7200;
const CHAIN_NAME = process.env.CHAIN_NAME ?? 'exSat';
/** How far below exSat's head to start attesting. A few hundred blocks is
 *  enough headroom to relay and still be inside attested range within minutes. */
const GENESIS_LAG = Number(process.env.GENESIS_LAG ?? 200);

const env = Object.fromEntries(
  readFileSync(new URL('.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
if (!/^0x[0-9a-fA-F]{64}$/.test(env.ATTESTOR_SECRET ?? '')) {
  console.error('ATTESTOR_SECRET missing or not a 32-byte hex seed in devnet/.env');
  process.exit(1);
}

async function exsatHead() {
  const res = await fetch(EXSAT_EVM_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  return parseInt((await res.json()).result, 16);
}

const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
const kr = new Keyring({ type: 'sr25519' });
// //Alice is both the genesis-funded stash and the --dev sudo key. Sudo-wrapped
// calls signed by any other account fail with sudo.RequireSudo.
const alice = kr.addFromUri('//Alice');
const attestor = kr.addFromSeed(hexToU8a(env.ATTESTOR_SECRET));

const send = (label, call, sudo = false) => new Promise((resolve, reject) => {
  (sudo ? api.tx.sudo.sudo(call) : call).signAndSend(alice, ({ status, dispatchError, events }) => {
    if (dispatchError) {
      const msg = dispatchError.isModule
        ? (() => { const d = api.registry.findMetaError(dispatchError.asModule); return `${d.section}.${d.name}`; })()
        : dispatchError.toString();
      console.log(`  ${label}: ${msg}`);
      resolve({ ok: false, events: [] });
    } else if (status.isInBlock) {
      console.log(`  ${label}: ok`);
      resolve({ ok: true, events });
    }
  }).catch(reject);
});

const head = await exsatHead();
const genesis = head - GENESIS_LAG;
console.log(`exSat EVM head ${head} -> attestation genesis ${genesis}`);
console.log(`attestor ${attestor.address}\n`);

// --- 1. register the source chain ------------------------------------------
const reg = await send(
  `registerChain("${CHAIN_NAME}", genesis ${genesis})`,
  api.tx.supportedChains.registerChain(
    EXSAT_EVM_CHAIN_ID, CHAIN_NAME,
    null, null, null, null, null,
    genesis,
    'V1', null,
  ),
  true,
);

// Registration is keyed on the PAIR (chainId, chainName): re-registering the
// same pair is a silent no-op that emits no event, so read the key back from
// the map rather than relying on the event being there.
let chainKey;
const ev = reg.events.find(({ event }) => event.section === 'supportedChains' && event.method === 'ChainRegistered');
if (ev) {
  chainKey = Number(ev.event.data.toJSON()[0]);
} else {
  const map = await api.query.supportedChains.chainIdAndNameToUniqKey.entries();
  const hit = map.find(([k]) => {
    const [id, name] = k.toHuman();
    return String(id).replace(/,/g, '') === String(EXSAT_EVM_CHAIN_ID) && name === CHAIN_NAME;
  });
  if (!hit) throw new Error('chain not registered and not found in chainIdAndNameToUniqKey');
  chainKey = Number(String(hit[1].toHuman()).replace(/,/g, ''));
  console.log('  (already registered — reusing existing key)');
}
console.log(`\nchain_key = ${chainKey}\n`);

// --- 2. register and elect the attestor ------------------------------------
// attestation.AlreadyAttestor here is success, not failure.
await send('registerAttestor', api.tx.attestation.registerAttestor(chainKey, attestor.address));
// Defaults to 3, so a single attestor could never satisfy an election.
await send('setTargetSampleSize(1)', api.tx.attestation.setTargetSampleSize(chainKey, 1), true);
// Sample size lands in pendingTargetSampleSize until this is called.
await send('forceApplyUpdates', api.tx.attestation.forceApplyUpdates(), true);
await send('forceElection', api.tx.attestation.forceElection(1), true);

const active = (await api.query.attestation.activeAttestors(chainKey)).toHuman();
const seated = Array.isArray(active) && active.includes(attestor.address);
console.log(`\nactiveAttestors: ${JSON.stringify(active)}`);
console.log(seated ? 'attestor is seated ✓' : 'attestor NOT seated — rerun force-election.mjs');

console.log(`
Next steps:
  1. set chain_key: ${chainKey} in devnet/attestor-config.yaml and devnet/proofgen-config.yaml
  2. docker compose up -d --force-recreate attestor proofgen
  3. cd ../scripts && EXSAT_CHAIN_KEY=${chainKey} node deploy_verifier.mjs
  4. run demo.ts with EXSAT_CHAIN_KEY=${chainKey} and the new VERIFIER_ADDRESS
`);
await api.disconnect();
