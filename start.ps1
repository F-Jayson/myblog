[CmdletBinding()]
param(
	[switch]$SkipInstall,
	[switch]$SkipBuild,
	[switch]$Database,
	[switch]$DockerMySql,
	[switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateDirectory = Join-Path $Root ".firefly-run"
$StatePath = Join-Path $StateDirectory "processes.json"
$LogDirectory = Join-Path $Root "logs"
$EnvironmentPath = Join-Path $Root ".env"
$EnvironmentExamplePath = Join-Path $Root ".env.example"
$EnvironmentDockerExamplePath = Join-Path $Root ".env.docker.example"
$ComposePath = Join-Path $Root "docker-compose.yml"
$ProcessEnvironmentKeys = @("API_PORT", "API_PROXY_TARGET", "MYSQL_HOST", "MYSQL_PORT", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_PASSWORD_BASE64")
$OriginalProcessEnvironment = @{}
$RestoreProcessEnvironment = $false
$ApiPort = 5180
$WebPort = 5174
$ApiUrl = ""
$WebUrl = ""

function Write-Step([string]$Message) {
	Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Get-DotEnvValue([string]$Path, [string]$Name) {
	if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
	$escapedName = [regex]::Escape($Name)
	foreach ($line in Get-Content -LiteralPath $Path) {
		if ($line -match "^\s*$escapedName\s*=\s*(.*?)\s*$") {
			$value = [string]$Matches[1]
			if ($value.Length -ge 2 -and (($value[0] -eq [char]34 -and $value[$value.Length - 1] -eq [char]34) -or ($value[0] -eq [char]39 -and $value[$value.Length - 1] -eq [char]39))) {
				$value = $value.Substring(1, $value.Length - 2)
			}
			return $value
		}
	}
	return $null
}

function Save-ProcessEnvironment {
	foreach ($key in $ProcessEnvironmentKeys) {
		$OriginalProcessEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, "Process")
	}
}

function Set-ProcessEnvironment([string]$Name, [string]$Value) {
	[Environment]::SetEnvironmentVariable($Name, $Value, "Process")
	$script:RestoreProcessEnvironment = $true
}

function Initialize-ApplicationEnvironment {
	$apiPortText = Get-DotEnvValue $EnvironmentPath "API_PORT"
	if ([string]::IsNullOrWhiteSpace($apiPortText)) { $apiPortText = "5180" }
	$parsedApiPort = 0
	if (-not [int]::TryParse($apiPortText.Trim(), [ref]$parsedApiPort) -or $parsedApiPort -lt 1 -or $parsedApiPort -gt 65535) {
		throw "API_PORT in $EnvironmentPath must be an integer between 1 and 65535."
	}
	$script:ApiPort = $parsedApiPort
	$script:ApiUrl = "http://localhost:$ApiPort"
	$proxyTarget = Get-DotEnvValue $EnvironmentPath "API_PROXY_TARGET"
	if ([string]::IsNullOrWhiteSpace($proxyTarget)) { $proxyTarget = $ApiUrl }
	try {
		$proxyUri = [System.Uri]::new($proxyTarget)
	} catch {
		throw "API_PROXY_TARGET in $EnvironmentPath is not a valid absolute URL."
	}
	if (-not $proxyUri.IsAbsoluteUri -or $proxyUri.Scheme -notin @('http', 'https')) {
		throw "API_PROXY_TARGET in $EnvironmentPath must use an http or https URL."
	}
	if ($proxyUri.Port -ne $ApiPort) {
		throw "API_PROXY_TARGET port $($proxyUri.Port) does not match API_PORT $ApiPort. Update both values in $EnvironmentPath."
	}
	Set-ProcessEnvironment "API_PORT" ([string]$ApiPort)
	Set-ProcessEnvironment "API_PROXY_TARGET" ($proxyUri.AbsoluteUri.TrimEnd('/'))
	foreach ($key in @("MYSQL_HOST", "MYSQL_PORT", "MYSQL_DATABASE", "MYSQL_USER", "MYSQL_PASSWORD", "MYSQL_PASSWORD_BASE64")) {
		$value = Get-DotEnvValue $EnvironmentPath $key
		if ($null -ne $value) { Set-ProcessEnvironment $key $value }
	}
}

function Initialize-DockerEnvironment {
	$database = Get-DotEnvValue $EnvironmentPath "MYSQL_DATABASE"
	$user = Get-DotEnvValue $EnvironmentPath "MYSQL_USER"
	$portText = Get-DotEnvValue $EnvironmentPath "MYSQL_PORT"
	$password = Get-DotEnvValue $EnvironmentPath "MYSQL_PASSWORD"
	if ([string]::IsNullOrWhiteSpace($database)) { $database = "firefly_blog" }
	if ($database -ne "firefly_blog") {
		throw "Docker Compose and database/schema.sql use the fixed database name firefly_blog. Set MYSQL_DATABASE=firefly_blog in $EnvironmentPath."
	}
	if ([string]::IsNullOrWhiteSpace($user) -or $user -eq "root") {
		throw "Docker Compose requires a non-root MYSQL_USER. Copy .env.docker.example to .env and set a unique MYSQL_PASSWORD."
	}
	$parsedPort = 0
	if ([string]::IsNullOrWhiteSpace($portText)) { $portText = "3307" }
	if (-not [int]::TryParse($portText.Trim(), [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) {
		throw "MYSQL_PORT in $EnvironmentPath must be an integer between 1 and 65535."
	}
	if ([string]::IsNullOrWhiteSpace($password)) {
		throw "Docker Compose requires MYSQL_PASSWORD in $EnvironmentPath."
	}
	Set-ProcessEnvironment "MYSQL_HOST" "127.0.0.1"
	Set-ProcessEnvironment "MYSQL_PORT" ([string]$parsedPort)
	Set-ProcessEnvironment "MYSQL_DATABASE" $database
	Set-ProcessEnvironment "MYSQL_USER" $user
	Set-ProcessEnvironment "MYSQL_PASSWORD" $password
	Set-ProcessEnvironment "MYSQL_PASSWORD_BASE64" ""
}

function Invoke-Pnpm([string[]]$Arguments) {
	Push-Location $Root
	try {
		& $script:PnpmPath @($script:PnpmPrefix + $Arguments)
		$exitCode = $LASTEXITCODE
	} finally {
		Pop-Location
	}
	if ($exitCode -ne 0) { throw "pnpm command failed (exit code $exitCode): pnpm $($Arguments -join ' ')" }
}

function Invoke-DockerCompose([string[]]$Arguments) {
	$composeOptions = @("--project-directory", $Root, "--file", $ComposePath)
	if (Test-Path -LiteralPath $EnvironmentPath -PathType Leaf) { $composeOptions += @("--env-file", $EnvironmentPath) }
	& docker compose @composeOptions @Arguments
	if ($LASTEXITCODE -ne 0) {
		throw "docker compose command failed (exit code $LASTEXITCODE): docker compose $($Arguments -join ' ')"
	}
}

function Invoke-DatabaseMigration([bool]$Required) {
	Write-Step "Applying database schema migrations"
	try {
		Invoke-Pnpm @("db:migrate")
	} catch {
		if ($Required) { throw }
		Write-Warning "Could not apply database migrations. The servers will still start for the frontend demo, but database-backed API routes remain unavailable until MySQL is reachable and 'pnpm db:migrate' succeeds."
	}
}

function Get-ProcessInfo([int]$ProcessId) {
	try {
		Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
	} catch {
		Write-Warning "Could not inspect PID ${ProcessId}: $($_.Exception.Message)"
		return $null
	}
}

function Normalize-CommandLine([string]$Value) {
	return [regex]::Replace(([string]$Value).Trim(), "\s+", " " ).ToLowerInvariant()
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
		Write-Warning "PID ${ProcessId} is running but could not be inspected; it was not stopped."
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
	Write-Host "Stopping PID $ProcessId ..." -ForegroundColor Yellow
	& taskkill.exe /PID $ProcessId /T /F | Out-Null
	if ($LASTEXITCODE -ne 0) {
		Write-Warning "taskkill failed for PID ${ProcessId} (exit code $LASTEXITCODE)."
		return $false
	}
	for ($attempt = 0; $attempt -lt 20; $attempt++) {
		if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { return $true }
		Start-Sleep -Milliseconds 250
	}
	Write-Warning "PID ${ProcessId} is still running after taskkill."
	return $false
}

function Stop-ExistingRun {
	if (-not (Test-Path $StatePath)) { return }
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
	if (-not ($apiStopped -and $webStopped)) { throw "Could not stop all tracked Firefly processes; state was kept at $StatePath." }
	Remove-Item $StatePath -Force -ErrorAction Stop
	if (Test-Path -LiteralPath $StatePath) { throw "Could not remove the Firefly run record; state was kept at $StatePath." }
}

function Test-PortAvailable([int]$Port) {
	if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
		try {
			$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop
			return -not [bool]$listener
		} catch {
			Write-Verbose "Get-NetTCPConnection failed; checking port $Port with TcpListener."
		}
	}

	$tcpListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
	try {
		$tcpListener.Server.ExclusiveAddressUse = $true
		$tcpListener.Start()
		return $true
	} catch [System.Net.Sockets.SocketException] {
		return $false
	} finally {
		$tcpListener.Stop()
	}
}

function Get-HttpStatusCode([string]$Uri) {
	try {
		$response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
		return [int]$response.StatusCode
	} catch {
		$response = $_.Exception.Response
		if ($response -and $null -ne $response.StatusCode) { return [int]$response.StatusCode }
		return $null
	}
}

function Wait-ForServices($ApiProcess, $WebProcess, [bool]$RequireHealthyApi) {
	$deadline = (Get-Date).AddSeconds(45)
	$apiStatus = $null
	$webStatus = $null
	while ((Get-Date) -lt $deadline) {
		if (-not (Get-Process -Id $ApiProcess.Id -ErrorAction SilentlyContinue)) {
			throw "The API process exited during startup. Check $LogDirectory\api-start.error.log."
		}
		if (-not (Get-Process -Id $WebProcess.Id -ErrorAction SilentlyContinue)) {
			throw "The web process exited during startup. Check $LogDirectory\web-start.error.log."
		}

		$apiStatus = Get-HttpStatusCode "http://127.0.0.1:$ApiPort/api/health"
		$webStatus = Get-HttpStatusCode "http://127.0.0.1:$WebPort/"
		$apiReady = $null -ne $apiStatus -and ((-not $RequireHealthyApi) -or $apiStatus -eq 200)
		$webReady = $null -ne $webStatus -and $webStatus -ge 200 -and $webStatus -lt 400
		if ($apiReady -and $webReady) { return }
		Start-Sleep -Seconds 1
	}

	$apiExpectation = if ($RequireHealthyApi) { "HTTP 200" } else { "an HTTP response" }
	throw "Services did not become ready within 45 seconds (API: $apiStatus, expected $apiExpectation; Web: $webStatus). Check $LogDirectory."
}

try {
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
	throw "Node.js was not found. Install Node.js 22 or newer first."
}

$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if ($pnpmCommand) {
	$script:PnpmPath = $pnpmCommand.Source
	$script:PnpmPrefix = @()
} elseif (Get-Command corepack -ErrorAction SilentlyContinue) {
	$script:PnpmPath = "corepack.cmd"
	$script:PnpmPrefix = @("pnpm")
	Write-Step "Using the pnpm version declared by the project through Corepack"
} else {
	throw "pnpm or Corepack was not found. Install pnpm 11 or enable Corepack."
}

New-Item -ItemType Directory -Path $StateDirectory, $LogDirectory -Force | Out-Null
Stop-ExistingRun

if (-not (Test-Path $EnvironmentPath)) {
	$environmentTemplate = if ($DockerMySql) { $EnvironmentDockerExamplePath } else { $EnvironmentExamplePath }
	if (Test-Path $environmentTemplate) {
		Copy-Item $environmentTemplate $EnvironmentPath
		Write-Host "Created .env from $([System.IO.Path]::GetFileName($environmentTemplate)). Review its settings before starting." -ForegroundColor Yellow
	}
}

Save-ProcessEnvironment
Initialize-ApplicationEnvironment

if (-not (Test-PortAvailable $WebPort)) {
	throw "Port $WebPort is already in use. Stop the existing web server or run .\stop.ps1 first."
}

if (-not (Test-PortAvailable $ApiPort)) {
	throw "Port $ApiPort is already in use. Stop the existing API server or run .\stop.ps1 first."
}

if (-not $SkipInstall) {
	Write-Step "Installing workspace dependencies"
	Invoke-Pnpm @("install", "--frozen-lockfile")
}

if ($DockerMySql) {
	Initialize-DockerEnvironment
	if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
		throw "-DockerMySql requires Docker Desktop to be installed and running."
	}
	Write-Step "Starting Docker MySQL"
	Invoke-DockerCompose @("up", "-d", "mysql")
	Write-Step "Waiting for Docker MySQL readiness"
	$deadline = (Get-Date).AddMinutes(2)
	$attempt = 0
	$health = $null
	while ((Get-Date) -lt $deadline) {
		$attempt++
		$containerId = @(Invoke-DockerCompose @("ps", "-q", "mysql")) | Select-Object -First 1
		if (-not $containerId) { throw "Docker MySQL container was not created. Check docker compose logs mysql." }
		$containerState = ([string](& docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' $containerId)).Trim()
		if ($LASTEXITCODE -ne 0) { throw "Could not inspect the Docker MySQL container." }
		if ($containerState -match '^(exited|dead|removing)') {
			Invoke-DockerCompose @("logs", "--tail", "50", "mysql")
			throw "Docker MySQL exited before it became healthy."
		}
		if ($containerState -eq "running unhealthy") {
			Invoke-DockerCompose @("logs", "--tail", "50", "mysql")
			throw "Docker MySQL reported an unhealthy status."
		}
		$health = $containerState
		if ($health -eq "running healthy") { break }
		if ($attempt % 5 -eq 0) { Write-Host "Still waiting for Docker MySQL ($containerState)..." }
		Start-Sleep -Seconds 2
	}
	if ($health -ne "running healthy") {
		Invoke-DockerCompose @("logs", "--tail", "50", "mysql")
		throw "Docker MySQL did not become healthy within two minutes."
	}
}


# schema.sql is idempotent. Run it on every normal startup so existing databases
# receive new tables before the API queries them; seed data remains opt-in.
Invoke-DatabaseMigration ($Database -or $DockerMySql)

if ($Database) {
	Write-Step "Running database seed data"
	Invoke-Pnpm @("db:seed")
}

if (-not $SkipBuild) {
	Write-Step "Building the web app and API"
	Invoke-Pnpm @("build")
}

Write-Step "Starting the API and web development servers"
$apiLog = Join-Path $LogDirectory "api-start.log"
$apiErrorLog = Join-Path $LogDirectory "api-start.error.log"
$webLog = Join-Path $LogDirectory "web-start.log"
$webErrorLog = Join-Path $LogDirectory "web-start.error.log"

$apiProcess = $null
$webProcess = $null
$state = [ordered]@{
	ApiPid = 0
	WebPid = 0
	StartedAt = (Get-Date).ToString("o")
	ApiUrl = $ApiUrl
	WebUrl = "http://localhost:$WebPort"
	ApiCommandLine = ""
	WebCommandLine = ""
	ApiCreationDate = ""
	WebCreationDate = ""
}
try {
	$apiProcess = Start-Process -FilePath $script:PnpmPath `
		-ArgumentList @($script:PnpmPrefix + @("--filter", "@firefly-rebuild/api", "dev")) `
		-WorkingDirectory $Root -WindowStyle Hidden `
		-RedirectStandardOutput $apiLog -RedirectStandardError $apiErrorLog -PassThru
	$state.ApiPid = $apiProcess.Id
	$apiInfo = Get-ProcessInfo $apiProcess.Id
	$state.ApiCommandLine = if ($apiInfo) { [string]$apiInfo.CommandLine } else { "" }
	$state.ApiCreationDate = if ($apiInfo) { [string]$apiInfo.CreationDate } else { "" }
	$state | ConvertTo-Json | Set-Content -Path $StatePath -Encoding UTF8

	$webProcess = Start-Process -FilePath $script:PnpmPath `
		-ArgumentList @($script:PnpmPrefix + @("--filter", "@firefly-rebuild/web", "dev")) `
		-WorkingDirectory $Root -WindowStyle Hidden `
		-RedirectStandardOutput $webLog -RedirectStandardError $webErrorLog -PassThru
	$state.WebPid = $webProcess.Id
	$webInfo = Get-ProcessInfo $webProcess.Id
	$state.WebCommandLine = if ($webInfo) { [string]$webInfo.CommandLine } else { "" }
	$state.WebCreationDate = if ($webInfo) { [string]$webInfo.CreationDate } else { "" }
	$state | ConvertTo-Json | Set-Content -Path $StatePath -Encoding UTF8
	Wait-ForServices $apiProcess $webProcess ($Database -or $DockerMySql)
} catch {
	$apiStopped = $true
	$webStopped = $true
	if ($apiProcess) { $apiStopped = Stop-TrackedProcess $apiProcess.Id "@firefly-rebuild/api" ([string]$state.ApiCommandLine) ([string]$state.ApiCreationDate) ([string]$state.StartedAt) }
	if ($webProcess) { $webStopped = Stop-TrackedProcess $webProcess.Id "@firefly-rebuild/web" ([string]$state.WebCommandLine) ([string]$state.WebCreationDate) ([string]$state.StartedAt) }
	if ($apiStopped -and $webStopped) {
		Remove-Item $StatePath -Force -ErrorAction SilentlyContinue
		if (Test-Path -LiteralPath $StatePath) { Write-Warning "Could not remove the run record; state was kept at $StatePath." }
	} else {
		$state | ConvertTo-Json | Set-Content -Path $StatePath -Encoding UTF8
		Write-Warning "One or more startup processes could not be stopped; state was kept at $StatePath."
	}
	throw
}

Write-Host "`nFirefly Headless started." -ForegroundColor Green
Write-Host "Web:   $($state.WebUrl)"
Write-Host "Admin: $($state.WebUrl)/admin/login"
Write-Host "API:   $($state.ApiUrl)"
Write-Host "Health: $($state.ApiUrl)/api/health"
Write-Host "Logs:  $LogDirectory"
Write-Host "Stop:  .\stop.ps1"

if ($OpenBrowser) {
	Start-Process $state.WebUrl
}
} finally {
	if ($RestoreProcessEnvironment) {
		foreach ($key in $ProcessEnvironmentKeys) {
			[Environment]::SetEnvironmentVariable($key, $OriginalProcessEnvironment[$key], "Process")
		}
	}
}
