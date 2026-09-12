/**
 * Bitcoin Witness -- runtime solvency demo.
 *
 * Shows the invariant `wrapped supply <= proven Bitcoin reserves` being
 * enforced as a precondition of the mint transaction, using a reserve balance
 * proven from Bitcoin itself through exSat and Attestcoin.
 *
 * Five beats, in order:
 *   1. the issuer declares a Bitcoin outpoint as reserve
 *   2. a backed mint succeeds
 *   3. an unbacked mint REVERTS -- on chain, in the mint transaction
 *   4. the same unbacked mint on an unguarded token SUCCEEDS (the control:
 *      this is how wrapped BTC is issued today)
 *   5. reserve proof allowed to go stale -> reserves stop counting -> even a
 *      small mint is refused, showing the failure direction is conservative
 *
 * Requires scripts/verifier-deployment.json and scripts/guard-deployment.json,
 * and at least one fact already proven by the pipeline (run demo.ts first).
 *
 * Usage: node demo_solvency.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet, Contract, Interface } from 'ethers';

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.CREDITCOIN_RPC ?? 'http://127.0.0.1:9944';
const KEY =
  process.env.CREDITCOIN_KEY ??
  '0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133';

const vdep = JSON.parse(readFileSync(join(HERE, 'verifier-deployment.json'), 'utf8'));
const gdep = JSON.parse(readFileSync(join(HERE, 'guard-deployment.json'), 'utf8'));

const provider = new JsonRpcProvider(RPC);
const wallet = new Wallet(KEY, provider);

const verifier = new Contract(vdep.address, vdep.abi, wallet);
const guard = new Contract(gdep.reserveGuard, gdep.abis.ReserveGuard, wallet);
const guarded = new Contract(gdep.guardedWBTC, gdep.abis.GuardedWBTC, wallet);
const naive = new Contract(gdep.naiveWBTC, gdep.abis.NaiveWBTC, wallet);
const guardErrors = new Interface(gdep.abis.ReserveGuard);

const btc = (sats) => (Number(sats) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 });
const rule = (s = '') => console.log('\n' + '-'.repeat(74) + (s ? `\n${s}` : ''));

/** Pull a custom-error name out of whatever shape ethers hands back. */
function decodeRevert(e) {
  const data =
    e?.data ?? e?.info?.error?.data ?? e?.error?.data ?? e?.revert?.data ?? e?.receipt?.data;
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    try {
      const parsed = guardErrors.parseError(data);
      if (parsed) {
        const args = parsed.args.map((a) => a.toString());
        return { name: parsed.name, args };
      }
    } catch {
      /* fall through */
    }
  }
  return { name: e?.shortMessage ?? e?.message ?? 'revert', args: [] };
}

async function printSolvency(label) {
  const [reserves, supply, counted, stale, solvent] = await guard.solvency();
  console.log(
    `${label}\n` +
      `    proven reserve : ${btc(reserves)} BTC  (${counted} outpoint(s) counted, ${stale} ignored)\n` +
      `    wrapped supply : ${btc(supply)} gwBTC\n` +
      `    solvent        : ${solvent ? 'YES' : 'NO'}`
  );
  return { reserves, supply, counted, stale, solvent };
}

// ---------------------------------------------------------------- beat 1

console.log('Bitcoin Witness -- runtime solvency guard');
console.log(`  Creditcoin RPC : ${RPC}`);
console.log(`  verifier       : ${vdep.address}`);
console.log(`  ReserveGuard   : ${gdep.reserveGuard}  (maxFactAge ${gdep.maxFactAge}s)`);
console.log(`  GuardedWBTC    : ${gdep.guardedWBTC}`);
console.log(`  NaiveWBTC      : ${gdep.naiveWBTC}`);

rule('[1] Issuer declares its Bitcoin reserve');

const head = await provider.getBlockNumber();
const proven = await verifier.queryFilter(verifier.filters.BitcoinFactProven(), 0, head);
if (proven.length === 0) {
  console.log('No Bitcoin facts proven yet. Run demo.ts first.');
  process.exit(1);
}

const seen = new Set();
const outpoints = [];
for (const l of proven) {
  const k = `${l.args.txid}:${l.args.index}`;
  if (seen.has(k)) continue;
  seen.add(k);
  outpoints.push({ txid: l.args.txid, index: Number(l.args.index) });
}

const already = Number(await guard.reserveCount());
if (already === 0) {
  for (const o of outpoints) {
    const tx = await guard.declareReserve(o.txid, o.index);
    await tx.wait();
    const [value, srcHeight, provenAt] = await verifier.getProvenValue(o.txid, o.index);
    const age = Math.floor(Date.now() / 1000) - Number(provenAt);
    console.log(
      `  declared ${o.txid}:${o.index}\n` +
        `    ${btc(value)} BTC, proven from exSat height ${srcHeight}, ${age}s old`
    );
  }
} else {
  console.log(`  ${already} outpoint(s) already declared`);
}

const before = await printSolvency('\n  state:');
if (before.reserves === 0n) {
  console.log(
    '\n  Reserve is declared but counts as zero: every proof is older than the\n' +
      '  freshness window. Re-run demo.ts to re-prove the reserve, then run this\n' +
      '  script again. (That is beat 5 happening early -- the guard fails closed.)'
  );
  process.exit(0);
}

// ---------------------------------------------------------------- beat 2

rule('[2] A backed mint -- should succeed');

const honest = before.reserves / 5n; // mint against 20% of proven reserve
console.log(`  issuer mints ${btc(honest)} gwBTC against ${btc(before.reserves)} BTC proven`);
const mintTx = await guarded.mint(wallet.address, honest);
const mintRc = await mintTx.wait();
console.log(`  OK  tx ${mintRc.hash}  gas ${mintRc.gasUsed}`);
await printSolvency('\n  state:');

// ---------------------------------------------------------------- beat 3

rule('[3] An unbacked mint -- the attacker case');

const attack = before.reserves * 1000n;
console.log(`  attacker reaches the mint path and asks for ${btc(attack)} gwBTC`);
try {
  const tx = await guarded.mint(wallet.address, attack);
  await tx.wait();
  console.log('  !!! MINT SUCCEEDED -- the guard did not hold. This is a bug.');
  process.exitCode = 1;
} catch (e) {
  const { name, args } = decodeRevert(e);
  console.log(`  REVERTED: ${name}`);
  if (name === 'Insolvent') {
    console.log(
      `    supply would become : ${btc(args[0])} gwBTC\n` +
        `    proven reserve      : ${btc(args[1])} BTC\n` +
        `    outpoints ignored   : ${args[2]} (unproven or stale)`
    );
  }
  console.log('  The tokens were never created. Nothing to launder, nothing to exit with.');
}
await printSolvency('\n  state (unchanged):');

// ---------------------------------------------------------------- beat 4

rule('[4] The control: the same attack on an unguarded token');

console.log(`  attacker asks NaiveWBTC for the same ${btc(attack)} nwBTC`);
const nTx = await naive.mint(wallet.address, attack);
const nRc = await nTx.wait();
const nSupply = await naive.totalSupply();
console.log(`  MINTED  tx ${nRc.hash}`);
console.log(`    nwBTC supply       : ${btc(nSupply)}`);
console.log(`    Bitcoin backing it : ${btc(before.reserves)}`);
console.log(
  `    unbacked           : ${btc(nSupply - before.reserves)}\n` +
    '  No revert, no alert, no error. A valid transaction by every rule the\n' +
    '  chain knows -- because the chain does not know what the reserve is.\n' +
    '  This is how wrapped BTC is issued today.'
);

// ---------------------------------------------------------------- beat 5

rule('[5] Stale proof -- the guard fails closed');

console.log('  issuer stops re-proving reserves (simulated: freshness window -> 1s)');
await (await guard.setMaxFactAge(1)).wait();
const stale = await printSolvency('\n  state:');
console.log(
  `\n  The Bitcoin is still there. The PROOF is old, so it stops counting.\n` +
    '  Try to mint one single satoshi:'
);
try {
  const tx = await guarded.mint(wallet.address, 1n);
  await tx.wait();
  console.log('  !!! SUCCEEDED -- unexpected.');
  process.exitCode = 1;
} catch (e) {
  const { name, args } = decodeRevert(e);
  console.log(`  REVERTED: ${name}${name === 'Insolvent' ? ` (reserve counted: ${btc(args[1])} BTC)` : ''}`);
  console.log(
    '  Latency makes this stricter, never more permissive. An unproven deposit\n' +
      '  is simply not counted, so the error direction is always conservative.'
  );
}

console.log(`\n  restoring freshness window to ${gdep.maxFactAge}s`);
await (await guard.setMaxFactAge(gdep.maxFactAge)).wait();
void stale;

rule('Done.');
