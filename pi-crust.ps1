<#
.SYNOPSIS
Start Pi Crust. Usage: pi-crust [repo-path]

.DESCRIPTION
Without a path you pick the repo in the app; with one it opens that repo.
Starts the installed app (%LOCALAPPDATA%\Programs\Pi Crust\Pi Crust.exe, from npm run dist:win) when it is there.
Otherwise starts node_modules\electron\dist\electron.exe with the folder this script lives in.
Either way it runs detached and without a console window. Output goes to
%LOCALAPPDATA%\pi-crust\logs\pi-crust-<yyyyMMdd-HHmmss>.log (errors to a matching .err.log).
Every launch gets its own log, so a second launch cannot truncate the log of a running instance.
The newest 5 logs of each kind are kept.

.PARAMETER Repo
Optional repository folder. Relative paths are resolved against the current folder.

.PARAMETER DryRun
Print the command instead of starting the app.

.EXAMPLE
pi-crust C:\Users\me\code\my-repo
#>
[CmdletBinding()]
param(
	[Parameter(Position = 0)][string]$Repo,
	[switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if ($Repo) { $Repo = $Repo.Trim([char]34) }

# Quote one argument for CreateProcess (trailing backslashes doubled so they cannot eat the closing quote).
function Format-Arg([string]$Value) {
	return '"' + [regex]::Replace($Value, '(\\*)$', '$1$1') + '"'
}

$appDir = $PSScriptRoot
$electron = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
$logDir = Join-Path $env:LOCALAPPDATA 'pi-crust\logs'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $logDir ('pi-crust-' + $stamp + '.log')
$errLog = Join-Path $logDir ('pi-crust-' + $stamp + '.err.log')

# Prefer the installed app (like the macOS launcher prefers the installed .app). It needs no folder argument.
$installed = Join-Path $env:LOCALAPPDATA 'Programs\Pi Crust\Pi Crust.exe'
$useInstalled = Test-Path -LiteralPath $installed -PathType Leaf
if ($useInstalled) { $exe = $installed; $workDir = Split-Path -Parent $installed; $argList = @() }
else { $exe = $electron; $workDir = $appDir; $argList = @((Format-Arg $appDir)) }
if ($Repo) {
	if (-not (Test-Path -LiteralPath $Repo -PathType Container)) {
		throw "Repo folder not found: $Repo"
	}
	$repoAbs = (Convert-Path -LiteralPath $Repo).TrimEnd('\')
	if ($repoAbs -match '^[A-Za-z]:$') { $repoAbs += '\' }
	$argList += '--repo=' + (Format-Arg $repoAbs)
}
$argString = $argList -join ' '

if ($DryRun) {
	Write-Output ('exe:  ' + $exe)
	Write-Output ('args: ' + $argString)
	Write-Output ('cwd:  ' + $workDir)
	Write-Output ('log:  ' + $log)
	Write-Output ('err:  ' + $errLog)
	if (-not (Test-Path -LiteralPath $exe)) { Write-Warning 'electron.exe not found (see SETUP.md).' }
	return
}

if (-not (Test-Path -LiteralPath $exe)) {
	throw "App not found at $exe. See SETUP.md (Windows) for the install steps."
}
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
# Keep the newest 4 old logs of each kind, so with this launch's pair there are 5.
$old = @(Get-ChildItem -LiteralPath $logDir -Filter 'pi-crust-*.log' -File)
$oldErr = @($old | Where-Object { $_.Name -like '*.err.log' })
$oldOut = @($old | Where-Object { $_.Name -notlike '*.err.log' })
foreach ($set in $oldOut, $oldErr) {
	$set | Sort-Object Name -Descending | Select-Object -Skip 4 | Remove-Item -Force -ErrorAction SilentlyContinue
}
# A parent that runs Electron as plain Node (ELECTRON_RUN_AS_NODE) would make the app start as a Node script.
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$startArgs = @{ FilePath = $exe; WorkingDirectory = $workDir; WindowStyle = 'Hidden'; RedirectStandardOutput = $log; RedirectStandardError = $errLog }
if ($argString) { $startArgs.ArgumentList = $argString }
Start-Process @startArgs | Out-Null
