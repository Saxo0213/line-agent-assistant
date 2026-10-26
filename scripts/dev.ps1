[CmdletBinding()]
param([switch]$Demo)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repositoryRoot
try {
  if ($Demo -and [string]::IsNullOrWhiteSpace($env:DATABASE_URL)) { $env:DATABASE_URL = $env:TEST_DATABASE_URL }
  $prerequisiteArguments = @{}
  if ($Demo) { $prerequisiteArguments.Demo = $true }
  & $PSScriptRoot/check-prerequisites.ps1 @prerequisiteArguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npm run start --workspace @line-agent/desktop
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
