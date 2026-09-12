[CmdletBinding()]
param(
  [string]$SourceRoot = "D:\OpenCode-Audit",
  [string]$TaskRoot = "D:\OpenCode-Benchmark\Task24",
  [string]$NodePath = "D:\Applications\nodejs\node.exe",
  [string]$BunPath = "D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe",
  [string]$BrowserSource = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-DirectDirectory {
  param([string]$Value, [string]$Name)
  if (-not [IO.Path]::IsPathRooted($Value)) { throw "$Name must be absolute" }
  $lexical = [IO.Path]::GetFullPath($Value).TrimEnd("\")
  if ($lexical -notmatch '^D:\\') { throw "$Name must be on D drive" }
  if (-not (Test-Path -LiteralPath $lexical -PathType Container)) { throw "$Name does not exist" }
  $item = Get-Item -LiteralPath $lexical -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Name must not be redirected" }
  $resolved = (Resolve-Path -LiteralPath $lexical).Path.TrimEnd("\")
  if (-not $resolved.Equals($lexical, [StringComparison]::Ordinal)) { throw "$Name must be canonical" }
  return $resolved
}

function Resolve-DirectFile {
  param([string]$Value, [string]$Name)
  if (-not [IO.Path]::IsPathRooted($Value)) { throw "$Name must be absolute" }
  $lexical = [IO.Path]::GetFullPath($Value)
  if ($lexical -notmatch '^D:\\') { throw "$Name must be on D drive" }
  if (-not (Test-Path -LiteralPath $lexical -PathType Leaf)) { throw "$Name does not exist" }
  $item = Get-Item -LiteralPath $lexical -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.LinkType -eq "HardLink") {
    throw "$Name must be one ordinary file"
  }
  $resolved = (Resolve-Path -LiteralPath $lexical).Path
  if (-not $resolved.Equals($lexical, [StringComparison]::Ordinal)) { throw "$Name must be canonical" }
  return $resolved
}

function Assert-StrictChild {
  param([string]$Parent, [string]$Child, [string]$Name)
  $prefix = $Parent.TrimEnd("\") + "\"
  if (-not $Child.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "$Name escaped its root" }
}

function Remove-OwnedTree {
  param([string]$Root, [string]$Parent)
  $resolved = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  Assert-StrictChild -Parent $Parent -Child $resolved -Name "Cleanup target"
  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { return }
  foreach ($file in Get-ChildItem -LiteralPath $resolved -File -Force -Recurse) { [IO.File]::Delete($file.FullName) }
  $directories = @(Get-ChildItem -LiteralPath $resolved -Directory -Force -Recurse | Sort-Object { $_.FullName.Length } -Descending)
  foreach ($directory in $directories) { [IO.Directory]::Delete($directory.FullName, $false) }
  [IO.Directory]::Delete($resolved, $false)
}

$source = Resolve-DirectDirectory -Value $SourceRoot -Name "SourceRoot"
$task = Resolve-DirectDirectory -Value $TaskRoot -Name "TaskRoot"
$node = Resolve-DirectFile -Value $NodePath -Name "NodePath"
$bun = Resolve-DirectFile -Value $BunPath -Name "BunPath"
$helper = Resolve-DirectFile -Value (Join-Path $source "packages\benchmark\src\evaluator\browser-node-helper.ts") -Name "Helper source"
$playwrightCli = Resolve-DirectFile -Value (Join-Path $source "packages\benchmark\node_modules\playwright\cli.js") -Name "Playwright CLI"
Assert-StrictChild -Parent $source -Child $helper -Name "Helper source"
Assert-StrictChild -Parent $source -Child $playwrightCli -Name "Playwright CLI"

$toolchain = Join-Path $task "toolchain"
$browserRoot = Join-Path $toolchain "browser"
$tmpRoot = Join-Path $task "tmp"
[IO.Directory]::CreateDirectory($browserRoot) | Out-Null
$browserRoot = Resolve-DirectDirectory -Value $browserRoot -Name "Browser output root"
$tmpRoot = Resolve-DirectDirectory -Value $tmpRoot -Name "Task temp root"
$stage = Join-Path $tmpRoot ("browser-build-" + [Guid]::NewGuid().ToString("N"))
$runtime = Join-Path $stage "runtime"
$publishedDestination = $null
$completed = $false
[IO.Directory]::CreateDirectory($runtime) | Out-Null

try {
  $saved = [ordered]@{}
  foreach ($name in @("TEMP", "TMP", "TMPDIR", "BUN_INSTALL_CACHE_DIR", "PLAYWRIGHT_BROWSERS_PATH", "npm_config_cache")) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  try {
    [Environment]::SetEnvironmentVariable("TEMP", $stage, "Process")
    [Environment]::SetEnvironmentVariable("TMP", $stage, "Process")
    [Environment]::SetEnvironmentVariable("TMPDIR", $stage, "Process")
    [Environment]::SetEnvironmentVariable("BUN_INSTALL_CACHE_DIR", (Join-Path $stage "bun-cache"), "Process")
    [Environment]::SetEnvironmentVariable("npm_config_cache", (Join-Path $stage "npm-cache"), "Process")
    [Environment]::SetEnvironmentVariable("PLAYWRIGHT_BROWSERS_PATH", (Join-Path $runtime "browser"), "Process")
    $bundleRoot = Join-Path $runtime "app"
    & $bun build $helper --target=node "--outdir=$bundleRoot"
    if ($LASTEXITCODE -ne 0) { throw "Task24 browser helper bundle failed" }
    Copy-Item -LiteralPath $node -Destination (Join-Path $runtime "node.exe")
    if ([string]::IsNullOrWhiteSpace($BrowserSource)) {
      & $node $playwrightCli install chromium
      if ($LASTEXITCODE -ne 0) { throw "Pinned Playwright Chromium installation failed" }
    } else {
      $browserSourcePath = Resolve-DirectDirectory -Value $BrowserSource -Name "BrowserSource"
      Copy-Item -LiteralPath $browserSourcePath -Destination (Join-Path $runtime "browser") -Recurse
    }
  } finally {
    foreach ($entry in $saved.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
    }
  }

  $helperBundle = Resolve-DirectFile -Value (Join-Path $runtime "app\browser-node-helper.js") -Name "Bundled helper"
  Assert-StrictChild -Parent $runtime -Child $helperBundle -Name "Bundled helper"

  $chromium = @(Get-ChildItem -LiteralPath (Join-Path $runtime "browser") -Recurse -File -Filter "chrome.exe" | Where-Object {
    $_.FullName -match '\\chromium-[0-9]+\\chrome-win64\\chrome\.exe$'
  })
  if ($chromium.Count -ne 1) { throw "Expected exactly one pinned Chromium executable" }
  $browserExecutable = Resolve-DirectFile -Value $chromium[0].FullName -Name "Chromium executable"
  Assert-StrictChild -Parent $runtime -Child $browserExecutable -Name "Chromium executable"

  $manifestBuilder = Resolve-DirectFile -Value (Join-Path $source "packages\benchmark\script\build-browser-manifest.ts") -Name "Manifest builder"
  $buildOutput = @(& $bun $manifestBuilder $runtime $helperBundle $browserExecutable)
  if ($LASTEXITCODE -ne 0) { throw "Task24 browser manifest generation failed" }
  $buildHash = [string]$buildOutput[-1]
  if ($buildHash -notmatch '^[a-f0-9]{64}$') { throw "Task24 browser build hash is invalid" }
  $destination = Join-Path $browserRoot $buildHash
  if (Test-Path -LiteralPath $destination) {
    Remove-OwnedTree -Root $runtime -Parent $stage
  } else {
    [IO.Directory]::Move($runtime, $destination)
    $publishedDestination = $destination
  }
  & $bun -e "import { loadBrowserRelease } from './packages/benchmark/src/evaluator/browser-runtime.ts'; loadBrowserRelease(process.argv[1]);" $destination
  if ($LASTEXITCODE -ne 0) { throw "Installed Task24 browser runtime failed integrity verification" }
  $completed = $true
  Write-Output "Installed Task24 browser runtime: $destination"
  Write-Output "Build SHA256: $buildHash"
} finally {
  if (-not $completed -and $null -ne $publishedDestination) {
    Remove-OwnedTree -Root $publishedDestination -Parent $browserRoot
  }
  Remove-OwnedTree -Root $stage -Parent $tmpRoot
}
