[CmdletBinding()]
param(
  [switch]$Demo,
  [switch]$RequireCodex,
  [switch]$RequireClaude
)

$ErrorActionPreference = 'Continue'
$failed = $false

function Write-Check([string]$Name, [bool]$Ok, [string]$Detail) {
  $label = if ($Ok) { 'PASS' } else { 'FAIL' }
  Write-Host "[$label] $Name - $Detail"
  if (-not $Ok) { $script:failed = $true }
}

function Write-Skip([string]$Name, [string]$Detail) {
  Write-Host "[SKIP] $Name - $Detail"
}

function Test-Command([string]$Name) {
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

$nodeOk = Test-Command 'node'
$nodeVersion = if ($nodeOk) { (node --version 2>$null) } else { 'not found' }
$nodeSupported = $false
if ($nodeOk) {
  try {
    $nodeParsed = [version](([string]$nodeVersion).Trim().TrimStart('v') -replace '^(\d+(\.\d+){0,3}).*$', '$1')
    if ($nodeParsed.Major -eq 22) { $nodeSupported = $nodeParsed -ge [version]'22.23.4' }
    elseif ($nodeParsed.Major -eq 24) { $nodeSupported = $nodeParsed -ge [version]'24.22.1' }
    elseif ($nodeParsed.Major -eq 26) { $nodeSupported = $nodeParsed -ge [version]'26.12.1' }
    elseif ($nodeParsed.Major -gt 26) { $nodeSupported = $true }
  } catch {
    $nodeSupported = $false
  }
}
Write-Check 'Node.js' $nodeSupported "$nodeVersion (requires 22.23.4+, 24.22.1+ or 26.12.1+)"

$databaseUrl = if ($Demo) { $env:TEST_DATABASE_URL } else { $env:DATABASE_URL }
if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
  if ($Demo) { Write-Check 'PostgreSQL URL' $false 'TEST_DATABASE_URL is required for disposable demo data' }
  else { Write-Skip 'PostgreSQL URL' 'not set; the app setup wizard configures the database' }
} else {
  try {
    $uri = [Uri]$databaseUrl
    $knownDemo = $uri.UserInfo -match '^line_agent_demo:'
    if ([string]::IsNullOrWhiteSpace($uri.UserInfo) -or $uri.UserInfo -match 'CHANGE_ME') { throw 'explicit credentials are required' }
    if (-not $Demo -and $knownDemo) { throw 'demo credentials are forbidden for production data' }
    Write-Check 'PostgreSQL URL' $true "configured for $($uri.Host):$($uri.Port)/$($uri.AbsolutePath.Trim('/')) (credentials hidden)"
  } catch {
    Write-Check 'PostgreSQL URL' $false 'invalid URL or production is using demo credentials'
  }
}

if (-not [string]::IsNullOrWhiteSpace($databaseUrl) -and $nodeOk) {
  $env:LINE_AGENT_PREREQ_DATABASE_URL = $databaseUrl
  try {
    node (Join-Path $PSScriptRoot 'check-postgres.mjs') *> $null
    Write-Check 'PostgreSQL connection' ($LASTEXITCODE -eq 0) 'read-only connectivity probe'
  } finally {
    Remove-Item Env:LINE_AGENT_PREREQ_DATABASE_URL -ErrorAction SilentlyContinue
  }
}

if (Test-Command 'codex') {
  $codexStatus = (& codex login status 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -eq 0) { Write-Check 'Codex login' $true 'authenticated (token output suppressed)' }
  elseif ($RequireCodex) { Write-Check 'Codex login' $false 'selected provider is not authenticated' }
  else { Write-Skip 'Codex login' 'optional provider is not authenticated' }
} elseif ($RequireCodex) { Write-Check 'Codex CLI' $false 'selected provider is not installed' }
else { Write-Skip 'Codex CLI' 'optional provider is not installed' }

if (Test-Command 'claude') {
  $claudeStatus = (& claude auth status 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -eq 0) { Write-Check 'Claude login' $true 'authenticated (token output suppressed)' }
  elseif ($RequireClaude) { Write-Check 'Claude login' $false 'selected provider is not authenticated' }
  else { Write-Skip 'Claude login' 'optional provider is not authenticated' }
} elseif ($RequireClaude) { Write-Check 'Claude CLI' $false 'selected provider is not installed' }
else { Write-Skip 'Claude CLI' 'optional provider is not installed' }

$paths = @(
  @{ Name = 'Attachment root'; Value = $env:LINE_AGENT_ATTACHMENT_ROOT },
  @{ Name = 'Workspace'; Value = $env:LINE_AGENT_WORKSPACE }
)
foreach ($item in $paths) {
  $candidate = $item.Value
  if ([string]::IsNullOrWhiteSpace($candidate)) {
    if ($Demo) { Write-Check $item.Name $false 'path is required' }
    else { Write-Skip $item.Name 'not set; chosen in the app setup wizard' }
    continue
  }
  try {
    New-Item -ItemType Directory -Force -Path $candidate | Out-Null
    $probe = Join-Path $candidate ".line-agent-write-probe-$PID"
    [IO.File]::WriteAllText($probe, '')
    Remove-Item -LiteralPath $probe -Force
    Write-Check $item.Name $true ([IO.Path]::GetFullPath($candidate))
  } catch { Write-Check $item.Name $false ([IO.Path]::GetFullPath($candidate)) }
}

if ($failed) { exit 1 }
exit 0
