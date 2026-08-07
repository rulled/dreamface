[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$manifestPath = Join-Path $repoRoot 'manifest.json'
$runtimeFiles = @(
    'manifest.json'
    'background.js'
    'content_script.js'
    'injected.js'
    'media-transform.js'
    'offscreen.js'
    'popup.js'
    'offscreen.html'
    'popup.html'
)
$runtimeDirectories = @('assets', 'vendor')
$stagingPath = Join-Path ([System.IO.Path]::GetTempPath()) ("dreamface-release-{0}" -f [guid]::NewGuid().ToString('N'))
$temporaryZipPath = Join-Path ([System.IO.Path]::GetTempPath()) ("dreamface-release-{0}.zip" -f [guid]::NewGuid().ToString('N'))

try {
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Required file is missing: $manifestPath"
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $version = [string]$manifest.version
    if ($version -notmatch '^\d+(\.\d+){0,3}$') {
        throw "manifest.json has an invalid Chrome extension version: '$version'"
    }

    New-Item -ItemType Directory -Path $stagingPath | Out-Null

    foreach ($relativePath in $runtimeFiles) {
        $sourcePath = Join-Path $repoRoot $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Required runtime file is missing: $relativePath"
        }

        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $stagingPath $relativePath)
    }

    foreach ($relativePath in $runtimeDirectories) {
        $sourcePath = Join-Path $repoRoot $relativePath
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
            throw "Required runtime directory is missing: $relativePath"
        }

        Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $stagingPath $relativePath) -Recurse
    }

    if (-not (Test-Path -LiteralPath (Join-Path $stagingPath 'manifest.json') -PathType Leaf)) {
        throw 'Staging validation failed: manifest.json is not at the package root.'
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $stagingPath,
        $temporaryZipPath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )

    $archive = [System.IO.Compression.ZipFile]::OpenRead($temporaryZipPath)
    try {
        $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
        if ($entries -notcontains 'manifest.json') {
            throw 'Archive validation failed: manifest.json is not at the ZIP root.'
        }

        $forbiddenEntries = @($entries | Where-Object {
            $_ -match '(^|/)\.git(/|$)' -or
            $_ -match '(^|/)Users_[^/]*\.js$' -or
            $_ -match '(^|/)(AVATAR_BULK_RESEARCH|PRODUCT)\.md$'
        })
        if ($forbiddenEntries.Count -gt 0) {
            throw "Archive validation failed; forbidden entries found: $($forbiddenEntries -join ', ')"
        }

        $unexpectedEntries = @($entries | Where-Object {
            $_ -ne 'manifest.json' -and
            $_ -notin $runtimeFiles -and
            $_ -notmatch '^(assets|vendor)/'
        })
        if ($unexpectedEntries.Count -gt 0) {
            throw "Archive validation failed; entries outside the allowlist found: $($unexpectedEntries -join ', ')"
        }
    }
    finally {
        $archive.Dispose()
    }

    $distPath = Join-Path $repoRoot 'dist'
    if (-not (Test-Path -LiteralPath $distPath)) {
        New-Item -ItemType Directory -Path $distPath | Out-Null
    }

    $outputPath = Join-Path $distPath ("dreamface-batch-assistant-v{0}.zip" -f $version)
    Move-Item -LiteralPath $temporaryZipPath -Destination $outputPath -Force
    Write-Output $outputPath
}
finally {
    if (Test-Path -LiteralPath $stagingPath) {
        Remove-Item -LiteralPath $stagingPath -Recurse -Force
    }

    if (Test-Path -LiteralPath $temporaryZipPath) {
        Remove-Item -LiteralPath $temporaryZipPath -Force
    }
}
