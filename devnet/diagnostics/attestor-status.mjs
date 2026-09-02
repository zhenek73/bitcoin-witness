import { ApiPromise, WsProvider } from '@polkadot/api';
const api = await ApiPromise.create({ provider: new WsProvider(process.argv[2] ?? 'ws://127.0.0.1:9944'), noInitWarn: true });
const entries = await api.query.attestation.attestors.entries();
for (const [k, v] of entries) console.log(JSON.stringify(k.toHuman()), '->', JSON.stringify(v.toHuman()));
for (const q of ['targetSampleSize', 'pendingTargetSampleSize', 'activeAttestors', 'quorum', 'chainAttestationInterval']) {
  if (api.query.attestation[q]) {
    try { console.log(q, ':', JSON.stringify((await api.query.attestation[q](7)).toHuman())); }
    catch { try { console.log(q, ':', JSON.stringify((await api.query.attestation[q]()).toHuman())); } catch {} }
  }
}
console.log('available attestation storage:', Object.keys(api.query.attestation).join(', '));
await api.disconnect();
