/**
 * Bitcoin Witness — EOS mainnet deployment.
 *
 * Does the whole sequence in one run: rotate the active key, buy RAM, and
 * deploy the contract. Each step checks the chain first and skips itself if
 * already done, so the script is safe to re-run after a partial failure.
 *
 * Keys come from a local .env that this script reads directly — they are never
 * printed, and nothing is sent anywhere except signed transactions to the RPC.
 *
 *   .env (do not commit — .gitignore covers it):
 *     OWNER_KEY=5...            # btcwitness11 owner key, only for step 1
 *     ACTIVE_KEY=5...           # the new active key, for steps after that
 *     PAYER_ACCOUNT=harvesterbot
 *     PAYER_KEY=5...            # pays for RAM
 *
 * Usage:
 *   node deploy.mjs             # run every pending step
 *   node deploy.mjs --check     # report state, change nothing
 *   node deploy.mjs --step auth # run one step: auth | ram | code
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APIClient,
  FetchProvider,
  PrivateKey,
  PublicKey,
  Serializer,
  SignedTransaction,
  Transaction,
} from '@wharfkit/antelope';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..', 'contracts', 'native', 'build');

const RPC = process.env.EOS_RPC ?? 'https://eos.greymass.com';
const ACCOUNT = 'btcwitness11';
/** The new active key, in legacy form. Verified to be the same key as
 *  PUB_K1_8RKaCw2V2u8UriTu2ZdbAGXyXbuKaaRiTwn6RTvXw5AJEmkTjX. */
const NEW_ACTIVE_PUBKEY = 'EOS8RKaCw2V2u8UriTu2ZdbAGXyXbuKaaRiTwn6RTvXw5AJFFJ1yV';
const RAM_KBYTES = 16;

// ---------------------------------------------------------------- env ------

function loadEnv() {
  const path = join(HERE, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const client = new APIClient({ provider: new FetchProvider(RPC, { fetch }) });

// ------------------------------------------------------------ helpers ------

async function getAccount(name) {
  try {
    return await client.v1.chain.get_account(name);
  } catch {
    return null;
  }
}

/** Reads what `active` currently holds, so each step can decide to skip. */
async function activeState() {
  const acc = await getAccount(ACCOUNT);
  if (!acc) throw new Error(`${ACCOUNT} does not exist on ${RPC}`);
  const active = acc.permissions.find((p) => p.perm_name.toString() === 'active');
  const keys = active.required_auth.keys.map((k) => k.key.toString());
  const accounts = active.required_auth.accounts.map(
    (a) => `${a.permission.actor}@${a.permission.permission}`
  );
  const target = PublicKey.from(NEW_ACTIVE_PUBKEY).toString();
  return {
    keys,
    accounts,
    hasNewKey: keys.some((k) => PublicKey.from(k).toString() === target),
    hasEosioCode: accounts.includes(`${ACCOUNT}@eosio.code`),
    ramFree: Number(acc.ram_quota) - Number(acc.ram_usage),
  };
}

/** An account that has never had code set carries the epoch as its
 *  last_code_update, which is a cheaper check than fetching the wasm. */
async function isDeployed() {
  const acc = await getAccount(ACCOUNT);
  const last = acc?.last_code_update?.toString() ?? '';
  return Boolean(last) && !last.startsWith('1970-01-01');
}

/** Signs and pushes. Keeps the key local to this call — never logged. */
async function push(actions, privateKeyWif) {
  const info = await client.v1.chain.get_info();
  const header = info.getTransactionHeader(120);
  const withData = await Promise.all(
    actions.map(async (a) => {
      const { abi } = await client.v1.chain.get_abi(a.account);
      return { ...a, data: Serializer.encode({ abi, type: a.name, object: a.data }) };
    })
  );
  const transaction = Transaction.from({ ...header, actions: withData });
  const key = PrivateKey.from(privateKeyWif);
  const signature = key.signDigest(transaction.signingDigest(info.chain_id));
  const signed = SignedTransaction.from({ ...transaction, signatures: [signature] });
  return client.v1.chain.push_transaction(signed);
}

function requireKey(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — put it in deploy/.env`);
  return v;
}

// -------------------------------------------------------------- steps ------

/** Step 1 — rotate the active key AND grant eosio.code in one updateauth.
 *  Doing both together avoids the trap where a later key rotation silently
 *  wipes eosio.code (updateauth replaces the permission wholesale). */
async function stepAuth() {
  const st = await activeState();
  if (st.hasNewKey && st.hasEosioCode) {
    console.log('  auth: already correct — skipping');
    return;
  }
  console.log('  auth: setting active to the new key + eosio.code');
  const res = await push(
    [
      {
        account: 'eosio',
        name: 'updateauth',
        authorization: [{ actor: ACCOUNT, permission: 'owner' }],
        data: {
          account: ACCOUNT,
          permission: 'active',
          parent: 'owner',
          auth: {
            threshold: 1,
            keys: [{ key: NEW_ACTIVE_PUBKEY, weight: 1 }],
            accounts: [
              { permission: { actor: ACCOUNT, permission: 'eosio.code' }, weight: 1 },
            ],
            waits: [],
          },
        },
      },
    ],
    requireKey('OWNER_KEY')
  );
  console.log(`  auth: done, tx ${res.transaction_id}`);
}

/** Step 2 — buy RAM. The contract has no tables of its own, so this only has
 *  to cover code + ABI; it will not grow with use. */
async function stepRam() {
  const st = await activeState();
  const wasmSize = readFileSync(join(BUILD, 'btcwitness.wasm')).length;
  const abiSize = readFileSync(join(BUILD, 'btcwitness.abi')).length;
  const needed = wasmSize + abiSize;
  if (st.ramFree > needed * 1.2) {
    console.log(`  ram: ${st.ramFree} bytes free, need ~${needed} — skipping`);
    return;
  }
  const payer = process.env.PAYER_ACCOUNT ?? 'harvesterbot';
  console.log(`  ram: buying ${RAM_KBYTES} KB for ${ACCOUNT}, paid by ${payer}`);
  const res = await push(
    [
      {
        account: 'eosio',
        name: 'buyrambytes',
        authorization: [{ actor: payer, permission: 'active' }],
        data: { payer, receiver: ACCOUNT, bytes: RAM_KBYTES * 1024 },
      },
    ],
    requireKey('PAYER_KEY')
  );
  console.log(`  ram: done, tx ${res.transaction_id}`);
}

/** Step 3 — setcode + setabi, in one transaction as cleos does. */
async function stepCode() {
  const wasm = readFileSync(join(BUILD, 'btcwitness.wasm'));
  const abiJson = JSON.parse(readFileSync(join(BUILD, 'btcwitness.abi'), 'utf8'));

  // The ABI goes on-chain in binary form, encoded against the built-in
  // abi_def type rather than shipped as JSON.
  const { abi: eosioAbi } = await client.v1.chain.get_abi('eosio');
  const encodedAbi = Serializer.encode({ object: abiJson, type: 'abi_def', abi: eosioAbi });

  console.log(`  code: deploying ${wasm.length} bytes of wasm + ABI`);
  const res = await push(
    [
      {
        account: 'eosio',
        name: 'setcode',
        authorization: [{ actor: ACCOUNT, permission: 'active' }],
        data: { account: ACCOUNT, vmtype: 0, vmversion: 0, code: wasm.toString('hex') },
      },
      {
        account: 'eosio',
        name: 'setabi',
        authorization: [{ actor: ACCOUNT, permission: 'active' }],
        data: { account: ACCOUNT, abi: encodedAbi.hexString },
      },
    ],
    requireKey('ACTIVE_KEY')
  );
  console.log(`  code: done, tx ${res.transaction_id}`);
}

// --------------------------------------------------------------- main ------

async function report() {
  const st = await activeState();
  const deployed = await isDeployed();
  console.log(`\naccount ${ACCOUNT} on ${RPC}`);
  console.log(`  active keys     : ${st.keys.join(', ') || '(none)'}`);
  console.log(`  active accounts : ${st.accounts.join(', ') || '(none)'}`);
  console.log(`  new key present : ${st.hasNewKey ? 'yes' : 'NO'}`);
  console.log(`  eosio.code      : ${st.hasEosioCode ? 'yes' : 'NO'}`);
  console.log(`  RAM free        : ${st.ramFree} bytes`);
  console.log(`  contract        : ${deployed ? 'deployed' : 'not deployed'}`);
  return st;
}

const args = process.argv.slice(2);
const only = args.includes('--step') ? args[args.indexOf('--step') + 1] : null;

if (args.includes('--check')) {
  await report();
} else {
  console.log('Bitcoin Witness — deploying to EOS mainnet\n');
  if (!only || only === 'auth') await stepAuth();
  if (!only || only === 'ram') await stepRam();
  if (!only || only === 'code') await stepCode();
  await report();
}
