[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ZipPath,
    [string]$Python = "python"
)

$ErrorActionPreference = "Stop"

$zipPath = [System.IO.Path]::GetFullPath($ZipPath)
if (-not (Test-Path -LiteralPath $zipPath)) {
    throw "zip not found: $zipPath"
}

Write-Host "==> Smoke test: $zipPath"

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "adobepy-smoke-$([System.IO.Path]::GetRandomFileName())"
try {
    Write-Host "Extracting to $tempDir..."
    Expand-Archive -LiteralPath $zipPath -DestinationPath $tempDir -Force

    $extractedRoot = Get-ChildItem -LiteralPath $tempDir -Directory | Select-Object -First 1
    if (-not $extractedRoot) {
        throw "no root directory found inside zip"
    }
    Write-Host "Extracted root: $($extractedRoot.FullName)"

    $installScript = Join-Path $extractedRoot.FullName "install.ps1"
    if (-not (Test-Path -LiteralPath $installScript)) {
        throw "install.ps1 not found in package"
    }

    Write-Host "Running install.ps1..."
    Push-Location $extractedRoot.FullName
    try {
        & $installScript -Python $Python
        if ($LASTEXITCODE -ne 0) {
            throw "install.ps1 failed ($LASTEXITCODE)"
        }
    }
    finally {
        Pop-Location
    }

    Write-Host "Verifying SDK import..."
    & $Python -c @"
from adobe.photoshop import Photoshop
from adobe.indesign import InDesign
from adobe.premiere import Premiere
from adobe.after_effects import AfterEffects
from adobe.illustrator import Illustrator
from adobe.raw import RawSession
from adobe.dcc_mcp import adobe_success
assert Photoshop.__name__ == 'Photoshop'
assert adobe_success('ok')['success'] is True
print('SDK import smoke passed')
"@
    if ($LASTEXITCODE -ne 0) {
        throw "SDK import verification failed ($LASTEXITCODE)"
    }

    $doctorExe = Join-Path $extractedRoot.FullName "bin" "adobepy.exe"
    if (-not (Test-Path -LiteralPath $doctorExe)) {
        throw "adobepy.exe not found at $doctorExe"
    }

    Write-Host "Running adobepy doctor --json..."
    Push-Location $extractedRoot.FullName
    try {
        $doctorOutput = & $doctorExe doctor --json 2>&1
        $doctorCode = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }

    if ($doctorCode -ne 0) {
        throw "adobepy doctor exited with $doctorCode`n$($doctorOutput -join "`n")"
    }

    $doctorResults = ($doctorOutput | Out-String).Trim() | ConvertFrom-Json
    $unexpectedFails = @($doctorResults | Where-Object { -not $_.ok -and $_.name -ne 'broker_port' })
    if ($unexpectedFails.Count -gt 0) {
        $details = ($unexpectedFails | ForEach-Object { "  $($_.name): $($_.detail)" }) -join "`n"
        throw "adobepy doctor found unexpected failures:`n$details"
    }

    Write-Host "Doctor results:"
    $doctorResults | ForEach-Object {
        $status = if ($_.ok) { " ok " } else { "warn" }
        Write-Host "  [$status] $($_.name): $($_.detail)"
    }

    Write-Host "Install smoke test passed"
}
finally {
    if (Test-Path -LiteralPath $tempDir) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
