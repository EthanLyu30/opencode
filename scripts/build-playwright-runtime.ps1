[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [Parameter(Mandatory = $true)][string]$BrowserRoot,
  [string]$NodePath = "D:\Applications\nodejs\node.exe",
  [string]$BunPath = "D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$helperRelative = "packages\server\src\workflow\playwright-node-helper.ts"
$manifestName = "opencode-playwright-runtime.manifest.json"

function Assert-SafeLiteral {
  param([string]$Value, [string]$Name)
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\x00-\x1f\x7f"%!!^&|<>]') {
    throw "$Name contains unsupported characters"
  }
}

function Resolve-ExactDDirectory {
  param([string]$Value, [string]$Name)
  Assert-SafeLiteral -Value $Value -Name $Name
  if (-not [IO.Path]::IsPathRooted($Value)) { throw "$Name must be absolute" }
  $lexical = [IO.Path]::GetFullPath($Value).TrimEnd("\")
  if ($lexical -notmatch '^D:\\') { throw "$Name must be on D drive" }
  if (-not (Test-Path -LiteralPath $lexical -PathType Container)) { throw "$Name does not exist" }
  $item = Get-Item -LiteralPath $lexical -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Name must not be redirected" }
  $resolved = (Resolve-Path -LiteralPath $lexical).Path.TrimEnd("\")
  if (-not $resolved.Equals($lexical, [StringComparison]::Ordinal)) { throw "$Name must use canonical spelling" }
  return $resolved
}

function Resolve-ExactDFile {
  param([string]$Value, [string]$Name)
  Assert-SafeLiteral -Value $Value -Name $Name
  if (-not [IO.Path]::IsPathRooted($Value)) { throw "$Name must be absolute" }
  $lexical = [IO.Path]::GetFullPath($Value)
  if ($lexical -notmatch '^D:\\') { throw "$Name must be on D drive" }
  if (-not (Test-Path -LiteralPath $lexical -PathType Leaf)) { throw "$Name does not exist" }
  $item = Get-Item -LiteralPath $lexical -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.LinkType -eq "HardLink") {
    throw "$Name must be one ordinary file"
  }
  $resolved = (Resolve-Path -LiteralPath $lexical).Path
  if (-not $resolved.Equals($lexical, [StringComparison]::Ordinal)) { throw "$Name must use canonical spelling" }
  return $resolved
}

function Assert-ContainedFile {
  param([string]$Root, [string]$File, [string]$Name)
  $prefix = $Root.TrimEnd("\") + "\"
  if (-not $File.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "$Name escaped its root" }
}

function Install-ContentAddressedFile {
  param([string]$Source, [string]$Destination)
  if (Test-Path -LiteralPath $Destination) {
    $existing = Resolve-ExactDFile -Value $Destination -Name "Existing runtime artifact"
    if ((Get-FileHash -LiteralPath $existing -Algorithm SHA256).Hash -cne (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash) {
      throw "Content-addressed runtime artifact has unexpected bytes"
    }
    return
  }
  $staged = "$Destination.new-$([Guid]::NewGuid().ToString('N'))"
  Copy-Item -LiteralPath $Source -Destination $staged
  try {
    $resolved = Resolve-ExactDFile -Value $staged -Name "Staged runtime artifact"
    [IO.File]::Move($resolved, $Destination, $false)
  } finally {
    if (Test-Path -LiteralPath $staged -PathType Leaf) { [IO.File]::Delete($staged) }
  }
}

function Remove-ObsoleteContentAddressedFiles {
  param([string]$Root, [string]$KeepNode, [string]$KeepHelper)
  foreach ($item in Get-ChildItem -LiteralPath $Root -File -Force) {
    $match = [regex]::Match($item.Name, '^opencode-(?:node-([a-f0-9]{64})\.exe|playwright-helper-([a-f0-9]{64})\.mjs)$')
    if (-not $match.Success -or $item.Name -ceq $KeepNode -or $item.Name -ceq $KeepHelper) { continue }
    $resolved = Resolve-ExactDFile -Value $item.FullName -Name "Obsolete content-addressed runtime artifact"
    $expectedHash = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    if ((Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expectedHash) {
      throw "Obsolete content-addressed runtime artifact does not match its filename"
    }
    [IO.File]::Delete($resolved)
  }
}

$source = Resolve-ExactDDirectory -Value $SourceRoot -Name "SourceRoot"
$browser = Resolve-ExactDDirectory -Value $BrowserRoot -Name "BrowserRoot"
$node = Resolve-ExactDFile -Value $NodePath -Name "Node runtime"
$bun = Resolve-ExactDFile -Value $BunPath -Name "Bun build tool"
$helperSource = Resolve-ExactDFile -Value (Join-Path $source $helperRelative) -Name "Playwright helper source"
Assert-ContainedFile -Root $source -File $helperSource -Name "Playwright helper source"

$stage = Join-Path $browser (".opencode-playwright-stage-" + [Guid]::NewGuid().ToString("N"))
[IO.Directory]::CreateDirectory($stage) | Out-Null
try {
  $saved = [ordered]@{}
  foreach ($name in @("TEMP", "TMP", "TMPDIR", "BUN_INSTALL_CACHE_DIR", "PLAYWRIGHT_BROWSERS_PATH")) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  try {
    [Environment]::SetEnvironmentVariable("TEMP", $stage, "Process")
    [Environment]::SetEnvironmentVariable("TMP", $stage, "Process")
    [Environment]::SetEnvironmentVariable("TMPDIR", $stage, "Process")
    [Environment]::SetEnvironmentVariable("BUN_INSTALL_CACHE_DIR", (Join-Path $stage "bun-cache"), "Process")
    [Environment]::SetEnvironmentVariable("PLAYWRIGHT_BROWSERS_PATH", $browser, "Process")
    $bundleRoot = Join-Path $stage "bundle"
    & $bun build $helperSource --target=node "--outdir=$bundleRoot"
    if ($LASTEXITCODE -ne 0) { throw "Playwright helper bundle failed" }
  } finally {
    foreach ($entry in $saved.GetEnumerator()) {
      [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Process")
    }
  }
  $bundle = Resolve-ExactDFile -Value (Join-Path $stage "bundle\playwright-node-helper.js") -Name "Bundled Playwright helper"
  $nodeHash = (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant()
  $helperHash = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash.ToLowerInvariant()
  $sourceHash = (Get-FileHash -LiteralPath $helperSource -Algorithm SHA256).Hash.ToLowerInvariant()
  $nodeFile = "opencode-node-$nodeHash.exe"
  $helperFile = "opencode-playwright-helper-$helperHash.mjs"
  $nodeDestination = Join-Path $browser $nodeFile
  $helperDestination = Join-Path $browser $helperFile
  Install-ContentAddressedFile -Source $node -Destination $nodeDestination
  Install-ContentAddressedFile -Source $bundle -Destination $helperDestination

  $manifest = [ordered]@{
    schemaVersion = 1
    protocolVersion = 1
    nodeFile = $nodeFile
    nodeSha256 = $nodeHash
    helperFile = $helperFile
    helperSha256 = $helperHash
    sourceSha256 = $sourceHash
  }
  $manifestText = ($manifest | ConvertTo-Json -Compress) + "`n"
  $manifestPath = Join-Path $browser $manifestName
  $manifestStage = Join-Path $browser (".$manifestName.new-" + [Guid]::NewGuid().ToString("N"))
  [IO.File]::WriteAllText($manifestStage, $manifestText, [Text.UTF8Encoding]::new($false))
  try {
    $null = Resolve-ExactDFile -Value $manifestStage -Name "Staged Playwright manifest"
    [IO.File]::Move($manifestStage, $manifestPath, $true)
  } finally {
    if (Test-Path -LiteralPath $manifestStage -PathType Leaf) { [IO.File]::Delete($manifestStage) }
  }
  if ((Get-FileHash -LiteralPath $nodeDestination -Algorithm SHA256).Hash.ToLowerInvariant() -cne $nodeHash) {
    throw "Installed Node runtime hash changed"
  }
  if ((Get-FileHash -LiteralPath $helperDestination -Algorithm SHA256).Hash.ToLowerInvariant() -cne $helperHash) {
    throw "Installed Playwright helper hash changed"
  }
  Remove-ObsoleteContentAddressedFiles -Root $browser -KeepNode $nodeFile -KeepHelper $helperFile
  Write-Output "Installed authenticated Playwright helper runtime in $browser"
  Write-Output "Node SHA256: $nodeHash"
  Write-Output "Helper SHA256: $helperHash"
} finally {
  if (Test-Path -LiteralPath $stage -PathType Container) {
    Get-ChildItem -LiteralPath $stage -Force -Recurse | Sort-Object { $_.FullName.Split([IO.Path]::DirectorySeparatorChar).Count } -Descending | ForEach-Object {
      if ($_.PSIsContainer) { [IO.Directory]::Delete($_.FullName, $false) } else { [IO.File]::Delete($_.FullName) }
    }
    [IO.Directory]::Delete($stage, $false)
  }
}
