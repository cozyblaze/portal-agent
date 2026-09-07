param([string]$Destination)
$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $PSScriptRoot
if (-not $Destination) { $Destination = Join-Path $releaseRoot '.local\SourcePauseTool' }
$target = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $target) { throw "Refusing to overwrite existing directory: $target" }
$upstream = Get-Content -LiteralPath (Join-Path $releaseRoot 'spt\UPSTREAM.json') -Raw | ConvertFrom-Json
function Invoke-GitChecked { param([string[]]$GitArgs) & git @GitArgs; if ($LASTEXITCODE -ne 0) { throw "Git failed (exit $LASTEXITCODE)" } }
Invoke-GitChecked -GitArgs @('clone', $upstream.repository, $target)
Invoke-GitChecked -GitArgs @('-C', $target, 'checkout', '--detach', $upstream.base_commit)
Invoke-GitChecked -GitArgs @('-C', $target, 'submodule', 'update', '--init', '--recursive')
$patch = Join-Path $releaseRoot 'spt\portal-agent.patch'
Invoke-GitChecked -GitArgs @('-C', $target, 'apply', '--check', $patch)
Invoke-GitChecked -GitArgs @('-C', $target, 'apply', $patch)
Write-Output "Patched source prepared at $target"
