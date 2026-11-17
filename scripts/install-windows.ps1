<#
.SYNOPSIS
Puts "pi-crust" on your PATH and adds a Start Menu shortcut "Pi Crust". No admin needed.

.DESCRIPTION
Launcher: if %APPDATA%\npm is already on your PATH (the Node installer puts it there), a three line
pi-crust.cmd shim is written into it. That touches no environment variable, so it is the less
invasive choice. Otherwise the app folder is appended to your user PATH (user scope, once).
Open a new terminal afterwards. If you move the folder, run this script again.

Start Menu: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Pi Crust.lnk runs electron.exe with
the app folder as argument (the repo picker opens). The icon is taken from the repo when
an icon.ico exists there, otherwise from electron.exe.

Run with -WhatIf to see what would happen without changing anything.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param()
$ErrorActionPreference = 'Stop'

$appDir = Split-Path -Parent $PSScriptRoot
$electron = Join-Path $appDir 'node_modules\electron\dist\electron.exe'
$launcher = Join-Path $appDir 'pi-crust.cmd'
if (-not (Test-Path -LiteralPath $launcher)) { throw "pi-crust.cmd not found in $appDir" }
if (-not (Test-Path -LiteralPath $electron)) { Write-Warning 'electron.exe not found yet (see SETUP.md). The launcher and shortcut will not work until it exists.' }

function Get-PathEntries([string]$Value) {
	if (-not $Value) { return @() }
	return @($Value.Split(';') | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') })
}

# (a) launcher on PATH
$npmDir = Join-Path $env:APPDATA 'npm'
$userKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
try {
	# Read the raw value so %VARS% in it survive the write below.
	$userPath = [string]$userKey.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
	$userEntries = @(Get-PathEntries $userPath)
	$allEntries = @(Get-PathEntries $env:PATH) + $userEntries
	$npmOnPath = (Test-Path -LiteralPath $npmDir) -and ($allEntries -contains $npmDir.TrimEnd('\'))

	if ($npmOnPath) {
		$shim = Join-Path $npmDir 'pi-crust.cmd'
		$shimText = "@echo off`r`ncall `"$launcher`" %*`r`nexit /b %ERRORLEVEL%`r`n"
		if ($PSCmdlet.ShouldProcess($shim, 'Write pi-crust.cmd shim')) {
			[IO.File]::WriteAllText($shim, $shimText, [Text.Encoding]::GetEncoding([Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage))
			Write-Output "Launcher: wrote $shim"
		}
	} elseif ($userEntries -contains $appDir.TrimEnd('\')) {
		Write-Output "Launcher: $appDir is already on your user PATH"
	} elseif ($PSCmdlet.ShouldProcess('user PATH', "Append $appDir")) {
		$newPath = if ($userPath) { $userPath.TrimEnd(';') + ';' + $appDir } else { $appDir }
		$userKey.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
		# Setting and clearing a throwaway variable makes Windows tell running programs that the environment changed.
		[Environment]::SetEnvironmentVariable('PI_CRUST_NOTIFY', '1', 'User')
		[Environment]::SetEnvironmentVariable('PI_CRUST_NOTIFY', $null, 'User')
		Write-Output "Launcher: added $appDir to your user PATH"
	}
} finally {
	$userKey.Close()
}

# (b) Start Menu shortcut
$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$lnk = Join-Path $programs 'Pi Crust.lnk'
$icon = $electron + ',0'
foreach ($c in 'icon.ico', 'build\icon.ico', 'assets\icon.ico', 'resources\icon.ico', 'src\icon.ico') {
	$p = Join-Path $appDir $c
	if (Test-Path -LiteralPath $p) { $icon = $p; break }
}
if ($PSCmdlet.ShouldProcess($lnk, 'Create Start Menu shortcut')) {
	$sh = New-Object -ComObject WScript.Shell
	$s = $sh.CreateShortcut($lnk)
	$s.TargetPath = $electron
	$s.Arguments = '"' + $appDir + '"'
	$s.WorkingDirectory = $appDir
	$s.Description = 'Pi Crust'
	$s.IconLocation = $icon
	$s.Save()
	Write-Output "Start Menu: created $lnk"
}
