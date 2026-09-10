[CmdletBinding()]
param(
	[switch]$Quiet
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StatePath = Join-Path $Root ".firefly-run\processes.json"

function Get-ProcessInfo([int]$ProcessId) {
	try {
		Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
	} catch {
		Write-Warning "Could not inspect PID $($ProcessId): $($_.Exception.Message)"
		return $null
	}
}

function Normalize-CommandLine([string]$Value) {
	return [regex]::Replace(([string]$Value).Trim(), "\s+", " ").ToLowerInvariant()
}

function Test-LegacyProcessIdentity($ProcessInfo, [string]$ExpectedCommand, [string]$RecordedStartedAt) {
	$commandLine = [string]$ProcessInfo.CommandLine
	$comparison = [System.StringComparison]::OrdinalIgnoreCase
	if ($commandLine.IndexOf($ExpectedCommand, $comparison) -lt 0) {
		Write-Warning "Legacy run record for PID $($ProcessInfo.ProcessId) does not match $ExpectedCommand; it was not stopped."
		return $false
	}
	try {
		$startedAt = [DateTimeOffset]::Parse($RecordedStartedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
		$createdAt = [DateTimeOffset]$ProcessInfo.CreationDate
	} catch {
		Write-Warning "Legacy run record for PID $($ProcessInfo.ProcessId) has no verifiable start time; it was not stopped."
		return $false
	}
	if ($createdAt -lt $startedAt.AddMinutes(-5) -or $createdAt -gt $startedAt.AddMinutes(5)) {
		Write-Warning "Legacy run record for PID $($ProcessInfo.ProcessId) does not match the recorded start window; it was not stopped."
		return $false
	}
	return $true
}

function Stop-TrackedProcess([int]$ProcessId, [string]$ExpectedCommand, [string]$RecordedCommandLine = "", [string]$RecordedCreationDate = "", [string]$RecordedStartedAt = "") {
	if ($ProcessId -le 0) { return $true }
	if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
	$processInfo = Get-ProcessInfo $ProcessId
	if (-not $processInfo) {
		Write-Warning "PID $($ProcessId) is running but could not be inspected; it was not stopped."
		return $false
	}
	$commandLine = [string]$processInfo.CommandLine
	$hasRecordedIdentity = -not [string]::IsNullOrWhiteSpace($RecordedCommandLine) -and -not [string]::IsNullOrWhiteSpace($RecordedCreationDate)
	if ($hasRecordedIdentity) {
		$recordedMatches = (Normalize-CommandLine $commandLine) -eq (Normalize-CommandLine $RecordedCommandLine)
		$creationMatches = [string]$processInfo.CreationDate -eq $RecordedCreationDate
	} elseif (-not (Test-LegacyProcessIdentity $processInfo $ExpectedCommand $RecordedStartedAt)) {
		return $false
	}
	if ($hasRecordedIdentity -and (-not $recordedMatches -or -not $creationMatches)) {
		Write-Warning "Skipping PID $($ProcessId): the recorded process identity does not match."
		return $false
	}
	if (-not $Quiet) { Write-Host "Stopping PID $ProcessId ..." -ForegroundColor Yellow }
	& taskkill.exe /PID $ProcessId /T /F | Out-Null
	if ($LASTEXITCODE -ne 0) {
		Write-Warning "taskkill failed for PID $($ProcessId) (exit code $LASTEXITCODE)."
		return $false
	}
	for ($attempt = 0; $attempt -lt 20; $attempt++) {
		if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
		Start-Sleep -Milliseconds 250
	}
	Write-Warning "PID $($ProcessId) is still running after taskkill."
	return $false
}

if (-not (Test-Path $StatePath)) {
	if (-not $Quiet) { Write-Host "No Firefly Headless run record was found; services may already be stopped." }
	exit 0
}

try {
	$state = Get-Content $StatePath -Raw | ConvertFrom-Json
} catch {
	Write-Warning "The run record is invalid and was kept for diagnosis: $StatePath"
	throw
}
$apiPid = 0
$webPid = 0
$apiValid = [int]::TryParse([string]$state.ApiPid, [ref]$apiPid)
$webValid = [int]::TryParse([string]$state.WebPid, [ref]$webPid)
if (-not $state -or -not $apiValid -or -not $webValid -or $apiPid -lt 0 -or $webPid -lt 0 -or ($apiPid -eq 0 -and $webPid -eq 0) -or ($apiPid -gt 0 -and $apiPid -eq $webPid)) {
	throw "The run record has no valid, distinct managed process IDs and was kept for diagnosis: $StatePath"
}
$apiStopped = Stop-TrackedProcess $apiPid "@firefly-rebuild/api" ([string]$state.ApiCommandLine) ([string]$state.ApiCreationDate) ([string]$state.StartedAt)
$webStopped = Stop-TrackedProcess $webPid "@firefly-rebuild/web" ([string]$state.WebCommandLine) ([string]$state.WebCreationDate) ([string]$state.StartedAt)
if (-not ($apiStopped -and $webStopped)) {
	throw "Could not stop all tracked Firefly processes; state was kept at $StatePath."
}
Remove-Item $StatePath -Force -ErrorAction Stop
if (Test-Path -LiteralPath $StatePath) { throw "Could not remove the Firefly run record; state was kept at $StatePath." }

if (-not $Quiet) { Write-Host "Firefly Headless stopped." -ForegroundColor Green }
