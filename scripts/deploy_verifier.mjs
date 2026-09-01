/**
 * Deploys BitcoinFactVerifier.sol to the local Creditcoin (CC3) devnet's
 * embedded Frontier EVM.
 *
 * Reads CREDITCOIN_KEY from scripts/.env. On a fresh `docker compose up -d cc3`
 * devnet this is the well-known Moonbeam/frontier-template dev account
 * ("Alith"), which the CC3 --dev chain pre-funds at genesis --
 * 0xf24FF3a9CF04c71Dbc94D0b566f7A27B94566cac / key
 * 0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133.
 * This key is public and well-known -- fine for a local devnet, never for a
 * real network.
 *
 * Constructor args:
 *   exsatChainKey   -- chain_key assigned by register_chain (NOT the EVM chainId)
 *   expectedEmitter -- BitcoinWitnessReceiver address on exSat EVM
 *   expectedRelayer -- reserved EVM address of the btcwitness11 Antelope account
 *
 * Usage: node deploy_verifier.mjs
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { JsonRpcProvider, Wallet, ContractFactory, getAddress } from 'ethers';
import { reservedAddress } from './reserved-address.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOL_PATH = join(HERE, '..', 'contracts', 'asc', 'BitcoinFactVerifier.sol');
const RPC = process.env.CREDITCOIN_RPC ?? 'http://127.0.0.1:9944';

const EXSAT_CHAIN_KEY = Number(process.env.EXSAT_CHAIN_KEY ?? '7');
const EXPECTED_EMITTER = getAddress(
  process.env.RECEIVER_ADDRESS ?? '0xBF823785C5749532AE927d7285093Eae279fe16C'
);
const EXPECTED_RELAYER = getAddress(
  process.env.RELAYER_ADDRESS ?? reservedAddress('btcwitness11')
);

function loadEnv() {
  const path = join(HERE, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const CREDITCOIN_KEY =
  process.env.CREDITCOIN_KEY ??
  '0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133';

console.log('compiling BitcoinFactVerifier.sol...');
const source = readFileSync(SOL_PATH, 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'BitcoinFactVerifier.sol': { content: source } },
  settings: {
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
if (output.errors) {
  const fatal = output.errors.filter((e) => e.severity === 'error');
  for (const e of output.errors) console.log(e.formattedMessage);
  if (fatal.length) process.exit(1);
}
const contract = output.contracts['BitcoinFactVerifier.sol']['BitcoinFactVerifier'];
const abi = contract.abi;
const bytecode = '0x' + contract.evm.bytecode.object;
console.log(`  bytecode: ${bytecode.length / 2 - 1} bytes`);

const provider = new JsonRpcProvider(RPC);
const wallet = new Wallet(CREDITCOIN_KEY, provider);
console.log(`deployer: ${wallet.address}`);
const balance = await provider.getBalance(wallet.address);
console.log(`deployer balance: ${balance} wei`);
const net = await provider.getNetwork();
console.log(`chainId: ${net.chainId}`);

const factory = new ContractFactory(abi, bytecode, wallet);
console.log(
  `deploying, chainKey=${EXSAT_CHAIN_KEY} emitter=${EXPECTED_EMITTER} relayer=${EXPECTED_RELAYER} ...`
);
const deployed = await factory.deploy(EXSAT_CHAIN_KEY, EXPECTED_EMITTER, EXPECTED_RELAYER);
const receipt = await deployed.deploymentTransaction().wait();
console.log(`  deployed at: ${await deployed.getAddress()}`);
console.log(`  tx: ${receipt.hash}`);
console.log(`  gas used: ${receipt.gasUsed}`);

writeFileSync(
  join(HERE, 'verifier-deployment.json'),
  JSON.stringify(
    {
      address: await deployed.getAddress(),
      txHash: receipt.hash,
      exsatChainKey: EXSAT_CHAIN_KEY,
      expectedEmitter: EXPECTED_EMITTER,
      expectedRelayer: EXPECTED_RELAYER,
      creditcoinRpc: RPC,
      abi,
    },
    null,
    2
  )
);
console.log('wrote scripts/verifier-deployment.json');
