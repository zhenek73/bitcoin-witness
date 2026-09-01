/**
 * Bitcoin Witness — end-to-end demo.
 *
 * Proves one real Bitcoin UTXO all the way from exSat's index to a verified,
 * dated fact on Creditcoin, printing every hop so the path is legible in a
 * recording — and so each hop can be checked against a public explorer rather
 * than taken on trust.
 *
 *   1. read the UTXO from utxomng.xsat on EOS mainnet     (real Bitcoin data)
 *   2. relay it into exSat EVM via btcwitness::relayutxo   (native -> EVM)
 *   3. wait for the EVM transaction and its event
 *   4. wait for Attestcoin to attest that height
 *   5. generate inclusion + continuity proofs
 *   6. verify on Creditcoin and record the fact
 *
 * Steps 2 and 6 send transactions; everything else is read-only. `--dry-run`
 * walks the read-only path without spending anything.
 *
 * A note on what step 1 actually returns: exSat's Bitcoin index is a real,
 * proof-of-work-verified snapshot, but it is not currently being extended --
 * see docs/ARCHITECTURE.md "Data source". Every fact this demo proves is true
 * *as of the height printed in step 1*, and the verifier stores that height for
 * exactly that reason.
 *
 * Usage:
 *   npx tsx demo.ts --txid <btc_txid> --index <vout> [--dry-run]
 *
 * Environment for the live path:
 *   RELAYER_ACCOUNT      Antelope account holding the btcwitness contract
 *   RELAYER_PRIVATE_KEY  its active key
 *   RECEIVER_ADDRESS     BitcoinWitnessReceiver on exSat EVM
 *   VERIFIER_ADDRESS     BitcoinFactVerifier on Creditcoin
 *   EXSAT_CHAIN_KEY      chain_key from register_chain (NOT the EVM chainId)
 *   PROOF_API_URL        Attestcoin proof-generation API
 *   CREDITCOIN_KEY       key funding the Creditcoin verification transaction
 */
import { JsonRpcProvider, Contract, Wallet } from 'ethers';
import { createHash } from 'node:crypto';

const EOS_RPC = process.env.EOS_RPC ?? 'https://eos.greymass.com';
const EOS_CHAIN_ID = 'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906';
const EXSAT_EVM_RPC = process.env.EXSAT_EVM_RPC ?? 'https://evm.exsat.network/';
const CREDITCOIN_RPC = process.env.CREDITCOIN_RPC ?? 'http://127.0.0.1:9944';

const RELAYER_ACCOUNT = process.env.RELAYER_ACCOUNT ?? '';
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY ?? '';
const RECEIVER_ADDRESS = process.env.RECEIVER_ADDRESS ?? '';
const VERIFIER_ADDRESS = process.env.VERIFIER_ADDRESS ?? '';
const CREDITCOIN_KEY = process.env.CREDITCOIN_KEY ?? '';
const PROOF_API_URL = process.env.PROOF_API_URL ?? '';
const EXSAT_CHAIN_KEY = Number(process.env.EXSAT_CHAIN_KEY ?? '0');

/** ~30k gas for a bare emit; the contract enforces a 50k floor. */
const GAS_LIMIT = Number(process.env.RELAY_GAS_LIMIT ?? '80000');

const UTXOMNG = 'utxomng.xsat';
/** `byutxoid` is the third secondary index; the second is `scriptpubkey`. */
const BYUTXOID_INDEX_POSITION = 3;

const RECEIVER_ABI = [
  'event BitcoinUtxoAttested(bytes32 indexed txid, uint32 index, uint64 value, address indexed relayer)',
];
const VERIFIER_ABI = [
  'function proveBitcoinFact(uint64 height, bytes encodedTransaction, (bytes32,(bytes32,bool)[]) merkleProof, (bytes32,bytes32[]) continuityProof) returns (bytes32 txid, uint32 index, uint64 value)',
  'function getProvenValue(bytes32 txid, uint32 index) view returns (uint64 value, uint64 sourceHeight, uint64 provenAt, bool proven)',
  'event BitcoinFactProven(bytes32 indexed txid, uint32 index, uint64 value, uint64 height)',
];

interface Utxo {
  id: number;
  txid: string;
  index: number;
  scriptpubkey: string;
  value: string;
}

/**
 * Mirrors xsat::utils::compute_utxo_id — sha256 over the 36-byte Antelope
 * serialization of (checksum256 txid, uint32 index). Two things silently
 * produce "not found" rather than an error if you get them wrong: the uint32
 * must be little-endian, and the txid must be in the same byte order exSat
 * stores (see docs/ARCHITECTURE.md "txid byte order") — not the reversed form
 * block explorers display.
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
  return res.json() as Promise<{ rows: any[] }>;
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
  return rows[0] as Utxo;
}

/** How far exSat has indexed Bitcoin — worth showing, it dates the whole claim. */
async function readChainstate() {
  const { rows } = await eosTableRows({ code: UTXOMNG, scope: UTXOMNG, table: 'chainstate', limit: 1 });
  return rows[0];
}

/** Bitcoin's real tip, from a source that has nothing to do with exSat. */
async function bitcoinTip(): Promise<number | null> {
  try {
    const res = await fetch('https://blockstream.info/api/blocks/tip/height');
    return res.ok ? Number(await res.text()) : null;
  } catch {
    return null;
  }
}

/**
 * Step 2 — push `btcwitness::relayutxo` on EOS mainnet.
 *
 * Imported lazily so the read-only path (and `--dry-run`) needs no Antelope
 * dependency installed at all.
 */
async function relayOnChain(txid: string, index: number): Promise<string> {
  const { Session } = await import('@wharfkit/session');
  const { WalletPluginPrivateKey } = await import('@wharfkit/wallet-plugin-privatekey');

  const session = new Session({
    chain: { id: EOS_CHAIN_ID, url: EOS_RPC },
    actor: RELAYER_ACCOUNT,
    permission: 'active',
    walletPlugin: new WalletPluginPrivateKey(RELAYER_PRIVATE_KEY),
  });

  const result = await session.transact(
    {
      action: {
        account: RELAYER_ACCOUNT,
        name: 'relayutxo',
        authorization: [{ actor: RELAYER_ACCOUNT, permission: 'active' }],
        data: {
          txid,
          index,
          // The ABI takes `bytes`; a 20-byte EVM address without the 0x prefix.
          evm_to: RECEIVER_ADDRESS.replace(/^0x/, ''),
          gas_limit: GAS_LIMIT,
        },
      },
    },
    { broadcast: true }
  );
  return String(result.response?.transaction_id ?? result.resolved?.transaction.id ?? '');
}

/** Step 3 — find the event the relay produced on exSat EVM. */
async function waitForEvent(txid: string, fromBlock: number, timeoutMs = 120_000) {
  const provider = new JsonRpcProvider(EXSAT_EVM_RPC);
  const receiver = new Contract(RECEIVER_ADDRESS, RECEIVER_ABI, provider);
  const filter = receiver.filters.BitcoinUtxoAttested('0x' + txid);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const head = await provider.getBlockNumber();
    const logs = await receiver.queryFilter(filter, fromBlock, head);
    if (logs.length) return logs[logs.length - 1];
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(
    'no BitcoinUtxoAttested event appeared within the timeout. The most common causes, in ' +
      'order: the relay account has no BTC balance on exSat EVM to pay gas; @eosio.code is ' +
      'missing from its active permission; RECEIVER_ADDRESS is wrong.'
  );
}

function sats(value: string | number | bigint): string {
  const n = BigInt(value);
  return `${n.toLocaleString('en-US')} sats (${Number(n) / 1e8} BTC)`;
}

function requireEnv(pairs: Record<string, string>) {
  const missing = Object.entries(pairs).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Set ${missing.join(', ')} for the live path (or use --dry-run)`);
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
  console.log("[1/6] Reading the UTXO from exSat's Bitcoin index on EOS mainnet");
  const state = await readChainstate();
  const tip = await bitcoinTip();
  console.log(`      indexed to Bitcoin height ${Number(state.head_height).toLocaleString('en-US')}`);
  console.log(`      ${Number(state.num_utxos).toLocaleString('en-US')} UTXOs in the set`);
  if (tip) {
    const lag = tip - Number(state.head_height);
    console.log(
      lag > 6
        ? `      Bitcoin's tip is ${tip.toLocaleString('en-US')} — the index is ${lag.toLocaleString('en-US')} blocks behind.`
        : `      Bitcoin's tip is ${tip.toLocaleString('en-US')} — the index is current.`
    );
    if (lag > 6) console.log('      Every fact below is therefore true AS OF the indexed height, not today.');
  }

  const utxo = await readUtxo(txid, index);
  console.log(`      found: ${utxo.txid}:${utxo.index}`);
  console.log(`      value: ${sats(utxo.value)}`);
  console.log(`      utxo_id: ${computeUtxoId(txid, index)}\n`);

  if (dryRun) {
    console.log('[2/6] (skipped — dry run) relay into exSat EVM');
    console.log('[3/6] (skipped — dry run) wait for the EVM event');
    console.log('[4/6] (skipped — dry run) wait for attestation');
    console.log('[5/6] (skipped — dry run) generate proofs');
    console.log('[6/6] (skipped — dry run) verify on Creditcoin\n');
    console.log('Dry run complete: the read path works against live chain data.');
    return;
  }

  requireEnv({
    RELAYER_ACCOUNT,
    RELAYER_PRIVATE_KEY,
    RECEIVER_ADDRESS,
    VERIFIER_ADDRESS,
    CREDITCOIN_KEY,
    PROOF_API_URL,
    EXSAT_CHAIN_KEY: String(EXSAT_CHAIN_KEY || ''),
  });

  // ---- 2. native -> EVM ----------------------------------------------------
  const evmProvider = new JsonRpcProvider(EXSAT_EVM_RPC);
  const beforeBlock = await evmProvider.getBlockNumber();

  console.log('[2/6] Relaying into exSat EVM via btcwitness::relayutxo');
  const antelopeTx = await relayOnChain(txid, index);
  console.log(`      antelope tx ${antelopeTx}`);
  console.log(`      (an inline action to evm.xsat — same chain, not a bridge)\n`);

  // ---- 3. the event --------------------------------------------------------
  console.log('[3/6] Waiting for BitcoinUtxoAttested on exSat EVM');
  const log = await waitForEvent(txid, beforeBlock);
  console.log(`      evm tx ${log.transactionHash} in block ${log.blockNumber}`);
  console.log(`      relayer topic ${log.topics[2]}\n`);

  // ---- 4/5. attestation and proofs ----------------------------------------
  const { chainInfo, proofGenerator } = await import('@gluwa/cc-next-query-builder');
  const cc = new JsonRpcProvider(CREDITCOIN_RPC);
  const wallet = new Wallet(CREDITCOIN_KEY, cc);

  const info = new chainInfo.PrecompileChainInfoProvider(cc);
  const chain = await info.getSupportedChainByKey(EXSAT_CHAIN_KEY);
  if (!chain) throw new Error(`chain_key ${EXSAT_CHAIN_KEY} is not registered — run register_chain first`);
  console.log(`[4/6] Source chain ${chain.chainName} (chain_key ${chain.chainKey}, chainId ${chain.chainId})`);

  // Attestation lags the chain head, and the proof API refuses to build a proof
  // for a height it has not seen attested yet -- it answers HTTP 422
  // {"code":"BlockNotReady"}. So the wait has to come BEFORE generation, not
  // after it: a freshly relayed transaction is always a minute or two ahead of
  // the attestor, and generating first just fails immediately.
  console.log(`      waiting for height ${log.blockNumber} to be attested...`);
  // waitUntilHeightAttested has its own internal timeout (~90s) and throws when
  // it expires. Attestations land every `interval` blocks (10 here), so a run
  // that starts a few blocks short of the next attestation can time out with
  // the target only 2-3 blocks away -- observed exactly that: it gave up at
  // 59801280 while waiting for 59801283. Retry rather than failing the run.
  for (let attempt = 1; ; attempt++) {
    try {
      await info.waitUntilHeightAttested(EXSAT_CHAIN_KEY, Number(log.blockNumber));
      break;
    } catch (e) {
      if (attempt >= 8) throw e;
      console.log(`      still behind, waiting again (${attempt}/8)...`);
    }
  }
  console.log('      attested');

  console.log('      generating inclusion + continuity proofs...');
  const generator = new proofGenerator.api.ProverAPIProofGenerator(EXSAT_CHAIN_KEY, PROOF_API_URL);

  // The proof API tracks attestations through its own CC3 subscription, so it
  // can still be a beat behind the chain state we just read. Retry briefly
  // rather than failing the whole run on a few seconds of skew.
  let result = await generator.generateProof(log.transactionHash);
  for (let attempt = 1; attempt <= 10 && !result.success; attempt++) {
    console.log(`      proof API not ready yet, retrying (${attempt}/10)...`);
    await new Promise((r) => setTimeout(r, 6000));
    result = await generator.generateProof(log.transactionHash);
  }
  if (!result.success || !result.data) throw new Error(`proof generation failed: ${JSON.stringify(result)}`);
  const proof = result.data;
  console.log(`[5/6] proof at height ${proof.headerNumber}, tx index ${proof.txIndex}\n`);

  // ---- 6. proof on Creditcoin ---------------------------------------------
  console.log('[6/6] Verifying on Creditcoin');
  const verifier = new Contract(VERIFIER_ADDRESS, VERIFIER_ABI, wallet);
  const tx = await verifier.proveBitcoinFact(
    proof.headerNumber,
    proof.txBytes,
    [proof.merkleProof.root, proof.merkleProof.siblings.map((s: any) => [s.hash, s.isLeft])],
    [proof.continuityProof.lowerEndpointDigest, proof.continuityProof.roots]
  );
  const receipt = await tx.wait();
  console.log(`      creditcoin tx ${tx.hash} (gas ${receipt.gasUsed})`);

  const [value, sourceHeight, provenAt, proven] = await verifier.getProvenValue('0x' + txid, index);
  console.log('\nBitcoin fact now readable by any Creditcoin contract:');
  console.log(`  UTXO      ${txid}:${index}`);
  console.log(`  value     ${sats(value)}`);
  console.log(`  proven    ${proven} at exSat EVM height ${sourceHeight}`);
  console.log(`  recorded  ${new Date(Number(provenAt) * 1000).toISOString()}`);
  console.log('\nNo wrapping, no custodian, no bridge. The BTC never moved.');
}

main().catch((e) => {
  console.error('\n' + String(e?.message ?? e));
  process.exit(1);
});
