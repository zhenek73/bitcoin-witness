/**
 * Deploys BitcoinWitnessReceiver.sol to exSat EVM (chain 7200).
 *
 * Reads DEPLOYER_KEY from scripts/.env (never printed). Constructor arg is
 * the reserved EVM address of btcwitness11 -- the only address allowed to
 * call receiveUtxoFact.
 *
 * Usage: node deploy_receiver.mjs
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { JsonRpcProvider, Wallet, ContractFactory } from 'ethers';
import { reservedAddress } from './reserved-address.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOL_PATH = join(HERE, '..', 'contracts', 'evm', 'BitcoinWitnessReceiver.sol');
const RPC = 'https://evm.exsat.network';
const RELAYER_ADDRESS = reservedAddress('btcwitness11');

function loadEnv() {
  const path = join(HERE, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnv();

const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
if (!DEPLOYER_KEY) {
  console.error('DEPLOYER_KEY is not set -- put it in scripts/.env');
  process.exit(1);
}

console.log('compiling BitcoinWitnessReceiver.sol...');
const source = readFileSync(SOL_PATH, 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'BitcoinWitnessReceiver.sol': { content: source } },
  settings: {
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    optimizer: { enabled: true, runs: 200 },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
if (output.errors) {
  const fatal = output.errors.filter((e) => e.severity === 'error');
  for (const e of output.errors) console.log(e.formattedMessage);
  if (fatal.length) process.exit(1);
}
const contract = output.contracts['BitcoinWitnessReceiver.sol']['BitcoinWitnessReceiver'];
const abi = contract.abi;
const bytecode = '0x' + contract.evm.bytecode.object;
console.log(`  bytecode: ${bytecode.length / 2 - 1} bytes`);

const provider = new JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 }); // this RPC 400s on batched JSON-RPC requests
const wallet = new Wallet(DEPLOYER_KEY, provider);
console.log(`deployer: ${wallet.address}`);
const balance = await provider.getBalance(wallet.address);
console.log(`deployer balance: ${balance} wei`);

const factory = new ContractFactory(abi, bytecode, wallet);
console.log(`deploying, relayer = ${RELAYER_ADDRESS} ...`);
const deployed = await factory.deploy(RELAYER_ADDRESS);
const receipt = await deployed.deploymentTransaction().wait();
console.log(`  deployed at: ${await deployed.getAddress()}`);
console.log(`  tx: ${receipt.hash}`);
console.log(`  gas used: ${receipt.gasUsed}`);

writeFileSync(
  join(HERE, 'receiver-deployment.json'),
  JSON.stringify(
    { address: await deployed.getAddress(), txHash: receipt.hash, relayer: RELAYER_ADDRESS, abi },
    null,
    2
  )
);
console.log('wrote scripts/receiver-deployment.json');
