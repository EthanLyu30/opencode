[CmdletBinding()]
param(
  [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$buildScript = Join-Path $PSScriptRoot "build-workflow-sandbox.ps1"
$dockerEngine = "D:\Applications\Docker\resources\bin\docker.exe"
$dockerInstall = "D:\Applications\Docker"
$bunRuntime = "D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe"
$environmentNames = @(
  "DOCKER_CONFIG", "TEMP", "TMP",
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
  "BUILDX_BUILDER", "BUILDKIT_HOST", "BUILDX_CONFIG", "BUN_INSTALL_CACHE_DIR", "PATH"
)
$managedLeaves = [ordered]@{
  Data = "data\workflow-host"
  BrowserRuntime = "runtime\playwright"
  BrowserCache = "cache\playwright"
  PreviewCapability = "tmp\workflow-host"
  DockerConfig = "config\docker"
  DockerTemp = "tmp\workflow-sandbox"
  SandboxRelease = "runtime\sandbox"
}

function Set-ExactTestAcl {
  param([Parameter(Mandatory = $true)][string]$Path)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $currentSid) { throw "Test identity has no SID" }
  $security = New-Object Security.AccessControl.DirectorySecurity
  $security.SetOwner($currentSid)
  $security.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sidValue in @($currentSid.Value, "S-1-5-18", "S-1-5-32-544")) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      (New-Object Security.Principal.SecurityIdentifier($sidValue)),
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $security
}

function Set-DegradedTestAcl {
  param([Parameter(Mandatory = $true)][string]$Path)
  $security = Get-Acl -LiteralPath $Path
  $security.SetAccessRuleProtection($false, $true)
  Set-Acl -LiteralPath $Path -AclObject $security
  if ((Get-Acl -LiteralPath $Path).AreAccessRulesProtected) {
    throw "Test setup did not degrade ACL inheritance: $Path"
  }
}

function Add-UntrustedTestAcl {
  param([Parameter(Mandatory = $true)][string]$Path)
  $security = Get-Acl -LiteralPath $Path
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rule = New-Object Security.AccessControl.FileSystemAccessRule(
    (New-Object Security.Principal.SecurityIdentifier("S-1-1-0")),
    [Security.AccessControl.FileSystemRights]::ReadAndExecute,
    $inheritance,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Allow
  )
  [void]$security.AddAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $security
}

function Set-WrongTrustedRightsTestAcl {
  param([Parameter(Mandatory = $true)][string]$Path)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $currentSid) { throw "Test identity has no SID" }
  $security = New-Object Security.AccessControl.DirectorySecurity
  $security.SetOwner($currentSid)
  $security.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sidValue in @($currentSid.Value, "S-1-5-18", "S-1-5-32-544")) {
    $rights = if ($sidValue -ceq $currentSid.Value) {
      [Security.AccessControl.FileSystemRights]::Modify
    } else {
      [Security.AccessControl.FileSystemRights]::FullControl
    }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      (New-Object Security.Principal.SecurityIdentifier($sidValue)),
      $rights,
      $inheritance,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$security.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $security
}

function Get-EnvironmentSnapshot {
  $snapshot = [ordered]@{}
  foreach ($name in $environmentNames) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    $snapshot[$name] = if ($null -eq $value) { "<null>" } else { $value }
  }
  return ($snapshot | ConvertTo-Json -Compress)
}

function Get-TreeSnapshot {
  param([Parameter(Mandatory = $true)][string]$Root)
  $items = @((Get-Item -LiteralPath $Root -Force)) + @(Get-ChildItem -LiteralPath $Root -Force -Recurse)
  $snapshot = foreach ($item in ($items | Sort-Object FullName)) {
    $relative = [IO.Path]::GetRelativePath($Root, $item.FullName)
    $hash = if ($item.PSIsContainer) { $null } else { (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash }
    [ordered]@{
      path = $relative
      directory = [bool]$item.PSIsContainer
      length = if ($item.PSIsContainer) { 0 } else { [long]$item.Length }
      hash = $hash
      acl = (Get-Acl -LiteralPath $item.FullName).Sddl
    }
  }
  return ($snapshot | ConvertTo-Json -Compress -Depth 4)
}

function Remove-TestTree {
  param([Parameter(Mandatory = $true)][string]$Root)
  if (-not (Test-Path -LiteralPath $Root)) { return }
  $full = [IO.Path]::GetFullPath($Root).TrimEnd("\")
  if ($full -notmatch '^D:\\\.opencode-sandbox-acl-test-[a-f0-9]{32}$') {
    throw "Refusing to clean an unexpected test root: $full"
  }
  $items = @(Get-ChildItem -LiteralPath $full -Force -Recurse)
  foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to clean a redirected test item: $($item.FullName)"
    }
  }
  foreach ($file in @($items | Where-Object { -not $_.PSIsContainer })) {
    [IO.File]::Delete($file.FullName)
  }
  foreach ($directory in @($items | Where-Object { $_.PSIsContainer } | Sort-Object { $_.FullName.Length } -Descending)) {
    [IO.Directory]::Delete($directory.FullName, $false)
  }
  [IO.Directory]::Delete($full, $false)
}

function Test-FailClosedCase {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][ValidateSet("Acl", "ExtraAuthority", "WrongTrustedRights", "AlternateDockerConfig", "AlternateDockerTemp")][string]$Kind,
    [string]$AclRoot
  )
  $testRoot = "D:\.opencode-sandbox-acl-test-$([Guid]::NewGuid().ToString('N'))"
  try {
    $deployment = Join-Path $testRoot "deployment"
    $dockerData = Join-Path $testRoot "docker-data"
    [IO.Directory]::CreateDirectory($deployment) | Out-Null
    [IO.Directory]::CreateDirectory($dockerData) | Out-Null
    $roots = [ordered]@{ Deployment = $deployment }
    foreach ($entry in $managedLeaves.GetEnumerator()) {
      $roots[$entry.Key] = [IO.Directory]::CreateDirectory((Join-Path $deployment $entry.Value)).FullName
    }
    $dataVhd = Join-Path $dockerData "docker_data.vhdx"
    $mainVhd = Join-Path $dockerData "ext4.vhdx"
    $settings = Join-Path $testRoot "settings-store.json"
    [IO.File]::WriteAllText($dataVhd, "test")
    [IO.File]::WriteAllText($mainVhd, "test")
    [IO.File]::WriteAllText($settings, '{"CustomWslDistroDir":"D:\\\\unused-by-test"}')
    foreach ($root in $roots.Values) { Set-ExactTestAcl -Path $root }
    $dockerConfiguration = $roots.DockerConfig
    $dockerTemporary = $roots.DockerTemp
    $expectedFailure = "protected ACL"
    if ($Kind -eq "Acl") {
      Set-DegradedTestAcl -Path $roots[$AclRoot]
    }
    if ($Kind -eq "ExtraAuthority") {
      Add-UntrustedTestAcl -Path $roots[$AclRoot]
    }
    if ($Kind -eq "WrongTrustedRights") {
      Set-WrongTrustedRightsTestAcl -Path $roots[$AclRoot]
    }
    if ($Kind -eq "AlternateDockerConfig") {
      $dockerConfiguration = [IO.Directory]::CreateDirectory((Join-Path $deployment "config\alternate-docker")).FullName
      Set-ExactTestAcl -Path $dockerConfiguration
      $expectedFailure = "frozen deployment leaf"
    }
    if ($Kind -eq "AlternateDockerTemp") {
      $dockerTemporary = [IO.Directory]::CreateDirectory((Join-Path $deployment "tmp\alternate-sandbox")).FullName
      Set-ExactTestAcl -Path $dockerTemporary
      $expectedFailure = "frozen deployment leaf"
    }

    $treeBefore = Get-TreeSnapshot -Root $testRoot
    $environmentBefore = Get-EnvironmentSnapshot
    $script:DockerInvocationCount = 0

    . $buildScript `
      -RepositoryRoot $RepositoryRoot `
      -DeploymentRoot $deployment `
      -DockerEngine $dockerEngine `
      -DockerConfig $dockerConfiguration `
      -DockerTemp $dockerTemporary `
      -DockerSettings $settings `
      -DockerDataVhd $dataVhd `
      -DockerMainVhd $mainVhd `
      -ApprovedDockerRoot $dockerInstall `
      -ApprovedDockerDataRoot $dockerData `
      -BunRuntime $bunRuntime

    Set-Item -LiteralPath Function:\Assert-DockerStorage -Value { }
    Set-Item -LiteralPath Function:\Invoke-Docker -Value {
      param([string]$Engine, [string[]]$Arguments, [switch]$AllowFailure)
      $script:DockerInvocationCount += 1
      throw "Docker boundary reached by ACL regression test"
    }

    $failure = try {
      Invoke-Release
      $null
    } catch {
      $_
    }
    if ($null -eq $failure) { throw "$Name did not fail closed" }
    if ($failure.Exception.ToString() -notmatch $expectedFailure) {
      throw "$Name failed for the wrong reason: $($failure.Exception.Message)"
    }
    if ($script:DockerInvocationCount -ne 0) {
      throw "$Name invoked Docker $($script:DockerInvocationCount) time(s)"
    }
    if ((Get-TreeSnapshot -Root $testRoot) -cne $treeBefore) {
      throw "$Name mutated the filesystem"
    }
    if ((Get-EnvironmentSnapshot) -cne $environmentBefore) {
      throw "$Name mutated the process environment"
    }
  } finally {
    Remove-TestTree -Root $testRoot
  }
}

if (-not (Test-Path -LiteralPath $buildScript -PathType Leaf)) { throw "Build script is unavailable" }
if (-not (Test-Path -LiteralPath $dockerEngine -PathType Leaf)) { throw "Pinned Docker engine is unavailable" }
if (-not (Test-Path -LiteralPath $bunRuntime -PathType Leaf)) { throw "Pinned Bun runtime is unavailable" }

foreach ($root in @("Deployment") + @($managedLeaves.Keys)) {
  Test-FailClosedCase -Name "$root ACL degradation" -Kind Acl -AclRoot $root
}
Test-FailClosedCase -Name "Unexpected ACL authority" -Kind ExtraAuthority -AclRoot DockerConfig
Test-FailClosedCase -Name "Non-FullControl trusted grant" -Kind WrongTrustedRights -AclRoot BrowserRuntime
Test-FailClosedCase -Name "Alternate Docker config" -Kind AlternateDockerConfig
Test-FailClosedCase -Name "Alternate Docker temp" -Kind AlternateDockerTemp

Write-Output "PASS: protected build roots and frozen Docker leaves fail closed before mutation or Docker"
