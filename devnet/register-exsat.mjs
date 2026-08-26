/**
 * Registers exSat as an Attestcoin source chain on the local CC3 devnet.
 *
 * Verified working on 2026-08-26: emits
 *   supportedChains.ChainRegistered { chainKey: 7, chainId: 7200,
 *     chainName: "exSat", chainEncoding: "V1", maturityStrategy: "EvmSafe" }
 *
 * The chain_key is assigned by the pallet, not chosen by us — read it from the
 * event (or from the ChainInfo precompile) and feed it to BitcoinFactVerifier's
 * constructor. It is NOT the EVM chainId: exSat is chainId 7200 but chain_key 7.
 *
 * Usage: node register-exsat.mjs [ws://127.0.0.1:9944]
 */
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';

const ENDPOINT = process.argv[2] ?? 'ws://127.0.0.1:9944';
const EXSAT_EVM_CHAIN_ID = 7200;

// Attestations start from this height rather than exSat's genesis — exSat EVM
// is ~59M blocks in, and attesting from block 0 would be pointless work.
// Set this near the current head when you run it.
const GENESIS_HEIGHT = Number(process.env.START_HEIGHT ?? 59225940);

const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
const alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');

const call = api.tx.supportedChains.registerChain(
  EXSAT_EVM_CHAIN_ID,
  'exSat',
  null, // targetSampleSize            -> pallet default (3)
  null, // chainAttestationInterval    -> pallet default (10)
  null, // attestationCheckpointInterval
  null, // maxAttestors                -> pallet default (100)
  null, // maxInvulnerables
  GENESIS_HEIGHT,
  'V1', // encoding: the only variant; generic across EVM chains
  null  // maturityStrategy            -> defaults to EvmSafe
);

// registerChain is gated by the Operators origin. On a --dev chain the sudo
// key satisfies it; on a real deployment you would be an actual operator.
await new Promise((resolve, reject) => {
  api.tx.sudo.sudo(call).signAndSend(alice, ({ status, dispatchError, events }) => {
    if (dispatchError) {
      const msg = dispatchError.isModule
        ? (() => { const d = api.registry.findMetaError(dispatchError.asModule); return `${d.section}.${d.name}: ${d.docs.join(' ')}`; })()
        : dispatchError.toString();
      reject(new Error(msg));
    } else if (status.isInBlock) {
      for (const { event } of events) {
        if (event.section === 'supportedChains' && event.method === 'ChainRegistered') {
          console.log('registered:', JSON.stringify(event.data.toHuman()));
        }
      }
      resolve();
    }
  }).catch(reject);
});

await api.disconnect();
