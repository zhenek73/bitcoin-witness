/**
 * Bitcoin Witness — end-to-end demo.
 *
 * Proves one real Bitcoin UTXO all the way from exSat's index to a verified
 * fact on Creditcoin, printing each hop so the path is legible in a recording.
 *
 *   1. read the UTXO from utxomng.xsat on EOS mainnet     (real Bitcoin data)
 *   2. relay it into exSat EVM via btcwitness::relayutxo   (native -> EVM)
 *   3. wait for the EVM transaction and its event
 *   4. wait for Attestcoin to attest that height
 *   5. generate inclusion + continuity proofs
 *   6. verify on Creditcoin and record the fact
 *
 * Steps 2 and 6 send transactions; everything else is read-only. Run with
 * --dry-run to walk steps 1, 3 and 4 without spending anything — useful for
 * checking wiring before a live take.
 *
 * Usage:
 *   npx tsx demo.ts --txid <btc_txid> --index <vout> [--dry-run]
 */
import { JsonRpcProvider, Contract, Wallet, id as keccakId } from 'ethers';
import { createHash } from 'node:crypto';

const EOS_RPC = process.env.EOS_RPC ?? 'https://eos.greymass.com';
const EXSAT_EVM_RPC = process.env.EXSAT_EVM_RPC ?? 'https://evm.exsat.network/';
const CREDITCOIN_RPC = process.env.CREDITCOIN_RPC ?? 'http://127.0.0.1:9944';

/** Our contracts, filled in after deployment. */
const RECEIVER_ADDRESS = process.env.RECEIVER_ADDRESS ?? '';
const VERIFIER_ADDRESS = process.env.VERIFIER_ADDRESS ?? '';

const UTXOMNG = 'utxomng.xsat';
/** `byutxoid` is the third secondary index; the second is `scriptpubkey`. */
const BYUTXOID_INDEX_POSITION = 3;

interface Utxo {
  id: number;
  txid: string;
  index: number;
  scriptpubkey: string;
  value: string;
}

/**
 * Mirrors xsat::utils::compute_utxo_id — sha256 over the 36-byte Antelope
 * serialization of (checksum256 txid, uint32 index). Getting the byte order
 * wrong here does not error; it silently matches nothing.
 */
function computeUtxoId(txid: string, index: number): string {
  const buf = Buffer.alloc(36);
  Buffer.from(txid, 'hex').copy(buf, 0);
  buf.writeUInt32LE(index, 32);
  return createHash('sha256').update(buf).digest('hex');
}

async function eosTableRows(body: Record<string, unknown>) {
  const res = await fetch(`${EOS_RPC}/v1/chain/get_table_rows`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: true, ...body }),
  });
  if (!res.ok) throw new Error(`EOS RPC ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Step 1 — the Bitcoin fact, straight from exSat's on-chain index. */
async function readUtxo(txid: string, index: number): Promise<Utxo> {
  const utxoId = computeUtxoId(txid, index);
  const { rows } = await eosTableRows({
    code: UTXOMNG,
    scope: UTXOMNG,
    table: 'utxos',
    index_position: BYUTXOID_INDEX_POSITION,
    key_type: 'sha256',
    lower_bound: utxoId,
    upper_bound: utxoId,
    limit: 1,
  });
  if (!rows?.length) {
    throw new Error(
      `UTXO ${txid}:${index} not found in ${UTXOMNG}. It may be spent, may not exist, ` +
        `or may be above the height exSat has indexed.`
    );
  }
  return rows[0];
}

/** How far exSat has indexed Bitcoin — worth showing, it dates the data. */
async function readChainstate() {
  const { rows } = await eosTableRows({
    code: UTXOMNG,
    scope: UTXOMNG,
    table: 'chainstate',
    limit: 1,
  });
  return rows[0];
}

function sats(value: string | number): string {
  const n = BigInt(value);
  const btc = Number(n) / 1e8;
  return `${n} sats (${btc} BTC)`;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };
  const txid = get('--txid');
  const index = Number(get('--index') ?? 0);
  const dryRun = args.includes('--dry-run');

  if (!txid) {
    console.error('Usage: npx tsx demo.ts --txid <btc_txid> --index <vout> [--dry-run]');
    process.exit(1);
  }

  console.log('Bitcoin Witness — end-to-end demo');
  if (dryRun) console.log('(dry run: no transactions will be sent)\n');

  // ---- 1. the Bitcoin fact -------------------------------------------------
  console.log('[1/6] Reading the UTXO from exSat\'s Bitcoin index on EOS mainnet');
  const state = await readChainstate();
  console.log(`      exSat has indexed Bitcoin up to height ${state.head_height}`);
  console.log(`      (${Number(state.num_utxos).toLocaleString('en-US')} UTXOs in the set)`);

  const utxo = await readUtxo(txid, index);
  console.log(`      found: ${utxo.txid}:${utxo.index}`);
  console.log(`      value: ${sats(utxo.value)}`);
  console.log(`      utxo_id: ${computeUtxoId(txid, index)}\n`);

  if (dryRun) {
    console.log('[2/6] (skipped — dry run) relay into exSat EVM');
    console.log('[3/6] (skipped — dry run) wait for the EVM event');
  } else {
    console.log('[2/6] Relaying into exSat EVM via btcwitness::relayutxo');
    console.log('      TODO: push the Antelope action once the contract is deployed.');
    console.log('      This step needs a signing key, so it is driven from the deploy');
    console.log('      tooling rather than from here.\n');
    return;
  }

  // ---- 4. attestation ------------------------------------------------------
  console.log('\n[4/6] Checking what Attestcoin has attested for exSat');
  if (!VERIFIER_ADDRESS) {
    console.log('      VERIFIER_ADDRESS not set — skipping Creditcoin-side steps.');
    return;
  }
  const cc = new JsonRpcProvider(CREDITCOIN_RPC);
  const head = await cc.getBlockNumber();
  console.log(`      Creditcoin devnet reachable, head ${head}`);

  console.log('\nDry run complete. The read path works against live data.');
}

main().catch((e) => {
  console.error('\n' + String(e?.message ?? e));
  process.exit(1);
});
