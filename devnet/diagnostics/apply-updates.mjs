import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
const CK = Number(process.argv[2] ?? 7);
const api = await ApiPromise.create({ provider: new WsProvider('ws://127.0.0.1:9944'), noInitWarn: true });
const alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
await new Promise((res, rej) => api.tx.sudo.sudo(api.tx.attestation.forceApplyUpdates()).signAndSend(alice, ({ status, dispatchError, events }) => {
  if (dispatchError) { console.log('forceApplyUpdates:', dispatchError.toString()); res(); }
  else if (status.isInBlock) { console.log('forceApplyUpdates ok:', events.filter(({event})=>event.section==='attestation').map(({event})=>event.method).join(',')); res(); }
}).catch(rej));
console.log('genesis now:', JSON.stringify((await api.query.attestation.attestationChainGenesisBlockNumber(CK)).toHuman()));
console.log('lastDigest :', JSON.stringify((await api.query.attestation.lastDigest(CK)).toHuman()));
await api.disconnect();
