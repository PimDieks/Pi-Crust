# Checks the Authenticode signature of a file after the build. Used by the release workflow.
#   pwsh scripts/verify-signature.ps1 -File <exe> -Mode signed   -Publisher <name>
#   pwsh scripts/verify-signature.ps1 -File <exe> -Mode unsigned
# signed:   fails unless Status is Valid, the signer subject contains the publisher name, and the signature has a
#           timestamp (without one a 3-day certificate makes the signature stop validating).
# unsigned: fails unless Status is NotSigned, so a half-signed build is caught too.
# Exit code 0 = as expected, 1 = not as expected. Prints the status and the signer subject, never any secret.
param(
	[Parameter(Mandatory = $true)][string]$File,
	[Parameter(Mandatory = $true)][ValidateSet('signed', 'unsigned')][string]$Mode,
	[string]$Publisher = ''
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $File)) { Write-Host "ERROR: file not found: $File"; exit 1 }
$sig = Get-AuthenticodeSignature -LiteralPath $File
$subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '(none)' }
$stamped = [bool]$sig.TimeStamperCertificate
Write-Host "$File : Status=$($sig.Status) Subject=$subject Timestamp=$stamped"
if ($Mode -eq 'unsigned') {
	if ($sig.Status -ne 'NotSigned') { Write-Host "ERROR: expected NotSigned (unsigned build) but the status is $($sig.Status)."; exit 1 }
	Write-Host 'OK: NotSigned, as expected for an unsigned build.'
	exit 0
}
if ([string]::IsNullOrWhiteSpace($Publisher)) { Write-Host 'ERROR: signed mode needs -Publisher.'; exit 1 }
if ($sig.Status -ne 'Valid') { Write-Host "ERROR: expected Valid but the status is $($sig.Status)."; exit 1 }
if (-not $subject.Contains($Publisher)) { Write-Host 'ERROR: the signer subject does not contain the expected publisher name.'; exit 1 }
if (-not $stamped) { Write-Host 'ERROR: the signature has no timestamp.'; exit 1 }
Write-Host 'OK: Valid, publisher matches, timestamp present.'
exit 0
