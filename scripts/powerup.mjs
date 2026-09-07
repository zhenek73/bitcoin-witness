/**
 * Rent CPU and NET for the relay account for one day.
 *
 * `btcwitness11` cannot push a transaction right now: `get_account` reports
 * cpu_limit.max = 0 and net_limit.available = 0. Staking is no longer how EOS
 * hands out CPU -- the account has 1.0000 EOS staked to CPU and still gets
 * nothing -- so resources have to be rented from the PowerUp market, one day at
 * a time. A relay costs about 2.6 ms of CPU and 160 bytes of NET, so the
 * defaults below rent roughly two hundred relays' worth and still round down to
 * the market's minimum fee.
 *
 * The account's liquid balance lives in `core.vaulta`'s A token, not in
 * `eosio.token`'s EOS (the Vaulta rebrand moved it), so the action is pushed to
 * core.vaulta -- pushing `eosio::powerup` would fail with "overdrawn balance"
 * against an EOS balance of zero while 4 A sits untouched.
 *
 * Usage:
 *   node --env-file=.env powerup.mjs             # print the plan, send nothing
 *   node --env-file=.env powerup.mjs --confirm   # sign and push
 *
 * Options:
 *   --cpu-ms <n>        CPU to rent, in milliseconds        (default 500)
 *   --net-kb <n>        NET to rent, in kilobytes           (default 200)
 *   --max-payment <a>   hard cap on what may be spent       (default 0.5000 A)
 *
 * Environment:
 *   RELAYER_ACCOUNT      the Antelope account to power up
 *   RELAYER_PRIVATE_KEY  its active key
 *   EOS_RPC              optional; defaults to greymass
 */
import { Session } from '@wharfkit/session';
import { WalletPluginPrivateKey } from '@wharfkit/wallet-plugin-privatekey';
import { APIClient, FetchProvider } from '@wharfkit/antelope';

const EOS_RPC = process.env.EOS_RPC ?? 'https://eos.greymass.com';
const EOS_CHAIN_ID = 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906';
const ACCOUNT = process.env.RELAYER_ACCOUNT ?? '';
const KEY = process.env.RELAYER_PRIVATE_KEY ?? '';

/** The PowerUp market expresses a rental as a fraction of the day's total
 *  capacity, where 10^15 is the whole market. */
const FRAC_UNIT = 10n ** 15n;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}

const CPU_MS = Number(arg('--cpu-ms', '500'));
const NET_KB = Number(arg('--net-kb', '200'));
const MAX_PAYMENT = arg('--max-payment', '0.5000 A');
const CONFIRM = process.argv.includes('--confirm');

function fmt(n) { return Number(n).toLocaleString('en-US'); }

/** frac = desired / market total, expressed in FRAC_UNIT. Rounded up, and never
 *  zero: a zero fraction is accepted by the ABI and rents nothing. */
function fracFor(desiredUnits, marketWeight) {
  const f = (BigInt(Math.ceil(desiredUnits)) * FRAC_UNIT) / BigInt(marketWeight) + 1n;
  return f > 0n ? f : 1n;
}

async function main() {
  if (!ACCOUNT || !KEY) {
    console.error('RELAYER_ACCOUNT and RELAYER_PRIVATE_KEY must be set.');
    console.error('Run this with the same env the demo uses: node --env-file=.env powerup.mjs');
    process.exit(1);
  }

  const client = new APIClient({ provider: new FetchProvider(EOS_RPC) });

  const before = await client.v1.chain.get_account(ACCOUNT);
  console.log(`account   ${ACCOUNT}`);
  console.log(`cpu       ${fmt(before.cpu_limit.available)} us available of ${fmt(before.cpu_limit.max)} max`);
  console.log(`net       ${fmt(before.net_limit.available)} bytes available of ${fmt(before.net_limit.max)} max`);

  const balances = await client.v1.chain.get_currency_balance('core.vaulta', ACCOUNT, 'A');
  console.log(`balance   ${balances.length ? balances.join(', ') : '0 A'}`);

  const state = await client.v1.chain.get_table_rows({
    code: 'eosio', scope: '', table: 'powup.state', limit: 1, json: true
  });
  const market = state.rows?.[0];
  if (!market) throw new Error('eosio powup.state returned no row -- cannot price a rental');

  const cpuFrac = fracFor(CPU_MS * 1000, market.cpu.weight);
  const netFrac = fracFor(NET_KB * 1024, market.net.weight);

  console.log('');
  console.log(`renting   ${fmt(CPU_MS)} ms CPU  (cpu_frac ${cpuFrac})`);
  console.log(`          ${fmt(NET_KB)} KB NET  (net_frac ${netFrac})`);
  console.log(`for       ${market.powerup_days} day(s), paying at most ${MAX_PAYMENT}`);
  console.log(`market    minimum fee ${market.min_powerup_fee}`);

  if (!CONFIRM) {
    console.log('');
    console.log('Nothing was sent. Re-run with --confirm to sign and push.');
    return;
  }

  const session = new Session({
    actor: ACCOUNT,
    permission: 'active',
    chain: { id: EOS_CHAIN_ID, url: EOS_RPC },
    walletPlugin: new WalletPluginPrivateKey(KEY)
  });

  const result = await session.transact({
    action: {
      account: 'core.vaulta',
      name: 'powerup',
      authorization: [{ actor: ACCOUNT, permission: 'active' }],
      data: {
        payer: ACCOUNT,
        receiver: ACCOUNT,
        days: market.powerup_days,
        net_frac: netFrac.toString(),
        cpu_frac: cpuFrac.toString(),
        max_payment: MAX_PAYMENT
      }
    }
  });

  const txid = result.resolved?.transaction?.id ?? result.response?.transaction_id;
  console.log('');
  console.log(`pushed    ${txid}`);

  /* The chain applies the rental in the same block, but get_account is served
     from the node's current state -- give it one block before reading back. */
  await new Promise((r) => setTimeout(r, 1500));
  const after = await client.v1.chain.get_account(ACCOUNT);
  console.log(`cpu       ${fmt(after.cpu_limit.available)} us available of ${fmt(after.cpu_limit.max)} max`);
  console.log(`net       ${fmt(after.net_limit.available)} bytes available of ${fmt(after.net_limit.max)} max`);

  if (Number(after.cpu_limit.available) <= 0) {
    console.log('');
    console.log('CPU is still zero. Raise --cpu-ms and try again -- the rental was too small to register.');
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
