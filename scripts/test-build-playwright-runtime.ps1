[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$buildScript = Join-Path $PSScriptRoot "build-playwright-runtime.ps1"
$testParent = "D:\OpenCode-Local\tmp\playwright-runtime-tests"
$caseRoot = Join-Path $testParent ("case-" + [Guid]::NewGuid().ToString("N"))
$browserRoot = Join-Path $caseRoot "runtime\playwright"

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function Remove-ExactTree {
  param([string]$Root)
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return }
  $resolved = (Resolve-Path -LiteralPath $Root).Path
  $expected = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  if (-not $resolved.Equals($expected, [StringComparison]::Ordinal) -or -not $resolved.StartsWith($testParent + "\", [StringComparison]::Ordinal)) {
    throw "Refusing to remove an unexpected test root"
  }
  Get-ChildItem -LiteralPath $resolved -Force -Recurse | Sort-Object { $_.FullName.Split([IO.Path]::DirectorySeparatorChar).Count } -Descending | ForEach-Object {
    if ($_.PSIsContainer) { [IO.Directory]::Delete($_.FullName, $false) } else { [IO.File]::Delete($_.FullName) }
  }
  [IO.Directory]::Delete($resolved, $false)
}

[IO.Directory]::CreateDirectory($browserRoot) | Out-Null
try {
  & $buildScript -SourceRoot $repositoryRoot -BrowserRoot $browserRoot | Out-Null
  $manifestPath = Join-Path $browserRoot "opencode-playwright-runtime.manifest.json"
  Assert-True (Test-Path -LiteralPath $manifestPath -PathType Leaf) "Runtime manifest was not installed"
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Assert-True ($manifest.schemaVersion -eq 1 -and $manifest.protocolVersion -eq 1) "Runtime manifest version is invalid"
  $nodePath = Join-Path $browserRoot ([string]$manifest.nodeFile)
  $helperPath = Join-Path $browserRoot ([string]$manifest.helperFile)
  Assert-True ((Get-FileHash -LiteralPath $nodePath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq [string]$manifest.nodeSha256) "Node hash is invalid"
  Assert-True ((Get-FileHash -LiteralPath $helperPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq [string]$manifest.helperSha256) "Helper hash is invalid"

  & $buildScript -SourceRoot $repositoryRoot -BrowserRoot $browserRoot | Out-Null
  Assert-True (@(Get-ChildItem -LiteralPath $browserRoot -File -Filter "opencode-node-*.exe").Count -eq 1) "Idempotent install duplicated Node"
  Assert-True (@(Get-ChildItem -LiteralPath $browserRoot -File -Filter "opencode-playwright-helper-*.mjs").Count -eq 1) "Idempotent install duplicated helper"

  $rejected = $false
  try {
    & $buildScript -SourceRoot $repositoryRoot -BrowserRoot "C:\Windows" | Out-Null
  } catch {
    $rejected = $_.Exception.Message -match "D drive"
  }
  Assert-True $rejected "C-drive browser root was not rejected"
  Write-Output "Playwright runtime build tests passed"
} finally {
  Remove-ExactTree -Root $caseRoot
}
