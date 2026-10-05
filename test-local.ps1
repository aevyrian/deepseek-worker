param(
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$Profile
)

$ErrorActionPreference = 'Stop'
$bundleRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$manifestPath = Join-Path $bundleRoot 'package.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.name -ne 'deepseek-worker-connector' -or $manifest.dsh.bundle.patch -ne './dsh.bundle.patch.yml') {
  throw 'Harness bundle metadata check failed.'
}

$null = Get-Command node -ErrorAction Stop
Push-Location $bundleRoot
try {
  & node --check .\index.js
  if ($LASTEXITCODE -ne 0) { throw 'index.js syntax check failed.' }
  & node --check .\client.js
  if ($LASTEXITCODE -ne 0) { throw 'client.js syntax check failed.' }
  & node --check .\lib\connector-config.mjs
  if ($LASTEXITCODE -ne 0) { throw 'connector-config.mjs syntax check failed.' }
  & node --check .\lib\protocol.mjs
  if ($LASTEXITCODE -ne 0) { throw 'protocol.mjs syntax check failed.' }
  & node --check .\lib\native-session.mjs
  if ($LASTEXITCODE -ne 0) { throw 'native-session.mjs syntax check failed.' }
  & node --check .\lib\pairing.mjs
  if ($LASTEXITCODE -ne 0) { throw 'pairing.mjs syntax check failed.' }
  & node --check .\lib\update.mjs
  if ($LASTEXITCODE -ne 0) { throw 'update.mjs syntax check failed.' }
  & node --test .\tests\*.test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Connector test suite failed.' }
} finally {
  Pop-Location
}

if ($Profile) {
  $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
  $profileManifestPath = Join-Path (Join-Path $dshHome 'profiles') "$Profile\package.json"
  if (-not (Test-Path -LiteralPath $profileManifestPath -PathType Leaf)) {
    throw "Harness profile '$Profile' was not found at the expected profile manifest path."
  }
  $profileManifest = Get-Content -LiteralPath $profileManifestPath -Raw | ConvertFrom-Json
  $bundles = @($profileManifest.dsh.profile.bundles)
  if ($bundles -notcontains 'deepseek-worker-connector') {
    throw "Harness profile '$Profile' does not list deepseek-worker-connector in dsh.profile.bundles."
  }
  Write-Host "Harness profile '$Profile' contains the connector bundle. Confirm 0.3.1 self-update status, one-click pairing, Credentials, and Native Harness status in Desktop."
}

Write-Host 'Local checks passed. No Site requests, D1 writes, credential reads, or profile changes were made by this test script.'
