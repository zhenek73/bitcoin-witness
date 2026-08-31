/**
 * One-time: register btcwitness11 with exSat's evm.xsat runtime via the
 * `open` action, so its reserved EVM address can send transactions (the
 * relay call fails with "caller account has not been opened" until this
 * runs once).
 *
 * Reads RELAYER_PRIVATE_KEY from scripts/.env.
 * Usage: node open_evm_account.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const path = join(HERE, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const RELAYER_ACCOUNT = process.env.RELAYER_ACCOUNT;
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY;
if (!RELAYER_ACCOUNT || !RELAYER_PRIVATE_KEY) {
  console.error('Set RELAYER_ACCOUNT and RELAYER_PRIVATE_KEY in scripts/.env');
  process.exit(1);
}

const { Session } = await import('@wharfkit/session');
const { WalletPluginPrivateKey } = await import('@wharfkit/wallet-plugin-privatekey');

const EOS_RPC = 'https://eos.greymass.com';
const EOS_CHAIN_ID = 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906';

const session = new Session({
  chain: { id: EOS_CHAIN_ID, url: EOS_RPC },
  actor: RELAYER_ACCOUNT,
  permission: 'active',
  walletPlugin: new WalletPluginPrivateKey(RELAYER_PRIVATE_KEY),
});

console.log(`opening evm.xsat account for ${RELAYER_ACCOUNT}...`);
const result = await session.transact({
  action: {
    account: 'evm.xsat',
    name: 'open',
    authorization: [{ actor: RELAYER_ACCOUNT, permission: 'active' }],
    data: { owner: RELAYER_ACCOUNT },
  },
});
console.log(`  done, tx ${result.resolved?.transaction.id ?? result.response?.transaction_id}`);
