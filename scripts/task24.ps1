[CmdletBinding()]
param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]] $Task24Arguments
)

$ErrorActionPreference = 'Stop'
$Task24Root = 'D:\OpenCode-Benchmark\Task24'
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Bun = 'D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe'
$BunSha256 = '0187f68d843f825a72ada4a7eca60db896ed753759a7f8252edcd31ac1bf1b9c'
$BrowserBuild = '76480acc05806aa66c02f1cf36e74e662c676093fc00cb8b2c14cac35d613c06'
$BrowserRoot = Join-Path $Task24Root "toolchain\browser\$BrowserBuild"
$BrowserNode = Join-Path $BrowserRoot 'node.exe'
$BrowserNodeSha256 = '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de'
$CandidateFile = Join-Path $Task24Root 'runs\preregistration.candidate.json'
$Cli = Join-Path $RepositoryRoot 'packages\benchmark\src\cli.ts'

function Resolve-SafeDPath([string] $Value, [string] $Label) {
  $resolved = [System.IO.Path]::GetFullPath($Value)
  if (-not $resolved.StartsWith('D:\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "TASK24_WRAPPER_${Label}_OUTSIDE_D"
  }
  $cursor = $resolved
  while (-not (Test-Path -LiteralPath $cursor)) {
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) {
      throw "TASK24_WRAPPER_${Label}_ANCESTOR_MISSING"
    }
    $cursor = $parent
  }
  while (Test-Path -LiteralPath $cursor) {
    $item = Get-Item -LiteralPath $cursor -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "TASK24_WRAPPER_${Label}_REPARSE"
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
  if (Test-Path -LiteralPath $resolved) {
    $canonical = (Resolve-Path -LiteralPath $resolved).Path
    if (-not $canonical.Equals($resolved, [StringComparison]::OrdinalIgnoreCase)) {
      throw "TASK24_WRAPPER_${Label}_NONCANONICAL"
    }
  }
  return $resolved
}

function Assert-FileSha256([string] $Path, [string] $Expected, [string] $Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "TASK24_WRAPPER_${Label}_MISSING" }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) { throw "TASK24_WRAPPER_${Label}_HASH_MISMATCH" }
}

if (-not $Task24Arguments -or $Task24Arguments.Count -eq 0) { throw 'TASK24_COMMAND_INVALID' }
$null = Resolve-SafeDPath $Task24Root 'ROOT'
$null = Resolve-SafeDPath $RepositoryRoot 'REPOSITORY_ROOT'
$null = Resolve-SafeDPath $Bun 'BUN'
$null = Resolve-SafeDPath $BrowserRoot 'BROWSER'
$null = Resolve-SafeDPath $BrowserNode 'BROWSER_NODE'
$null = Resolve-SafeDPath $CandidateFile 'CANDIDATE'
$null = Resolve-SafeDPath $Cli 'CLI'
Assert-FileSha256 $Bun $BunSha256 'BUN'
Assert-FileSha256 $BrowserNode $BrowserNodeSha256 'BROWSER_NODE'
if (-not (Test-Path -LiteralPath $RepositoryRoot -PathType Container)) { throw 'TASK24_WRAPPER_REPOSITORY_ROOT_MISSING' }
if (-not (Test-Path -LiteralPath $CandidateFile -PathType Leaf)) { throw 'TASK24_WRAPPER_CANDIDATE_MISSING' }
if (-not (Test-Path -LiteralPath $Cli -PathType Leaf)) { throw 'TASK24_WRAPPER_CLI_MISSING' }
if ((& $Bun --version).Trim() -ne '1.3.14') { throw 'TASK24_WRAPPER_BUN_VERSION_MISMATCH' }

$candidate = Get-Content -LiteralPath $CandidateFile -Raw | ConvertFrom-Json
$binaryPaths = @{
  modified = 'D:\OpenCode-Local\bin\opencode-local.exe'
  upstream = Join-Path $Task24Root 'toolchain\upstream\opencode.exe'
}
foreach ($runtime in @('modified', 'upstream')) {
  $lock = $candidate.binaries.$runtime
  $binary = $binaryPaths[$runtime]
  $null = Resolve-SafeDPath $binary "${runtime}_BINARY"
  if (Test-Path -LiteralPath $binary -PathType Leaf) {
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $binary).Hash.ToLowerInvariant()
    if (-not $lock.version.Contains('candidate') -and $actual -ne $lock.sha256.ToLowerInvariant()) {
      throw "TASK24_WRAPPER_${runtime}_BINARY_HASH_MISMATCH"
    }
  } elseif (-not $lock.version.Contains('candidate')) {
    throw "TASK24_WRAPPER_${runtime}_BINARY_MISSING"
  }
}

$task24Temp = Resolve-SafeDPath (Join-Path $Task24Root 'tmp') 'TEMP_ROOT'
$processRoot = Join-Path $task24Temp ("wrapper-$PID-" + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $processRoot) { throw 'TASK24_WRAPPER_TEMP_CONFLICT' }
[IO.Directory]::CreateDirectory($processRoot) | Out-Null
$null = Resolve-SafeDPath $processRoot 'PROCESS_ROOT'
$directories = @{
  TEMP = Join-Path $processRoot 'temp'
  TMP = Join-Path $processRoot 'temp'
  BUN_INSTALL_CACHE_DIR = Join-Path $Task24Root 'cache\bun'
  npm_config_cache = Join-Path $Task24Root 'cache\npm'
  XDG_CONFIG_HOME = Join-Path $Task24Root 'cache\xdg-config'
  XDG_DATA_HOME = Join-Path $Task24Root 'cache\xdg-data'
  XDG_CACHE_HOME = Join-Path $Task24Root 'cache\xdg-cache'
  PLAYWRIGHT_BROWSERS_PATH = Join-Path $BrowserRoot 'browser'
}
foreach ($entry in $directories.GetEnumerator()) {
  $null = Resolve-SafeDPath $entry.Value $entry.Key
  [System.IO.Directory]::CreateDirectory($entry.Value) | Out-Null
  [System.Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
}
$env:OPENCODE_DISABLE_AUTOUPDATE = '1'
$env:OPENCODE_DISABLE_MODELS_FETCH = '1'
$env:OPENCODE_DISABLE_PRUNE = '1'
$env:TASK24_OFFLINE_ONLY = if ($Task24Arguments -contains '--offline' -or $Task24Arguments -contains 'offline') { '1' } else { '0' }

Push-Location (Join-Path $RepositoryRoot 'packages\benchmark')
$taskExitCode = 0
try {
  & $Bun $Cli @Task24Arguments --root $Task24Root
  $taskExitCode = $LASTEXITCODE
} finally {
  Pop-Location
  $resolvedProcessRoot = [System.IO.Path]::GetFullPath($processRoot)
  $resolvedTempRoot = Resolve-SafeDPath $task24Temp 'TEMP_ROOT'
  if ([System.IO.Path]::GetDirectoryName($resolvedProcessRoot) -ne $resolvedTempRoot) {
    throw 'TASK24_WRAPPER_CLEANUP_UNSAFE'
  }
  if ([System.IO.Directory]::Exists($resolvedProcessRoot)) {
    $null = Resolve-SafeDPath $resolvedProcessRoot 'PROCESS_ROOT'
    $directories = [Collections.Generic.List[string]]::new()
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($resolvedProcessRoot)
    while ($pending.Count -gt 0) {
      $directory = $pending.Pop()
      $directories.Add($directory)
      foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
        $attributes = [IO.File]::GetAttributes($entry)
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          throw 'TASK24_WRAPPER_CLEANUP_REPARSE'
        }
        if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
          $pending.Push($entry)
        } else {
          [IO.File]::SetAttributes($entry, [IO.FileAttributes]::Normal)
          [IO.File]::Delete($entry)
        }
      }
    }
    for ($index = $directories.Count - 1; $index -ge 0; $index--) {
      [IO.Directory]::Delete($directories[$index], $false)
    }
  }
}
if ($taskExitCode -ne 0) { exit $taskExitCode }
