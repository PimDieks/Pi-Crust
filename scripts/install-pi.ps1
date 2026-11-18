<#
.SYNOPSIS
Installs what Pi Crust needs and is missing: Node.js, Git and Pi. Windows. Used by the app's "Install" button after a confirm.

.DESCRIPTION
-Needs says what to install, a comma list of node, git, pi (always done in that order). Nothing is detected here: the app
decides what is missing and shows the same list in its confirm. The script asks for no administrator rights itself; winget
or an installer may show its own Windows prompt.
  node  winget install OpenJS.NodeJS.LTS
  git   winget install Git.Git
  pi    npm install -g @earendil-works/pi-coding-agent

-DryRun prints what would be done ("WOULD <id>: <command>") and changes nothing: no winget, no npm is started.

Output, one line each, for the app to read:
  STEP <id>: <title>     a step starts (other lines in between are the tools' own output)
  DONE <id>              the step worked
  FAIL <id>: <why>       the step failed; the script stops
  WOULD <id>: <command>  dry run only
  RESULT ok | dry-run    the last line when everything worked
Exit codes: 0 worked, 1 a step failed, 2 bad -Needs, 3 winget is missing (the app then shows the manual steps).

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-pi.ps1 -Needs node,git,pi -DryRun
#>
[CmdletBinding()]
param(
	[string]$Needs = '',
	[switch]$DryRun
)
$ErrorActionPreference = 'Stop'

# Keep in step with PLAN in src/health-install.js (scripts/install-pi.test.js compares the two).
$Steps = [ordered]@{
	node = @{ Title = 'Node.js (current LTS)'; Exe = 'winget'; Args = @('install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements') }
	git  = @{ Title = 'Git'; Exe = 'winget'; Args = @('install', '--id', 'Git.Git', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements') }
	pi   = @{ Title = 'Pi, the coding agent'; Exe = 'npm'; Args = @('install', '-g', '@earendil-works/pi-coding-agent', '--allow-scripts=koffi,protobufjs,@google/genai') }
}

$wanted = @($Needs.Split(',') | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
$unknown = @($wanted | Where-Object { -not $Steps.Contains($_) })
if (-not $wanted.Count -or $unknown.Count) {
	Write-Output ("FAIL args: -Needs must be a list of node, git, pi" + $(if ($unknown.Count) { " (not understood: $($unknown -join ', '))" } else { ' (nothing was asked for)' }))
	exit 2
}
$ids = @($Steps.Keys | Where-Object { $wanted -contains $_ })

function Format-Command($s) { "$($s.Exe) $($s.Args -join ' ')" }

if ($DryRun) {
	foreach ($id in $ids) { Write-Output "WOULD ${id}: $(Format-Command $Steps[$id])" }
	Write-Output 'RESULT dry-run (nothing was changed)'
	exit 0
}

# A Node or Git installed a moment ago is on the machine's PATH, not yet on this process's: read it again.
function Update-Path {
	$machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
	$user = [Environment]::GetEnvironmentVariable('Path', 'User')
	$env:Path = (@($machine, $user) | Where-Object { $_ }) -join ';'
}

foreach ($id in $ids) {
	$s = $Steps[$id]
	Write-Output "STEP ${id}: $($s.Title)"
	Update-Path
	$tool = if ($s.Exe -eq 'npm') { 'npm.cmd' } else { $s.Exe }
	if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
		if ($s.Exe -eq 'winget') {
			Write-Output "FAIL ${id}: winget (the Windows package manager) was not found on this computer"
			exit 3
		}
		Write-Output "FAIL ${id}: npm was not found (Node.js is not installed yet, or its install has not finished)"
		exit 1
	}
	try {
		$ErrorActionPreference = 'Continue' # a native tool's stderr text is not an error here, its exit code is
		& $tool @($s.Args) 2>&1 | ForEach-Object { Write-Output "$_" }
		$code = $LASTEXITCODE
		$ErrorActionPreference = 'Stop'
	} catch {
		Write-Output "FAIL ${id}: $($_.Exception.Message)"
		exit 1
	}
	if ($code -ne 0) {
		Write-Output "FAIL ${id}: exit $code"
		exit 1
	}
	Write-Output "DONE $id"
}
Write-Output 'RESULT ok'
exit 0
