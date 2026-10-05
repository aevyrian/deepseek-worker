param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$Profile,

  [string]$DshCommand = 'dsh'
)

$ErrorActionPreference = 'Stop'
$bundleRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$manifestPath = Join-Path $bundleRoot 'package.json'
$patchPath = Join-Path $bundleRoot 'dsh.bundle.patch.yml'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or -not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
  throw 'This folder is missing the Harness bundle package.json or dsh.bundle.patch.yml.'
}

$null = Get-Command $DshCommand -ErrorAction Stop
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -ne 'deepseek-worker-connector' -or $manifest.dsh.bundle.patch -ne './dsh.bundle.patch.yml') {
  throw 'The selected folder does not contain the expected DeepSeek Worker Connector bundle.'
}

Write-Host "Installing the local bundle into Harness profile '$Profile'."
Write-Host 'The existing profile will be modified by the Harness plugin manager.'
& $DshCommand plugin --profile $Profile add $bundleRoot
if ($LASTEXITCODE -ne 0) { throw "Harness plugin installation failed with exit code $LASTEXITCODE." }
Write-Host 'Install command completed. Restart this Harness profile if it is a startup profile, then run test-local.ps1 -Profile with this same profile.'
