param(
    [string]$SourceDirectory,
    [ValidateSet('spt', 'spt-2013')][string]$Target = 'spt'
)
$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $PSScriptRoot
if (-not $SourceDirectory) { $SourceDirectory = Join-Path $releaseRoot '.local\SourcePauseTool' }
$source = [IO.Path]::GetFullPath($SourceDirectory)
if (-not (Test-Path -LiteralPath (Join-Path $source 'CMakeLists.txt'))) {
    throw 'Run tools/prepare-spt.ps1 first, or pass -SourceDirectory pointing to the prepared source.'
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Install Visual Studio 2022 or 2026 with Desktop development with C++ and MSVC v143 x86/x64 tools.' }
$installations = & $vswhere -products '*' -format json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Visual Studio discovery failed.' }
$vs = $installations | Where-Object {
    $_.isComplete -and ([version]$_.installationVersion).Major -in @(17, 18) -and
    (Test-Path (Join-Path $_.installationPath 'VC\Tools\MSVC\14.4*\bin\Hostx64\x86\cl.exe'))
} | Sort-Object { [version]$_.installationVersion } -Descending | Select-Object -First 1
if (-not $vs) { throw 'MSVC v143 x86/x64 tools were not found. Add that component in Visual Studio Installer (including when using Visual Studio 2026).' }
$major = ([version]$vs.installationVersion).Major
$generator = if ($major -eq 18) { 'Visual Studio 18 2026' } else { 'Visual Studio 17 2022' }
$cmake = Join-Path $vs.installationPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (-not (Test-Path -LiteralPath $cmake)) {
    $command = Get-Command cmake -ErrorAction SilentlyContinue
    if (-not $command) { throw 'Install the C++ CMake tools for Windows component, or put CMake on PATH.' }
    $cmake = $command.Source
}
$build = Join-Path $source "out\build\portal-vs$major-x86"
Write-Output "Building $Target with $generator, Win32, v143."
& $cmake -S $source -B $build -G $generator -A Win32 -T v143 "-DCMAKE_GENERATOR_INSTANCE=$($vs.installationPath)"
if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed. Check the compiler/Windows SDK installation and network access for the pinned Monocle dependency.' }
& $cmake --build $build --config Release --target $Target
if ($LASTEXITCODE -ne 0) { throw 'SPT build failed; see the compiler output above.' }
$dll = Join-Path $source "build\Release\$Target.dll"
if (-not (Test-Path -LiteralPath $dll)) { throw "Build completed without the expected DLL: $dll" }
Write-Output "Built: $dll"
