import { ApiPromise, WsProvider } from '@polkadot/api';
const api = await ApiPromise.create({ provider: new WsProvider('ws://127.0.0.1:9944'), noInitWarn: true });
console.log('attestation extrinsics:');
for (const [n, f] of Object.entries(api.tx.attestation)) {
  console.log(' -', n + '(' + (f.meta.args.map(a => `${a.name}: ${a.type}`).join(', ')) + ')');
}
await api.disconnect();
