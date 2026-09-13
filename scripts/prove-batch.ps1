# Re-proves the project's other UTXOs on the current devnet chain, one after
# another. Needed after a devnet rebuild: relays made before the attestation
# genesis height can never be attested again, so each UTXO needs a fresh relay.
#
# Sequential on purpose -- concurrent runs collide on the relayer account nonce.
#
# Usage: .\prove-batch.ps1

$txids = @(
  "e1afd89295b68bc5247fe0ca2885dd4b8818d7ce430faa615067d7bab8640156",
  "50748b7a193a0b23f1e9494b51131d2f954cc6cf4792bacc69d207d16002080d",
  "e79fc1dad370e628614702f048edc8e98829cf8ea8f6615db19f992b1be92e44",
  "f925f26deb2dc4696be8782ab7ad9493d04721b28ee69a09d7dfca51b863ca23"
)

$i = 0
foreach ($t in $txids) {
  $i++
  Write-Output "=== [$i/$($txids.Count)] $t ==="
  & powershell.exe -ExecutionPolicy Bypass -File "E:\work\bitcoinbroadcaster\bitcoin-witness\scripts\run-demo.ps1" -Txid $t -Vout "0" -LogName "batch-$i"
  Write-Output "=== [$i/$($txids.Count)] finished ==="
}
Write-Output "ALL DONE"
