# Runs the full Bitcoin Witness pipeline for one UTXO against the local devnet.
# Usage: .\run-demo.ps1 <txid> <vout> <logname>
param(
  [string]$Txid  = "c361e2f4581f035dd58b99788347884e046e47b4c17ec347344ff8b24cd377ec",
  [string]$Vout  = "0",
  [string]$LogName = "demo-guard"
)

# scripts/.env holds RELAYER_ACCOUNT / RELAYER_PRIVATE_KEY / DEPLOYER_KEY and is
# gitignored. demo.ts does not read it itself, so load it here.
Get-Content "E:\work\bitcoinbroadcaster\bitcoin-witness\scripts\.env" | ForEach-Object {
  if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.+?)\s*$') {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
  }
}

$env:RECEIVER_ADDRESS = "0xBF823785C5749532AE927d7285093Eae279fe16C"
$env:VERIFIER_ADDRESS = "0xc01Ee7f10EA4aF4673cFff62710E1D7792aBa8f3"
$env:EXSAT_CHAIN_KEY  = "7"
$env:PROOF_API_URL    = "http://127.0.0.1:3100"
$env:CREDITCOIN_RPC   = "http://127.0.0.1:9944"
$env:CREDITCOIN_KEY   = "0x5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133"

Set-Location "E:\work\bitcoinbroadcaster\bitcoin-witness\scripts"
npx tsx demo.ts --txid $Txid --index $Vout *>&1 | Tee-Object -FilePath "$LogName.log"
