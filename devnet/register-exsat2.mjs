/**
 * Registers exSat a SECOND time, under a different chain NAME, to get a fresh
 * chain_key whose attestation genesis sits just below the block we need.
 *
 * Why a second registration instead of moving chain 7's genesis: the attestation
 * genesis block number is immutable once a chain has attestation history.
 * `setAttestationChainGenesisBlockNumber(7, ...)` reports success but leaves the
 * stored value untouched (verified — it stayed 59225940 even after
 * forceApplyUpdates). Chain 7's genesis was set to 59225940 on 2026-08-26, when
 * that was near exSat's head; the head is now ~59.79M, and the attestor catches
 * up at roughly 230 blocks/min, so reaching block 59791789 on chain 7 would take
 * about 40 hours of grinding through history nobody will ever query.
 *
 * Registration is keyed on the PAIR (chainId, chainName) -- see the
 * supportedChains.chainIdAndNameToUniqKey storage map -- so re-registering
 * chainId 7200 under the same name "exSat" is a silent no-op (it resolves to the
 * existing key 7 and emits no ChainRegistered event). A different name yields a
 * new key. Same underlying chain, same RPC, same data; only the attestation
 * history's starting point differs.
 *
 * After this: point the attestor at the new chain_key, and redeploy
 * BitcoinFactVerifier with the new key in its constructor.
 *
 * Usage: node register-exsat2.mjs [startHeight] [name] [ws://127.0.0.1:9944]
 */
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';

const START_HEIGHT = Number(process.argv[2] ?? 59791700);
const CHAIN_NAME = process.argv[3] ?? 'exSat2';
const ENDPOINT = process.argv[4] ?? 'ws://127.0.0.1:9944';
const EXSAT_EVM_CHAIN_ID = 7200;

const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
const alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
console.log(`registering "${CHAIN_NAME}" (chainId ${EXSAT_EVM_CHAIN_ID}) with attestation genesis ${START_HEIGHT}`);

const call = api.tx.supportedChains.registerChain(
  EXSAT_EVM_CHAIN_ID, CHAIN_NAME,
  null, null, null, null, null,
  START_HEIGHT,
  'V1', null,
);

await new Promise((resolve, reject) => {
  api.tx.sudo.sudo(call).signAndSend(alice, ({ status, dispatchError, events }) => {
    if (dispatchError) {
      const msg = dispatchError.isModule
        ? (() => { const d = api.registry.findMetaError(dispatchError.asModule); return `${d.section}.${d.name}: ${d.docs.join(' ')}`; })()
        : dispatchError.toString();
      console.log('registerChain failed:', msg); resolve();
    } else if (status.isInBlock) {
      const ev = events.find(({ event }) => event.section === 'supportedChains' && event.method === 'ChainRegistered');
      console.log(ev ? 'registered: ' + JSON.stringify(ev.event.data.toHuman())
                     : 'in block, but no ChainRegistered event (already registered under this name?)');
      resolve();
    }
  }).catch(reject);
});

const map = await api.query.supportedChains.chainIdAndNameToUniqKey.entries();
console.log('chainId+name -> key:', JSON.stringify(map.map(([k, v]) => [k.toHuman(), v.toHuman()])));
await api.disconnect();
