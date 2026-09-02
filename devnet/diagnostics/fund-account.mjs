/**
 * Funds an account on the local CC3 devnet from //Alice.
 *
 * Why this is needed: the attestor binary refuses to start with
 * "insufficient balance: 0 < 1000000000000000000" — it requires at least
 * 1 CTC (1e18) on its own account before it will register or run. A freshly
 * generated attestor key has nothing, so it must be topped up from a genesis
 * account first. On a --dev chain //Alice holds the genesis funds.
 *
 * Usage: node fund-account.mjs <address> [amountCTC] [ws://127.0.0.1:9944]
 */
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';

const ADDRESS = process.argv[2];
const AMOUNT_CTC = BigInt(process.argv[3] ?? 10);
const ENDPOINT = process.argv[4] ?? 'ws://127.0.0.1:9944';
if (!ADDRESS) { console.error('usage: node fund-account.mjs <address> [amountCTC] [endpoint]'); process.exit(1); }

const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });
const alice = new Keyring({ type: 'sr25519' }).addFromUri('//Alice');
const amount = AMOUNT_CTC * 10n ** 18n;

const before = await api.query.system.account(ADDRESS);
console.log('balance before:', before.data.free.toString());

await new Promise((resolve, reject) => {
  api.tx.balances.transferKeepAlive(ADDRESS, amount).signAndSend(alice, ({ status, dispatchError }) => {
    if (dispatchError) {
      const msg = dispatchError.isModule
        ? (() => { const d = api.registry.findMetaError(dispatchError.asModule); return `${d.section}.${d.name}`; })()
        : dispatchError.toString();
      reject(new Error(msg));
    } else if (status.isInBlock) resolve();
  }).catch(reject);
});

const after = await api.query.system.account(ADDRESS);
console.log('balance after :', after.data.free.toString());
await api.disconnect();
