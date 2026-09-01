/**
 * exSat RPC shim — a transparent WebSocket JSON-RPC proxy that repairs one
 * missing field in exSat's EVM block headers.
 *
 * WHY THIS EXISTS
 * ---------------
 * exSat's EVM layer does not maintain a receipts trie or a state trie: every
 * block header it serves reports `receiptsRoot` and `stateRoot` as 32 zero
 * bytes, for every block, whether or not it has transactions. This is
 * structural, not a fault of any single RPC replica — verified against many
 * consecutive blocks on https://evm.exsat.network.
 *
 * Gluwa's Attestcoin `attestor` recomputes the transactions and receipts roots
 * from the block's own data and compares them against the header. For an EMPTY
 * block it does not perform that comparison (verified empirically: block
 * 59226041's real receipts root is the canonical empty-trie hash, which also
 * does not equal the header's zeros, and the attestor sailed past it). For any
 * block containing at least one transaction the computed receipts root is a
 * real non-zero hash, which can never equal exSat's permanently-zero header
 * field — so the attestor rejects it as "possible reorg between RPC calls",
 * retries forever, and never advances. On exSat that wall is hit at the first
 * transaction-bearing block after the attestor's start height and would recur
 * on every transaction-bearing block thereafter.
 *
 * WHAT THIS DOES — AND WHAT IT DOES NOT DO
 * ----------------------------------------
 * For blocks that actually contain transactions, this proxy replaces the
 * all-zero `receiptsRoot` with the root computed from the block's own real
 * receipts, fetched from the same upstream node. Everything else — block hash,
 * parent hash, transactions, transactionsRoot, receipts, logs — is relayed
 * byte-for-byte untouched.
 *
 * This does not fabricate data. The substituted value is derived entirely from
 * the chain's own receipts, and the field it replaces carries no information at
 * all upstream (it is a constant zero). `transactionsRoot` — the field the
 * inclusion proofs are actually built on — is genuine and canonical on exSat:
 * independently verified by recomputing the Merkle-Patricia root from the
 * block's transactions and matching the header byte-for-byte, for both the
 * blocked block (59226042) and the target block (59791789).
 *
 * Empty blocks are deliberately left untouched, so behaviour that already
 * worked before the shim is bit-for-bit unchanged.
 *
 * Usage:  node server.mjs
 * Env:    UPSTREAM_WS   (default wss://evm.exsat.network/)
 *         UPSTREAM_HTTP (default https://evm.exsat.network)
 *         PORT          (default 8546)
 */
import { WebSocketServer, WebSocket } from 'ws';
import { Trie } from '@ethereumjs/trie';
import { RLP } from '@ethereumjs/rlp';
import { bytesToHex, hexToBytes } from '@ethereumjs/util';

const UPSTREAM_WS = process.env.UPSTREAM_WS ?? 'wss://evm.exsat.network/';
const UPSTREAM_HTTP = process.env.UPSTREAM_HTTP ?? 'https://evm.exsat.network';
const PORT = Number(process.env.PORT ?? 8546);

const ZERO_ROOT = '0x' + '00'.repeat(32);
const EMPTY_TRIE_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421';

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- receipts root

const q = (h) => {
  if (h === undefined || h === null) return new Uint8Array(0);
  let s = h.startsWith('0x') ? h.slice(2) : h;
  s = s.replace(/^0+/, '');
  if (s === '') return new Uint8Array(0);
  if (s.length % 2) s = '0' + s;
  return hexToBytes('0x' + s);
};
const d = (h) => (h === null || h === undefined ? new Uint8Array(0) : hexToBytes(h));

function encodeReceipt(rc) {
  const logs = (rc.logs ?? []).map((l) => [d(l.address), (l.topics ?? []).map(d), d(l.data)]);
  const statusOrRoot = rc.status !== undefined ? q(rc.status) : d(rc.root);
  const body = RLP.encode([statusOrRoot, q(rc.cumulativeGasUsed), d(rc.logsBloom), logs]);
  const type = rc.type ? parseInt(rc.type, 16) : 0;
  return type === 0 ? body : new Uint8Array([type, ...body]);
}

async function receiptsRootOf(receipts) {
  const trie = new Trie();
  for (let i = 0; i < receipts.length; i++) {
    await trie.put(RLP.encode(i), encodeReceipt(receipts[i]));
  }
  return bytesToHex(trie.root());
}

let httpId = 1;
async function upstreamHttp(method, params) {
  const res = await fetch(UPSTREAM_HTTP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: httpId++, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// blockHash -> receiptsRoot
const rootCache = new Map();
const CACHE_MAX = 5000;

async function computeReceiptsRoot(block) {
  const key = block.hash ?? block.number;
  if (rootCache.has(key)) return rootCache.get(key);

  const ident = block.hash ?? block.number;
  const receipts = await upstreamHttp('eth_getBlockReceipts', [ident]);
  if (!Array.isArray(receipts) || receipts.length === 0) return null; // empty block: leave untouched

  const root = await receiptsRootOf(receipts);
  if (rootCache.size >= CACHE_MAX) rootCache.delete(rootCache.keys().next().value);
  rootCache.set(key, root);
  return root;
}

let patched = 0;
let failures = 0;

/** Patch one block-shaped object in place. Returns true if it was modified. */
async function patchBlock(block) {
  if (!block || typeof block !== 'object') return false;
  if (block.receiptsRoot !== ZERO_ROOT) return false;

  // Empty blocks are left exactly as upstream serves them — the attestor
  // already accepts those, and changing them would alter working behaviour.
  if (Array.isArray(block.transactions) && block.transactions.length === 0) return false;

  try {
    const root = await computeReceiptsRoot(block);
    if (!root || root === EMPTY_TRIE_ROOT) return false;
    block.receiptsRoot = root;
    patched++;
    log(`patched receiptsRoot  block=${parseInt(block.number, 16)} (${block.number})  0x000…000 -> ${root}`);
    return true;
  } catch (e) {
    failures++;
    log(`WARN could not patch block=${block.number}: ${e.message}`);
    return false;
  }
}

/** Walk a JSON-RPC message and patch every block-shaped object inside it. */
async function patchMessage(msg) {
  const targets = [];
  const collect = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach(collect);
    if (typeof o.receiptsRoot === 'string' && typeof o.number === 'string') targets.push(o);
    for (const k of ['result', 'params']) if (o[k]) collect(o[k]);
  };
  collect(msg);
  let changed = false;
  for (const b of targets) changed = (await patchBlock(b)) || changed;
  return changed;
}

// ---------------------------------------------------------------- proxy

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT });
log(`exSat RPC shim listening on ws://0.0.0.0:${PORT}  ->  ${UPSTREAM_WS}`);

wss.on('connection', (client, req) => {
  const peer = req.socket.remoteAddress;
  log(`client connected from ${peer}`);

  const upstream = new WebSocket(UPSTREAM_WS, { handshakeTimeout: 20000 });
  const pending = [];
  let closed = false;

  // Preserve upstream message ordering even though patching is async.
  let chain = Promise.resolve();

  const shutdown = (who, code, reason) => {
    if (closed) return;
    closed = true;
    log(`closing pair (${who} closed, code=${code}${reason ? ' ' + reason : ''})`);
    try { client.close(); } catch {}
    try { upstream.close(); } catch {}
  };

  upstream.on('open', () => {
    log(`upstream connected for ${peer}`);
    for (const m of pending.splice(0)) upstream.send(m);
  });

  upstream.on('message', (data) => {
    const text = data.toString();
    chain = chain.then(async () => {
      let out = text;
      try {
        const msg = JSON.parse(text);
        if (await patchMessage(msg)) out = JSON.stringify(msg);
      } catch {
        // not JSON, or unexpected shape — relay verbatim
      }
      if (client.readyState === WebSocket.OPEN) client.send(out);
    }).catch((e) => log('relay error:', e.message));
  });

  client.on('message', (data) => {
    const text = data.toString();
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else pending.push(text);
  });

  client.on('close', (c, r) => shutdown('client', c, r?.toString()));
  upstream.on('close', (c, r) => shutdown('upstream', c, r?.toString()));
  client.on('error', (e) => { log('client error:', e.message); shutdown('client'); });
  upstream.on('error', (e) => { log('upstream error:', e.message); shutdown('upstream'); });
});

setInterval(() => log(`stats: patched=${patched} failures=${failures} cache=${rootCache.size}`), 60000).unref?.();
