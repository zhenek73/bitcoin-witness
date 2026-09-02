import { ApiPromise, WsProvider } from '@polkadot/api';
const api = await ApiPromise.create({ provider: new WsProvider('ws://127.0.0.1:9944'), noInitWarn: true });
console.log('supportedChains storage:', Object.keys(api.query.supportedChains).join(', '));
for (const name of Object.keys(api.query.supportedChains)) {
  try {
    const e = await api.query.supportedChains[name].entries();
    if (e.length) console.log(`${name}: ` + JSON.stringify(e.map(([k, v]) => [k.toHuman(), v.toHuman()])).slice(0, 600));
  } catch {
    try { const v = await api.query.supportedChains[name](); console.log(`${name}:`, JSON.stringify(v.toHuman()).slice(0, 200)); } catch {}
  }
}
await api.disconnect();
