[CmdletBinding()]
param(
  [Parameter()]
  [string] $Task24Root = 'D:\OpenCode-Benchmark\Task24',

  [Parameter(Mandatory = $true)]
  [string] $BunPath,

  [Parameter()]
  [string] $DatasetCandidate = 'D:\OpenCode-Benchmark\Task24\runs\dataset-sources.candidate.json'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$fixedRoot = 'D:\OpenCode-Benchmark\Task24'
$resolvedRoot = [System.IO.Path]::GetFullPath($Task24Root)
if ($resolvedRoot -cne $fixedRoot) {
  throw 'TASK24_ROOT_MUST_BE_FIXED_D_DRIVE_PATH'
}

$resolvedBun = [System.IO.Path]::GetFullPath($BunPath)
if (-not $resolvedBun.StartsWith('D:\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'TASK24_BUN_MUST_BE_ON_D_DRIVE'
}
if (-not (Test-Path -LiteralPath $resolvedBun -PathType Leaf)) {
  throw 'TASK24_BUN_NOT_FOUND'
}

$resolvedDatasetCandidate = [System.IO.Path]::GetFullPath($DatasetCandidate)
$runsRoot = Join-Path $fixedRoot 'runs'
if (-not $resolvedDatasetCandidate.StartsWith($runsRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'TASK24_DATASET_CANDIDATE_OUTSIDE_RUNS_ROOT'
}

$taskTemp = Join-Path $fixedRoot 'tmp\source-setup-runtime'
$bunCache = Join-Path $fixedRoot 'cache\bun-install'
[System.IO.Directory]::CreateDirectory($taskTemp) | Out-Null
[System.IO.Directory]::CreateDirectory($bunCache) | Out-Null

$previousTemp = $env:TEMP
$previousTmp = $env:TMP
$previousBunCache = $env:BUN_INSTALL_CACHE_DIR
try {
  $env:TEMP = $taskTemp
  $env:TMP = $taskTemp
  $env:BUN_INSTALL_CACHE_DIR = $bunCache
  $repositoryRoot = [System.IO.Directory]::GetParent($PSScriptRoot).FullName
  $setupEntry = Join-Path $repositoryRoot 'packages\benchmark\src\corpus\setup.ts'
  & $resolvedBun $setupEntry '--root' $fixedRoot '--datasets' $resolvedDatasetCandidate
  if ($LASTEXITCODE -ne 0) {
    throw "TASK24_SOURCE_SETUP_FAILED_$LASTEXITCODE"
  }
}
finally {
  $env:TEMP = $previousTemp
  $env:TMP = $previousTmp
  $env:BUN_INSTALL_CACHE_DIR = $previousBunCache
}
