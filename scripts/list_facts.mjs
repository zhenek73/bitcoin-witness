/**
 * Lists every Bitcoin fact currently recorded by BitcoinFactVerifier on the
 * local Creditcoin devnet, newest last. Used to pick reserve outpoints for
 * ReserveGuard without guessing.
 *
 * Usage: node list_facts.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Contract } from 'ethers';

const HERE = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.CREDITCOIN_RPC ?? 'http://127.0.0.1:9944';

const dep = JSON.parse(readFileSync(join(HERE, 'verifier-deployment.json'), 'utf8'));
const provider = new JsonRpcProvider(RPC);
const verifier = new Contract(dep.address, dep.abi, provider);

const head = await provider.getBlockNumber();
console.log(`verifier ${dep.address}  head ${head}`);

const logs = await verifier.queryFilter(verifier.filters.BitcoinFactProven(), 0, head);
if (logs.length === 0) {
  console.log('no facts proven yet');
  process.exit(0);
}

for (const l of logs) {
  const { txid, index, value, height } = l.args;
  const [, , provenAt, proven] = await verifier.getProvenValue(txid, index);
  const age = Math.floor(Date.now() / 1000) - Number(provenAt);
  console.log(
    `block ${l.blockNumber}  ${txid}:${index}  ${value} sats  srcHeight ${height}  ` +
      `provenAt ${provenAt} (${age}s ago)  proven=${proven}`
  );
}
