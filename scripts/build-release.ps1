$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "manifest.json"

if (-not (Test-Path $manifestPath)) {
  throw "manifest.json not found in $repoRoot"
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
$distDir = Join-Path $repoRoot "dist"
$archiveName = "dreamface-v$version.zip"
$archivePath = Join-Path $distDir $archiveName
$stagingDir = Join-Path $distDir "package"

$includeFiles = @(
  "background.js",
  "content_script.js",
  "injected.js",
  "manifest.json",
  "offscreen.html",
  "offscreen.js",
  "popup.html",
  "popup.js",
  "assets/icons/icon16.png",
  "assets/icons/icon32.png",
  "assets/icons/icon48.png",
  "assets/icons/icon128.png",
  "vendor/ffmpeg/814.ffmpeg.js",
  "vendor/ffmpeg/ffmpeg-core.js",
  "vendor/ffmpeg/ffmpeg-core.wasm",
  "vendor/ffmpeg/ffmpeg.js"
)

New-Item -ItemType Directory -Path $distDir -Force | Out-Null

if (Test-Path $stagingDir) {
  Remove-Item $stagingDir -Recurse -Force
}

New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

foreach ($file in $includeFiles) {
  $source = Join-Path $repoRoot $file
  if (-not (Test-Path $source)) {
    throw "Missing required release file: $file"
  }

  $destination = Join-Path $stagingDir $file
  $destinationDir = Split-Path -Parent $destination
  if (-not (Test-Path $destinationDir)) {
    New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
  }

  if ((Get-Item $source) -is [System.IO.DirectoryInfo]) {
    Copy-Item $source $destination -Recurse -Force
  } else {
    Copy-Item $source $destination -Force
  }
}

if (Test-Path $archivePath) {
  Remove-Item $archivePath -Force
}

Compress-Archive -Path (Join-Path $stagingDir "*") -DestinationPath $archivePath -CompressionLevel Optimal
Remove-Item $stagingDir -Recurse -Force

Write-Output "Created $archivePath"
