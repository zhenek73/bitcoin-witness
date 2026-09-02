import { ApiPromise, WsProvider } from '@polkadot/api';
const CK = 7;
const api = await ApiPromise.create({ provider: new WsProvider('ws://127.0.0.1:9944'), noInitWarn: true });
const show = async (name, ...args) => {
  try { const v = await api.query.attestation[name](...args); console.log(name + ':', JSON.stringify(v.toHuman())); }
  catch (e) { console.log(name + ' err:', e.message.slice(0, 120)); }
};
await show('lastDigest', CK);
await show('lastCheckpoint', CK);
const atts = await api.query.attestation.attestations.entries(CK);
console.log('attestations count:', atts.length);
for (const [k, v] of atts.slice(-5)) console.log('  ', JSON.stringify(k.toHuman()), '->', JSON.stringify(v.toHuman()).slice(0, 160));
const cps = await api.query.attestation.checkpoints.entries(CK);
console.log('checkpoints count:', cps.length);
for (const [k, v] of cps.slice(-3)) console.log('  ', JSON.stringify(k.toHuman()), '->', JSON.stringify(v.toHuman()).slice(0, 200));
await api.disconnect();
