import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
const api = await ApiPromise.create({ provider: new WsProvider('ws://127.0.0.1:9944'), noInitWarn: true });
const kr = new Keyring({ type: 'sr25519' });
const alice = kr.addFromUri('//Alice').address, charlie = kr.addFromUri('//Charlie').address;
console.log('alice(stash1)  :', alice);
console.log('charlie(stash2):', charlie);
console.log('minBondRequirement:', (await api.query.attestation.minBondRequirement(7)).toHuman?.() ?? 'n/a');
for (const [label, addr] of [['alice', alice], ['charlie', charlie]]) {
  try { console.log(`ledger[${label}]:`, JSON.stringify((await api.query.attestation.ledger(addr)).toHuman())); }
  catch (e) { console.log(`ledger[${label}] err:`, e.message); }
  const acc = await api.query.system.account(addr);
  console.log(`  free=${acc.data.free.toString()} reserved=${acc.data.reserved.toString()}`);
}
console.log('chainElectionPolicy:', JSON.stringify((await api.query.attestation.chainElectionPolicy(7)).toHuman()));
console.log('authorizedAttestors:', JSON.stringify((await api.query.attestation.authorizedAttestors.entries()).map(([k,v])=>[k.toHuman(),v.toHuman()])));
console.log('invulnerables:', JSON.stringify((await api.query.attestation.invulnerables(7)).toHuman()));
await api.disconnect();
