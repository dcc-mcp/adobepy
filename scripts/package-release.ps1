[CmdletBinding()]
param(
    [string]$Version = "",
    [string]$OutDir = "dist",
    [switch]$SkipTests,
    [switch]$IncludePortablePython
)

$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

function Invoke-Step {
    param([string]$Name, [scriptblock]$Action)
    Write-Host ""
    Write-Host "==> $Name"
    & $Action
}

function Invoke-External {
    param([string]$Program, [string[]]$Arguments)
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "command failed ($LASTEXITCODE): $Program $($Arguments -join ' ')"
    }
}

function Copy-Tree {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source)) { throw "missing package input: $Source" }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Copy-File {
    param([string]$Source, [string]$Destination)
    if (-not (Test-Path -LiteralPath $Source)) { throw "missing package input: $Source" }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Write-Utf8NoBom {
    param([string]$Destination, [string]$Content)
    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Destination, $Content, $encoding)
}

function Assert-ChildPath {
    param([string]$Parent, [string]$Child)
    $parentFull = [System.IO.Path]::GetFullPath($Parent).TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $childFull = [System.IO.Path]::GetFullPath($Child)
    if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "refusing to operate outside package output root: $childFull"
    }
}

function Ensure-PythonBuildDependencies {
    $probe = "import importlib.metadata as m, importlib.util, sys; missing = [name for name in ('coverage', 'setuptools', 'wheel') if importlib.util.find_spec(name) is None]; ok = not missing and tuple(map(int, m.version('setuptools').split('.')[:2])) >= (77, 0); sys.exit(0 if ok else 1)"
    & python -c $probe 2>$null
    if ($LASTEXITCODE -ne 0) {
        Invoke-External "python" @("-m", "pip", "install", "--upgrade", "coverage[toml]", "setuptools>=77", "wheel")
    }
}

function Remove-TransientBuildArtifacts {
    param([string]$BasePath)
    $buildPath = Join-Path $BasePath "build"
    if (Test-Path -LiteralPath $buildPath) {
        Remove-Item -LiteralPath $buildPath -Recurse -Force
    }
    Get-ChildItem -LiteralPath $BasePath -Recurse -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq "__pycache__" -or $_.Name.EndsWith(".egg-info") } |
        Remove-Item -Recurse -Force
    Get-ChildItem -LiteralPath $BasePath -Recurse -File -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in @(".pyc", ".pyo") } |
        Remove-Item -Force
}

function Get-Sha256 {
    param([string]$Path)
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") })
        }
        finally { $sha.Dispose() }
    }
    finally { $stream.Dispose() }
}

function Invoke-RemappedCargoReleaseBuild {
    $separator = [char]0x1f
    $previousFlags = $env:CARGO_ENCODED_RUSTFLAGS
    $flags = @()
    if ($previousFlags) { $flags += $previousFlags -split [string]$separator }
    $flags += "--remap-path-prefix=$Root=/workspace"
    if ($env:USERPROFILE) { $flags += "--remap-path-prefix=$($env:USERPROFILE)=/user" }
    $env:CARGO_ENCODED_RUSTFLAGS = $flags -join $separator
    try {
        Invoke-External "cargo" @("build", "--release", "-p", "adobepy-cli", "--bin", "adobepy", "-p", "adobepy-broker", "--bin", "adobepy-bootstrap-helper")
    }
    finally {
        $env:CARGO_ENCODED_RUSTFLAGS = $previousFlags
    }
}

function Assert-NoLocalBuildPaths {
    param([string]$BasePath)
    $needles = @($Root, ($Root -replace "\\", "/"))
    if ($env:USERPROFILE) {
        $needles += $env:USERPROFILE
        $needles += ($env:USERPROFILE -replace "\\", "/")
    }
    foreach ($file in Get-ChildItem -LiteralPath $BasePath -Recurse -File -Force) {
        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        $encodings = @([System.Text.Encoding]::UTF8, [System.Text.Encoding]::Unicode)
        foreach ($encoding in $encodings) {
            $text = $encoding.GetString($bytes)
            foreach ($needle in $needles) {
                if ($needle -and $text.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                    throw "release artifact contains a local build path: $($file.Name)"
                }
            }
        }
    }
}

function Write-Installer {
    param([string]$Destination)
    @'
[CmdletBinding()]
param(
    [string]$Python = "python",
    [switch]$AddToUserPath
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bin = Join-Path $Root "bin"
$Cli = Join-Path $Bin "adobepy.exe"
$Helper = Join-Path $Bin "adobepy-bootstrap-helper.exe"
foreach ($required in @($Cli, $Helper)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "required runtime executable is missing: $([System.IO.Path]::GetFileName($required))"
    }
}

$Wheel = Get-ChildItem -LiteralPath (Join-Path $Root "wheels") -Filter "*.whl" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Wheel) { throw "no Python wheel found" }
& $Python -m pip install --user --force-reinstall $Wheel.FullName
if ($LASTEXITCODE -ne 0) { throw "Python package installation failed" }
if ($AddToUserPath) {
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = if ($current) { $current -split ";" } else { @() }
    if ($parts -notcontains $Bin) {
        [Environment]::SetEnvironmentVariable("Path", ($(if ($current) { "$current;$Bin" } else { $Bin })), "User")
        Write-Host "Added $Bin to user PATH. Open a new terminal."
    }
}
Write-Host "Installed adobepy SDK."
Write-Host "CLI: $Bin\adobepy.exe"
Write-Host "Bootstrap helper: $Bin\adobepy-bootstrap-helper.exe"
'@ | Set-Content -LiteralPath $Destination -Encoding UTF8
}

function Write-DistributionReadme {
    param([string]$Destination, [string]$PackageName, [string]$RuntimeId)
    @"
# adobepy Distribution

Package: $PackageName
Runtime: $RuntimeId

This package contains the release `adobepy` CLI, its fixed sibling bootstrap
helper, Python SDK wheel/source, compiled UXP/CEP bridge templates, IR contracts,
and operation docs.

```powershell
.\install.ps1 -Python python -AddToUserPath
.\bin\adobepy.exe doctor
`$env:ADOBEPY_TOKEN = "choose-a-local-token"
.\bin\adobepy.exe broker --token `$env:ADOBEPY_TOKEN
```

Adobe desktop applications, UXP Developer Tools, CEP host support, and Python
3.8+ are host-machine prerequisites and are not redistributed here.
"@ | Set-Content -LiteralPath $Destination -Encoding UTF8
}

function Get-RuntimeId {
    if ($env:OS -eq "Windows_NT") { return "windows-x64" }
    if ($IsMacOS) { return "macos-x64" }
    if ($IsLinux) { return "linux-x64" }
    return "unknown"
}

if (-not $Version) {
    $Version = (Get-Content -Raw "package.json" | ConvertFrom-Json).version
}

$runtimeId = Get-RuntimeId
$packageName = "adobepy-$Version-$runtimeId"
$distRoot = [System.IO.Path]::GetFullPath((Join-Path $Root $OutDir))
$stageRoot = [System.IO.Path]::GetFullPath((Join-Path $distRoot $packageName))
$zipPath = Join-Path $distRoot "$packageName.zip"
$hashPath = "$zipPath.sha256"

Invoke-Step "Verify release version projection" {
    Invoke-External "node" @("scripts\check-release-versions.js", "--root", $Root, "--expected", $Version)
}

Assert-ChildPath -Parent $distRoot -Child $stageRoot
New-Item -ItemType Directory -Force -Path $distRoot | Out-Null
if (Test-Path -LiteralPath $stageRoot) {
    Get-ChildItem -LiteralPath $stageRoot -Force | Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
}
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
if (Test-Path -LiteralPath $hashPath) { Remove-Item -LiteralPath $hashPath -Force }

Invoke-Step "Install Node dependencies if needed" {
    if (-not (Test-Path -LiteralPath "node_modules")) {
        Invoke-External "npm" @("ci")
    }
}

Invoke-Step "Ensure Python build/test dependencies" { Ensure-PythonBuildDependencies }

if (-not $SkipTests) {
    Invoke-Step "Run full verification" { Invoke-External "npm" @("run", "test:all") }
}

Invoke-Step "Build release CLI" {
    Invoke-RemappedCargoReleaseBuild
}

Invoke-Step "Build bridge bundles" {
    Invoke-External "npm" @("run", "uxp:build")
    Invoke-External "npm" @("run", "cep:build")
}

Invoke-Step "Clean transient Python build artifacts" { Remove-TransientBuildArtifacts $Root }

Invoke-Step "Stage distribution tree" {
    New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot "bin") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $stageRoot "wheels") | Out-Null
    Copy-File (Join-Path $Root "target\release\adobepy.exe") (Join-Path $stageRoot "bin\adobepy.exe")
    Copy-File (Join-Path $Root "target\release\adobepy-bootstrap-helper.exe") (Join-Path $stageRoot "bin\adobepy-bootstrap-helper.exe")
    foreach ($dir in @("python", "bridges", "docs", "generators")) { Copy-Tree $dir (Join-Path $stageRoot $dir) }
    foreach ($file in @("README.md", "install.md", "pyproject.toml", "package.json", "package-lock.json", "Cargo.toml", "Cargo.lock")) {
        Copy-File $file (Join-Path $stageRoot $file)
    }
    if ($IncludePortablePython -and (Test-Path -LiteralPath ".adobepy\python")) {
        Copy-Tree ".adobepy\python" (Join-Path $stageRoot "python-runtime")
    }
}

Invoke-Step "Build Python wheel" {
    Invoke-External "python" @("scripts\check_native_abi3_config.py")
    Invoke-External "python" @("-m", "pip", "wheel", "--no-deps", "--no-build-isolation", "--wheel-dir", (Join-Path $stageRoot "wheels"), ".")
    Invoke-External "python" @("scripts\check_wheel_compat.py", (Join-Path $stageRoot "wheels"))
    Remove-TransientBuildArtifacts $Root
}

Invoke-Step "Write package docs and manifest" {
    Write-Installer (Join-Path $stageRoot "install.ps1")
    Write-DistributionReadme (Join-Path $stageRoot "DISTRIBUTION-README.md") $packageName $runtimeId
    $manifest = [ordered]@{
        name = "adobepy"
        version = $Version
        runtime = $runtimeId
        builtAt = (Get-Date).ToUniversalTime().ToString("o")
        commands = @("vx just package", ".\install.ps1 -Python python -AddToUserPath", ".\bin\adobepy.exe doctor")
        includes = @("bin/adobepy.exe", "bin/adobepy-bootstrap-helper.exe", "wheels/*.whl", "python/adobe", "bridges/uxp", "bridges/cep", "docs", "generators/ir", "install.md")
        notes = @("Rust dependencies are linked into the release executables.", "The bootstrap helper is resolved only as a canonical sibling of adobepy.exe.", "Bridge JavaScript dependencies are bundled into bridges/**/dist.", "The Python SDK wheel remains pure Python and does not contain native executables.")
    } | ConvertTo-Json -Depth 8
    Write-Utf8NoBom (Join-Path $stageRoot "package-manifest.json") $manifest
}

Invoke-Step "Verify staged release version projection" {
    Invoke-External "node" @("scripts\check-release-versions.js", "--root", $stageRoot, "--expected", $Version)
}

Invoke-Step "Verify release privacy" { Assert-NoLocalBuildPaths $stageRoot }

Invoke-Step "Create archive and checksum" {
    Remove-TransientBuildArtifacts $stageRoot
    Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -Force
    $hash = Get-Sha256 $zipPath
    "$hash  $(Split-Path -Leaf $zipPath)" | Set-Content -LiteralPath $hashPath -Encoding ASCII
}

Write-Host ""
Write-Host "Package directory: $stageRoot"
Write-Host "Archive: $zipPath"
Write-Host "SHA256: $hashPath"
