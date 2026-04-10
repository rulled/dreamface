$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "manifest.json"

if (-not (Test-Path $manifestPath)) {
  throw "manifest.json not found in $repoRoot"
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
$sourceDir = Join-Path $repoRoot "store-assets"
$distDir = Join-Path $repoRoot "dist"
$archivePath = Join-Path $distDir "dreamface-store-assets-v$version.zip"

if (-not (Test-Path $sourceDir)) {
  throw "store-assets directory not found"
}

New-Item -ItemType Directory -Path $distDir -Force | Out-Null

if (Test-Path $archivePath) {
  Remove-Item $archivePath -Force
}

Compress-Archive -Path (Join-Path $sourceDir "*") -DestinationPath $archivePath -CompressionLevel Optimal

Write-Output "Created $archivePath"
