/**
 * Deploys the solvency layer to the local Creditcoin (CC3) devnet:
 *
 *   ReserveGuard  -- reads Bitcoin reserve facts from BitcoinFactVerifier and
 *                    refuses any mint that would push wrapped supply above them
 *   GuardedWBTC   -- wrapped BTC whose mint path consults the guard
 *   NaiveWBTC     -- the same token without the guard, deployed as the control
 *                    case so the difference can be demonstrated rather than
 *                    asserted
 *
 * Requires scripts/verifier-deployment.json (written by deploy_verifier.mjs).
 *
 * Env:
 *   MAX_FACT_AGE    freshness window in seconds (default 21600 = 6h)
 *   CREDITCOIN_RPC  default http://127.0.0.1:9944
 *   CREDITCOIN_KEY  deployer key (default: the well-known CC3 --dev account)
 *
 * Usage: node deploy_guard.mjs
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { JsonRpcProvider, Wallet, ContractFactory, Contract } from 'ethers';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = join(HERE, '..', 'contracts', 'asc');
const RPC = process.env.CREDITCOIN_RPC ?? 'http://127.0.0.1:9944';
const MAX_FACT_AGE = Number(process.env.MAX_FACT_AGE ?? '21600');

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

const verifierDep = JSON.parse(readFileSync(join(HERE, 'verifier-deployment.json'), 'utf8'));

console.log('compiling ReserveGuard.sol + WrappedBTC.sol ...');
const input = {
  language: 'Solidity',
  sources: {
    'ReserveGuard.sol': { content: readFileSync(join(CONTRACTS, 'ReserveGuard.sol'), 'utf8') },
    'WrappedBTC.sol': { content: readFileSync(join(CONTRACTS, 'WrappedBTC.sol'), 'utf8') },
  },
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

const pick = (file, name) => {
  const c = output.contracts[file][name];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
};
const Guard = pick('ReserveGuard.sol', 'ReserveGuard');
const Guarded = pick('WrappedBTC.sol', 'GuardedWBTC');
const Naive = pick('WrappedBTC.sol', 'NaiveWBTC');

const provider = new JsonRpcProvider(RPC);
const wallet = new Wallet(CREDITCOIN_KEY, provider);
const net = await provider.getNetwork();
console.log(`deployer: ${wallet.address}  chainId: ${net.chainId}`);
console.log(`verifier: ${verifierDep.address}`);
console.log(`maxFactAge: ${MAX_FACT_AGE}s`);

async function deploy(label, art, args) {
  const factory = new ContractFactory(art.abi, art.bytecode, wallet);
  const c = await factory.deploy(...args);
  const r = await c.deploymentTransaction().wait();
  const addr = await c.getAddress();
  console.log(`  ${label.padEnd(12)} ${addr}  (gas ${r.gasUsed})`);
  return addr;
}

console.log('deploying...');
const guardAddr = await deploy('ReserveGuard', Guard, [
  verifierDep.address,
  wallet.address,
  MAX_FACT_AGE,
]);
const guardedAddr = await deploy('GuardedWBTC', Guarded, [guardAddr, wallet.address]);
const naiveAddr = await deploy('NaiveWBTC', Naive, [wallet.address]);

const guard = new Contract(guardAddr, Guard.abi, wallet);
const tx = await guard.setToken(guardedAddr);
await tx.wait();
console.log(`  guard.setToken(${guardedAddr}) ok`);

writeFileSync(
  join(HERE, 'guard-deployment.json'),
  JSON.stringify(
    {
      reserveGuard: guardAddr,
      guardedWBTC: guardedAddr,
      naiveWBTC: naiveAddr,
      verifier: verifierDep.address,
      issuer: wallet.address,
      maxFactAge: MAX_FACT_AGE,
      creditcoinRpc: RPC,
      abis: { ReserveGuard: Guard.abi, GuardedWBTC: Guarded.abi, NaiveWBTC: Naive.abi },
    },
    null,
    2
  )
);
console.log('wrote scripts/guard-deployment.json');
