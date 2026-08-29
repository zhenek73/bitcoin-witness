/**
 * Bitcoin Witness — proof generation and submission.
 *
 * Takes a transaction on exSat's EVM layer in which our BitcoinWitnessReceiver
 * emitted `BitcoinUtxoAttested`, waits for that block height to be attested,
 * generates the inclusion + continuity proofs, and submits them to
 * `BitcoinFactVerifier.proveBitcoinFact` on Creditcoin — which verifies them
 * through the BlockProver precompile and records the Bitcoin fact.
 *
 * Two things worth knowing before running this:
 *   - A height must be *attested* before it can be proven. Attestation lags the
 *     chain head, so a freshly mined transaction is not immediately provable;
 *     the script waits rather than failing.
 *   - Continuity proofs are bound to attestation state at generation time and
 *     go stale. This script generates one and submits it immediately; don't
 *     cache proofs between runs.
 *
 * Usage:
 *   EXSAT_CHAIN_KEY=<n> VERIFIER_ADDRESS=0x... PROOF_API_URL=https://... \
 *   yarn prove_fact <tx_hash> <creditcoin_rpc_url> <private_key>
 */
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { chainInfo, proofGenerator } from '@gluwa/cc-next-query-builder';

/** Attestcoin chain_key assigned to our exSat source chain by `register_chain`.
 *  NOT the EVM chainId — the two differ, and mixing them up produces a source
 *  check that silently never matches. */
const EXSAT_CHAIN_KEY = Number(process.env.EXSAT_CHAIN_KEY ?? '0');

/** Our BitcoinFactVerifier, deployed on Creditcoin. */
const VERIFIER_ADDRESS = process.env.VERIFIER_ADDRESS ?? '';

/** Proof generation API. Gluwa runs one for their testnet; a self-hosted
 *  Creditcoin devnet runs its own (see the `proof-gen-api-server` crate). */
const PROOF_API_URL = process.env.PROOF_API_URL ?? '';

const VERIFIER_ABI = [
  'function proveBitcoinFact(uint64 height, bytes encodedTransaction, (bytes32,(bytes32,bool)[]) merkleProof, (bytes32,bytes32[]) continuityProof) returns (bytes32 txid, uint32 index, uint64 value)',
  'function getProvenValue(bytes32 txid, uint32 index) view returns (uint64 value, uint64 sourceHeight, uint64 provenAt, bool proven)',
  'event BitcoinFactProven(bytes32 indexed txid, uint32 index, uint64 value, uint64 height)',
];

async function main() {
  const [txHash, creditcoinRpc, privateKey] = process.argv.slice(2);
  if (!txHash || !creditcoinRpc || !privateKey) {
    console.error(
      'Usage: yarn prove_fact <tx_hash> <creditcoin_rpc_url> <private_key>'
    );
    process.exit(1);
  }
  if (!EXSAT_CHAIN_KEY) throw new Error('Set EXSAT_CHAIN_KEY (from register_chain, not the EVM chainId)');
  if (!VERIFIER_ADDRESS) throw new Error('Set VERIFIER_ADDRESS');
  if (!PROOF_API_URL) throw new Error('Set PROOF_API_URL');

  const provider = new JsonRpcProvider(creditcoinRpc);
  const wallet = new Wallet(privateKey, provider);

  // Confirm our chain is actually registered before doing anything else —
  // a wrong chain_key otherwise surfaces much later as an opaque failure.
  const info = new chainInfo.PrecompileChainInfoProvider(provider);
  const chain = await info.getSupportedChainByKey(EXSAT_CHAIN_KEY);
  if (!chain) {
    throw new Error(
      `chain_key ${EXSAT_CHAIN_KEY} is not registered on this Creditcoin network. ` +
        `Run register_chain first, or check the key.`
    );
  }
  console.log(`Source chain: ${chain.chainName} (chain_key ${chain.chainKey}, chainId ${chain.chainId})`);

  console.log('Generating proof...');
  const generator = new proofGenerator.api.ProverAPIProofGenerator(EXSAT_CHAIN_KEY, PROOF_API_URL);
  const result = await generator.generateProof(txHash);
  if (!result.success || !result.data) {
    throw new Error(`Proof generation failed: ${JSON.stringify(result)}`);
  }
  const proof = result.data;
  console.log(`  height=${proof.headerNumber} txIndex=${proof.txIndex}`);

  // Attestation lags the head; proving before the height is attested fails.
  console.log('Waiting for height to be attested...');
  await info.waitUntilHeightAttested(EXSAT_CHAIN_KEY, proof.headerNumber);

  console.log('Submitting proof to BitcoinFactVerifier...');
  const verifier = new Contract(VERIFIER_ADDRESS, VERIFIER_ABI, wallet);
  const tx = await verifier.proveBitcoinFact(
    proof.headerNumber,
    proof.txBytes,
    [proof.merkleProof.root, proof.merkleProof.siblings.map((s: any) => [s.hash, s.isLeft])],
    [proof.continuityProof.lowerEndpointDigest, proof.continuityProof.roots]
  );
  const receipt = await tx.wait();
  console.log(`  proven in ${tx.hash} (gas used: ${receipt.gasUsed})`);

  const parsed = receipt.logs
    .map((l: any) => {
      try {
        return verifier.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l: any) => l?.name === 'BitcoinFactProven');

  if (parsed) {
    const { txid, index, value } = parsed.args;
    console.log(`\nBitcoin fact proven on Creditcoin:`);
    console.log(`  UTXO ${txid}:${index} holds ${value} sats`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
