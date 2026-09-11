[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$deployScript = Join-Path $PSScriptRoot "deploy-local.ps1"
$systemTar = "C:\Windows\System32\tar.exe"
$testParent = "D:\OpenCode-Local\tmp\deploy-tests"
$caseRoot = Join-Path $testParent ("case-" + [Guid]::NewGuid().ToString("N"))

function Assert-True {
  param(
    [Parameter(Mandatory = $true)][bool]$Condition,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if (-not $Condition) { throw $Message }
}

function Assert-Equal {
  param(
    [AllowNull()]$Actual,
    [AllowNull()]$Expected,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if ($Actual -cne $Expected) {
    throw "$Message`nExpected: $Expected`nActual:   $Actual"
  }
}

function Set-ProcessEnvironmentValue {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [AllowNull()]$Value
  )
  if ($null -eq $Value) {
    Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
    return
  }
  [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
}

function Get-BytesSha256 {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Remove-VerifiedTestTree {
  param([Parameter(Mandatory = $true)][string]$Root)
  $directories = New-Object Collections.Generic.List[string]
  $pending = New-Object Collections.Generic.Stack[string]
  $pending.Push($Root)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    $directories.Add($directory)
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
      $attributes = [IO.File]::GetAttributes($entry)
      $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
      $isReparse = ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
      if ($isDirectory -and -not $isReparse) {
        $pending.Push($entry)
        continue
      }
      [IO.File]::SetAttributes($entry, [IO.FileAttributes]::Normal)
      if ($isDirectory) {
        [IO.Directory]::Delete($entry, $false)
      } else {
        [IO.File]::Delete($entry)
      }
    }
  }
  for ($index = $directories.Count - 1; $index -ge 0; $index--) {
    [IO.File]::SetAttributes($directories[$index], [IO.FileAttributes]::Directory)
    [IO.Directory]::Delete($directories[$index], $false)
  }
}

function Invoke-Deploy {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$DeploymentRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [switch]$Rollback,
    [switch]$PrepareHostOnly,
    [string]$CrashAfter
  )
  $arguments = @(
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    $deployScript,
    "-SourceRoot",
    $SourceRoot,
    "-DeploymentRoot",
    $DeploymentRoot,
    "-Version",
    $Version
  )
  if ($Rollback) { $arguments += "-Rollback" }
  if ($PrepareHostOnly) { $arguments += "-PrepareHostOnly" }
  $previousPreference = $ErrorActionPreference
  $previousCrashPoint = [Environment]::GetEnvironmentVariable("OPENCODE_DEPLOY_TEST_CRASH_AFTER", "Process")
  try {
    $ErrorActionPreference = "Continue"
    Set-ProcessEnvironmentValue -Name "OPENCODE_DEPLOY_TEST_CRASH_AFTER" -Value $CrashAfter
    $output = & "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" @arguments 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    Set-ProcessEnvironmentValue -Name "OPENCODE_DEPLOY_TEST_CRASH_AFTER" -Value $previousCrashPoint
    $ErrorActionPreference = $previousPreference
  }
  return [PSCustomObject]@{ ExitCode = $exitCode; Output = @($output) -join "`n" }
}

function Get-ExecutableVersion {
  param([Parameter(Mandatory = $true)][string]$Path)
  $output = & $Path --version 2>&1
  Assert-Equal $LASTEXITCODE 0 "Fixture executable did not return a version"
  $first = @($output | Select-Object -First 1)
  Assert-Equal $first.Count 1 "Fixture executable returned no version line"
  return ([string]$first[0]).Trim()
}

function Write-FixtureSandboxSources {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [string]$Marker = "reviewed"
  )
  $sandboxSource = Join-Path $SourceRoot "packages\server\sandbox"
  New-Item -ItemType Directory -Path $sandboxSource -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $sandboxSource "Dockerfile"), "FROM scratch`n# $Marker`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $sandboxSource "opencode-preview-supervisor.ts"), "export const marker = `"$Marker`"`n", [Text.UTF8Encoding]::new($false))
}

function Write-SandboxManifest {
  param(
    [Parameter(Mandatory = $true)][string]$DeploymentRoot,
    [Parameter(Mandatory = $true)][string]$EnginePath,
    [Parameter(Mandatory = $true)][string]$SourceRoot
  )
  $directory = Join-Path $DeploymentRoot "runtime\sandbox"
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $layoutRoot = Join-Path $directory (".layout-" + [Guid]::NewGuid().ToString("N"))
  $stagedArchive = Join-Path $directory (".archive-" + [Guid]::NewGuid().ToString("N") + ".tar")
  New-Item -ItemType Directory -Path (Join-Path $layoutRoot "blobs\sha256") -Force | Out-Null
  try {
    $configBytes = [Text.UTF8Encoding]::new($false).GetBytes('{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]},"config":{}}')
    $configSha256 = Get-BytesSha256 -Bytes $configBytes
    [IO.File]::WriteAllBytes((Join-Path $layoutRoot "blobs\sha256\$configSha256"), $configBytes)
    $imageManifestBytes = [Text.UTF8Encoding]::new($false).GetBytes(([ordered]@{
          schemaVersion = 2
          mediaType = "application/vnd.oci.image.manifest.v1+json"
          config = [ordered]@{
            mediaType = "application/vnd.oci.image.config.v1+json"
            digest = "sha256:$configSha256"
            size = $configBytes.Length
          }
          layers = @()
        } | ConvertTo-Json -Depth 6 -Compress))
    $imageSha256 = Get-BytesSha256 -Bytes $imageManifestBytes
    [IO.File]::WriteAllBytes((Join-Path $layoutRoot "blobs\sha256\$imageSha256"), $imageManifestBytes)
    $indexBytes = [Text.UTF8Encoding]::new($false).GetBytes(([ordered]@{
          schemaVersion = 2
          manifests = @([ordered]@{
              mediaType = "application/vnd.oci.image.manifest.v1+json"
              digest = "sha256:$imageSha256"
              size = $imageManifestBytes.Length
              platform = [ordered]@{ architecture = "amd64"; os = "linux" }
            })
        } | ConvertTo-Json -Depth 6 -Compress))
    [IO.File]::WriteAllBytes((Join-Path $layoutRoot "index.json"), $indexBytes)
    [IO.File]::WriteAllText((Join-Path $layoutRoot "oci-layout"), '{"imageLayoutVersion":"1.0.0"}', [Text.UTF8Encoding]::new($false))
    $tarOutput = & $systemTar -cf $stagedArchive -C $layoutRoot oci-layout index.json blobs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Could not create fixture OCI archive: $(@($tarOutput) -join ' ')" }
    $archiveSha256 = (Get-FileHash -LiteralPath $stagedArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    $archiveName = "workflow-sandbox.$archiveSha256.oci.tar"
    $archive = Join-Path $directory $archiveName
    [IO.File]::Move($stagedArchive, $archive)
    $script:FixtureSandboxImage = "127.0.0.1:5000/opencode/workflow-sandbox@sha256:$imageSha256"
  } finally {
    if (Test-Path -LiteralPath $stagedArchive) { [IO.File]::Delete($stagedArchive) }
    if (Test-Path -LiteralPath $layoutRoot) { [IO.Directory]::Delete($layoutRoot, $true) }
  }
  $manifest = [ordered]@{
    schema = 1
    image = $script:FixtureSandboxImage
    base = "oven/bun@sha256:621f249399228db47cf34611ee662585e77e015250ed29d5d0932b2d3282f0b0"
    registry = "registry@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278"
    platform = "linux/amd64"
    archive = $archiveName
    archiveSha256 = $archiveSha256
    dockerfileSha256 = (Get-FileHash -LiteralPath (Join-Path $SourceRoot "packages\server\sandbox\Dockerfile") -Algorithm SHA256).Hash.ToLowerInvariant()
    supervisorSha256 = (Get-FileHash -LiteralPath (Join-Path $SourceRoot "packages\server\sandbox\opencode-preview-supervisor.ts") -Algorithm SHA256).Hash.ToLowerInvariant()
    engine = $EnginePath
    engineSha256 = (Get-FileHash -LiteralPath $EnginePath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $manifest | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $directory "workflow-sandbox.manifest.json") -NoNewline -Encoding UTF8
}

function Read-EnvironmentDump {
  param([Parameter(Mandatory = $true)][string]$Path)
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -notmatch '^(?:OPENCODE_WORKFLOW_[A-Z_]+|PLAYWRIGHT_BROWSERS_PATH)=') { continue }
    $parts = $line.Split(@("="), 2, [StringSplitOptions]::None)
    if ($parts.Length -ne 2 -or $values.ContainsKey($parts[0])) { throw "Malformed environment dump" }
    $values[$parts[0]] = $parts[1]
  }
  return $values
}

function Assert-ProtectedAcl {
  param([Parameter(Mandatory = $true)][string]$Path)
  $acl = Get-Acl -LiteralPath $Path
  Assert-True $acl.AreAccessRulesProtected "ACL inheritance is not protected: $Path"
  $ownerSid = (New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  Assert-Equal $ownerSid ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) "ACL owner is not the current deployment identity: $Path"
  $trusted = @(
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
    "S-1-5-18",
    "S-1-5-32-544"
  )
  Assert-Equal @($acl.Access).Count 3 "ACL contains authority outside the three frozen host principals: $Path"
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sid in $trusted) {
    $matched = @($acl.Access | Where-Object {
        $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid -and
        $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        [int]$_.FileSystemRights -eq [int][Security.AccessControl.FileSystemRights]::FullControl -and
        $_.InheritanceFlags -eq $inheritance -and
        $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None -and
        -not $_.IsInherited
      })
    Assert-Equal $matched.Count 1 "Trusted SID lacks one exact FullControl grant on $Path`: $sid"
  }
}

function Get-TreeAndAclSnapshot {
  param([Parameter(Mandatory = $true)][string]$Root)
  if (-not (Test-Path -LiteralPath $Root)) { return "<absent>" }
  $canonicalRoot = (Resolve-Path -LiteralPath $Root).Path
  $entries = @(
    Get-Item -LiteralPath $canonicalRoot -Force
    Get-ChildItem -LiteralPath $canonicalRoot -Force -Recurse
  ) | Sort-Object FullName
  return (@($entries | ForEach-Object {
        $relative = if ($_.FullName -ceq $canonicalRoot) { "." } else { $_.FullName.Substring($canonicalRoot.Length + 1) }
        $descriptor = [Convert]::ToBase64String((Get-Acl -LiteralPath $_.FullName).GetSecurityDescriptorBinaryForm())
        $content = if ($_.PSIsContainer) { "directory" } else { "file:$($_.Length):$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }
        "$relative|$([int]$_.Attributes)|$content|$descriptor"
      }) -join "`n")
}

function New-FixtureSource {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Executable,
    [string]$SandboxMarker = "reviewed"
  )
  $binary = Join-Path $Root "packages\opencode\dist\opencode-windows-x64\bin\opencode.exe"
  New-Item -ItemType Directory -Path (Split-Path -Parent $binary) -Force | Out-Null
  Copy-Item -LiteralPath $Executable -Destination $binary
  Write-FixtureSandboxSources -SourceRoot $Root -Marker $SandboxMarker
  & git -C $Root init --quiet
  Assert-Equal $LASTEXITCODE 0 "Could not initialize fixture source repository"
  & git -C $Root config user.name "OpenCode deploy test"
  & git -C $Root config user.email "opencode-deploy-test@example.invalid"
  & git -C $Root config core.autocrlf false
  "fixture" | Set-Content -LiteralPath (Join-Path $Root "fixture.txt") -NoNewline -Encoding ASCII
  & git -C $Root add fixture.txt packages/server/sandbox/Dockerfile packages/server/sandbox/opencode-preview-supervisor.ts
  & git -C $Root commit --quiet -m "fixture source"
  Assert-Equal $LASTEXITCODE 0 "Could not commit fixture source"
  return [PSCustomObject]@{
    Root = $Root
    Binary = $binary
    Version = Get-ExecutableVersion $binary
    Hash = (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash
  }
}

function Set-FixtureProtectedAcl {
  param([Parameter(Mandatory = $true)][string]$Path)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $currentSid) { throw "Current test identity has no SID" }
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

function Initialize-FixtureHostLayout {
  param([Parameter(Mandatory = $true)][string]$Root)
  foreach ($relative in @(
      "bin",
      "data\workflow-host",
      "runtime\playwright",
      "cache\playwright",
      "tmp\workflow-host",
      "config\docker",
      "tmp\workflow-sandbox",
      "data",
      "config",
      "cache",
      "state",
      "tmp\process",
      "cache\bun",
      "cache\npm",
      "cache\pnpm",
      "cache\yarn",
      "runtime\sandbox"
    )) {
    New-Item -ItemType Directory -Path (Join-Path $Root $relative) -Force | Out-Null
  }
  foreach ($relative in @(
      ".",
      "data\workflow-host",
      "runtime\playwright",
      "cache\playwright",
      "tmp\workflow-host",
      "config\docker",
      "tmp\workflow-sandbox",
      "runtime\sandbox"
    )) {
    Set-FixtureProtectedAcl -Path $(if ($relative -ceq ".") { $Root } else { Join-Path $Root $relative })
  }
}

function New-LegacyDeployment {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$EnginePath,
    [Parameter(Mandatory = $true)][string]$SourceRoot
  )
  Initialize-FixtureHostLayout -Root $Root
  $target = Join-Path $Root "bin\opencode-local.exe"
  Copy-Item -LiteralPath $Executable -Destination $target
  Write-SandboxManifest -DeploymentRoot $Root -EnginePath $EnginePath -SourceRoot $SourceRoot
  $version = Get-ExecutableVersion $target
  $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
  @(
    "Source commit: 0000000000000000000000000000000000000000",
    "Source branch: dev",
    "Remote: fixture",
    "Build target: opencode-windows-x64",
    "Build version: $version",
    "Binary SHA256: $hash"
  ) -join "`r`n" | Set-Content -LiteralPath (Join-Path $Root "BUILD-INFO.txt") -NoNewline -Encoding UTF8
  "@echo off`r`n`"%~dp0opencode-local.exe`" %*`r`n" | Set-Content -LiteralPath (Join-Path $Root "bin\opencode.cmd") -NoNewline -Encoding ASCII
  return [PSCustomObject]@{ Root = $Root; Target = $target; Version = $version; Hash = $hash }
}

try {
  $ownedProcesses = New-Object Collections.Generic.List[Diagnostics.Process]
  New-Item -ItemType Directory -Path $caseRoot -Force | Out-Null
  $caseRoot = (Resolve-Path -LiteralPath $caseRoot).Path
  Assert-True ($caseRoot.StartsWith("$testParent\", [StringComparison]::OrdinalIgnoreCase)) "Unsafe deploy-test root"
  $compilerTemp = Join-Path $caseRoot "compiler-temp"
  New-Item -ItemType Directory -Path $compilerTemp -Force | Out-Null
  $env:TEMP = $compilerTemp
  $env:TMP = $compilerTemp

  Assert-True (Test-Path -LiteralPath $repositoryRoot -PathType Container) "Repository root is unavailable"
  Assert-True (Test-Path -LiteralPath $deployScript -PathType Leaf) "Expected deployment script is absent: $deployScript"

  $sourceRoot = Join-Path $caseRoot "source"
  $sourceBinary = Join-Path $sourceRoot "packages\opencode\dist\opencode-windows-x64\bin\opencode.exe"
  $deploymentRoot = Join-Path $caseRoot "deployment"
  $targetBinary = Join-Path $deploymentRoot "bin\opencode-local.exe"
  $backupBinary = Join-Path $deploymentRoot "bin\opencode-local.bak.exe"
  $enginePath = "D:\Applications\Docker\resources\bin\docker.exe"
  foreach ($fixture in @($enginePath)) {
    Assert-True (Test-Path -LiteralPath $fixture -PathType Leaf) "Trusted fixture executable is unavailable: $fixture"
  }
  $fixtureRoot = Join-Path $caseRoot "executables"
  New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
  $newFixture = Join-Path $fixtureRoot "new.exe"
  $oldFixture = Join-Path $fixtureRoot "old.exe"
  $upgradeFixture = Join-Path $fixtureRoot "upgrade.exe"
  Copy-Item -LiteralPath "D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe" -Destination $newFixture
  Copy-Item -LiteralPath $enginePath -Destination $oldFixture
  Copy-Item -LiteralPath $systemTar -Destination $upgradeFixture
  foreach ($signedFixture in @($newFixture, $oldFixture, $upgradeFixture)) {
    Assert-Equal (Get-AuthenticodeSignature -LiteralPath $signedFixture).Status ([Management.Automation.SignatureStatus]::Valid) "Fixture executable is not accepted by Windows Application Control: $signedFixture"
  }
  New-Item -ItemType Directory -Path (Split-Path -Parent $sourceBinary) -Force | Out-Null
  Initialize-FixtureHostLayout -Root $deploymentRoot
  Copy-Item -LiteralPath $newFixture -Destination $sourceBinary
  Copy-Item -LiteralPath $oldFixture -Destination $targetBinary
  Write-FixtureSandboxSources -SourceRoot $sourceRoot
  $newVersion = Get-ExecutableVersion $sourceBinary
  $oldVersion = Get-ExecutableVersion $targetBinary
  $oldHash = (Get-FileHash -LiteralPath $targetBinary -Algorithm SHA256).Hash
  $newHash = (Get-FileHash -LiteralPath $sourceBinary -Algorithm SHA256).Hash
  Assert-True ($oldHash -cne $newHash) "Fixture binaries must have distinct hashes"
  Write-SandboxManifest -DeploymentRoot $deploymentRoot -EnginePath $enginePath -SourceRoot $sourceRoot
  $unknownDeploymentMarker = Join-Path $deploymentRoot "bin\preserve-unknown.txt"
  "preserve unknown deployment data" | Set-Content -LiteralPath $unknownDeploymentMarker -NoNewline -Encoding ASCII
  @(
    "Source commit: 0000000000000000000000000000000000000000",
    "Source branch: dev",
    "Remote: fixture",
    "Build target: opencode-windows-x64",
    "Build version: $oldVersion",
    "Binary SHA256: $oldHash"
  ) -join "`r`n" | Set-Content -LiteralPath (Join-Path $deploymentRoot "BUILD-INFO.txt") -NoNewline -Encoding UTF8

  & git -C $sourceRoot init --quiet
  Assert-Equal $LASTEXITCODE 0 "Could not initialize fixture source repository"
  & git -C $sourceRoot config user.name "OpenCode deploy test"
  & git -C $sourceRoot config user.email "opencode-deploy-test@example.invalid"
  & git -C $sourceRoot config core.autocrlf false
  "fixture" | Set-Content -LiteralPath (Join-Path $sourceRoot "fixture.txt") -NoNewline -Encoding ASCII
  & git -C $sourceRoot add fixture.txt packages/server/sandbox/Dockerfile packages/server/sandbox/opencode-preview-supervisor.ts
  & git -C $sourceRoot commit --quiet -m "fixture source"
  Assert-Equal $LASTEXITCODE 0 "Could not commit fixture source"
  $fixtureCommit = ((& git -C $sourceRoot rev-parse HEAD) | Select-Object -First 1).Trim()
  Assert-True ($fixtureCommit -match '^(?:[a-f0-9]{40}|[a-f0-9]{64})$') "Fixture source commit is malformed: $fixtureCommit"

  $overlapSource = New-FixtureSource -Root (Join-Path $caseRoot "overlap-source") -Executable $newFixture
  $overlapAclBefore = (Get-Acl -LiteralPath $overlapSource.Root).Sddl
  $overlapEntriesBefore = @((Get-ChildItem -LiteralPath $overlapSource.Root -Force | Sort-Object Name | ForEach-Object { "$($_.Name)|$([int]$_.Attributes)" })) -join "`n"
  $overlapResult = Invoke-Deploy -SourceRoot $overlapSource.Root -DeploymentRoot $overlapSource.Root -Version $overlapSource.Version
  Assert-True ($overlapResult.ExitCode -ne 0) "Deployment accepted an overlapping source and deployment root"
  Assert-Equal (Get-Acl -LiteralPath $overlapSource.Root).Sddl $overlapAclBefore "Overlap rejection changed the source-root ACL"
  $overlapEntriesAfter = @((Get-ChildItem -LiteralPath $overlapSource.Root -Force | Sort-Object Name | ForEach-Object { "$($_.Name)|$([int]$_.Attributes)" })) -join "`n"
  Assert-Equal $overlapEntriesAfter $overlapEntriesBefore "Overlap rejection changed source-root contents"

  $invalidVersionRoot = Join-Path $caseRoot "invalid-version-deployment"
  $invalidVersionResult = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $invalidVersionRoot -Version "?invalid"
  Assert-True ($invalidVersionResult.ExitCode -ne 0) "Deployment accepted an invalid version"
  Assert-True (-not (Test-Path -LiteralPath $invalidVersionRoot)) "Invalid-version rejection created the deployment root"

  $missingDeploymentRoot = Join-Path $caseRoot "missing-normal-deployment"
  $missingDeploymentResult = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $missingDeploymentRoot -Version $newVersion
  Assert-True ($missingDeploymentResult.ExitCode -ne 0) "Normal deployment accepted a missing deployment root"
  Assert-Equal (Get-TreeAndAclSnapshot -Root $missingDeploymentRoot) "<absent>" "Normal deployment created state before rejecting a missing deployment root"

  $conflictingFlagsRoot = Join-Path $caseRoot "conflicting-flags-deployment"
  $conflictingFlagsResult = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $conflictingFlagsRoot -Version $newVersion -PrepareHostOnly -Rollback
  Assert-True ($conflictingFlagsResult.ExitCode -ne 0) "Deployment accepted PrepareHostOnly with Rollback"
  Assert-True (-not (Test-Path -LiteralPath $conflictingFlagsRoot)) "Conflicting-flag rejection created the deployment root"

  $unboundOciDeployment = New-LegacyDeployment -Root (Join-Path $caseRoot "unbound-oci-deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $sourceRoot
  $unboundManifestPath = Join-Path $unboundOciDeployment.Root "runtime\sandbox\workflow-sandbox.manifest.json"
  $unboundManifest = Get-Content -LiteralPath $unboundManifestPath -Raw | ConvertFrom-Json
  $unboundDigest = if ([string]$unboundManifest.image -match ('f{64}$')) { 'e' * 64 } else { 'f' * 64 }
  $unboundManifest.image = "127.0.0.1:5000/opencode/workflow-sandbox@sha256:$unboundDigest"
  [IO.File]::WriteAllText($unboundManifestPath, ($unboundManifest | ConvertTo-Json -Depth 6 -Compress), [Text.UTF8Encoding]::new($false))
  $unboundResult = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $unboundOciDeployment.Root -Version $newVersion
  Assert-True ($unboundResult.ExitCode -ne 0) "Deployment accepted an image digest that is not described by its OCI archive"
  Assert-Equal (Get-FileHash -LiteralPath $unboundOciDeployment.Target -Algorithm SHA256).Hash $unboundOciDeployment.Hash "Rejected unbound OCI release changed the deployed binary"

  $fixedArchiveDeployment = New-LegacyDeployment -Root (Join-Path $caseRoot "fixed-archive-deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $sourceRoot
  $fixedArchiveManifestPath = Join-Path $fixedArchiveDeployment.Root "runtime\sandbox\workflow-sandbox.manifest.json"
  $fixedArchiveManifest = Get-Content -LiteralPath $fixedArchiveManifestPath -Raw | ConvertFrom-Json
  $contentAddressedArchive = Join-Path (Split-Path -Parent $fixedArchiveManifestPath) ([string]$fixedArchiveManifest.archive)
  $fixedArchive = Join-Path (Split-Path -Parent $fixedArchiveManifestPath) "workflow-sandbox.oci.tar"
  [IO.File]::Move($contentAddressedArchive, $fixedArchive)
  $fixedArchiveManifest.archive = "workflow-sandbox.oci.tar"
  [IO.File]::WriteAllText($fixedArchiveManifestPath, ($fixedArchiveManifest | ConvertTo-Json -Depth 6 -Compress), [Text.UTF8Encoding]::new($false))
  $fixedArchiveResult = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $fixedArchiveDeployment.Root -Version $newVersion
  Assert-True ($fixedArchiveResult.ExitCode -ne 0) "Deployment accepted an overwriteable fixed-name OCI archive"
  Assert-Equal (Get-FileHash -LiteralPath $fixedArchiveDeployment.Target -Algorithm SHA256).Hash $fixedArchiveDeployment.Hash "Rejected fixed-name OCI release changed the deployed binary"

  $hardlinkArchiveDeployment = New-LegacyDeployment -Root (Join-Path $caseRoot "hardlink-archive-deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $sourceRoot
  $hardlinkArchiveManifestPath = Join-Path $hardlinkArchiveDeployment.Root "runtime\sandbox\workflow-sandbox.manifest.json"
  $hardlinkArchiveManifest = Get-Content -LiteralPath $hardlinkArchiveManifestPath -Raw | ConvertFrom-Json
  $hardlinkArchive = Join-Path (Split-Path -Parent $hardlinkArchiveManifestPath) ([string]$hardlinkArchiveManifest.archive)
  $outsideArchive = Join-Path $caseRoot "outside-hardlinked-oci.tar"
  [IO.File]::Move($hardlinkArchive, $outsideArchive)
  New-Item -ItemType HardLink -Path $hardlinkArchive -Target $outsideArchive | Out-Null
  $outsideArchiveHash = (Get-FileHash -LiteralPath $outsideArchive -Algorithm SHA256).Hash
  $hardlinkArchiveResult = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $hardlinkArchiveDeployment.Root -Version $newVersion
  Assert-True ($hardlinkArchiveResult.ExitCode -ne 0) "Deployment accepted a hard-linked OCI archive"
  Assert-Equal (Get-FileHash -LiteralPath $outsideArchive -Algorithm SHA256).Hash $outsideArchiveHash "Rejected OCI hard link changed its outside peer"
  Assert-Equal (Get-FileHash -LiteralPath $hardlinkArchiveDeployment.Target -Algorithm SHA256).Hash $hardlinkArchiveDeployment.Hash "Rejected hard-linked OCI release changed the deployed binary"

  $wrongEngineDeployment = New-LegacyDeployment -Root (Join-Path $caseRoot "wrong-engine-deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $sourceRoot
  $wrongEngineManifestPath = Join-Path $wrongEngineDeployment.Root "runtime\sandbox\workflow-sandbox.manifest.json"
  $wrongEngineManifest = Get-Content -LiteralPath $wrongEngineManifestPath -Raw | ConvertFrom-Json
  $wrongEngineManifest.engine = $newFixture
  $wrongEngineManifest.engineSha256 = (Get-FileHash -LiteralPath $newFixture -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText($wrongEngineManifestPath, ($wrongEngineManifest | ConvertTo-Json -Depth 6 -Compress), [Text.UTF8Encoding]::new($false))
  $wrongEngineResult = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $wrongEngineDeployment.Root -Version $newVersion
  Assert-True ($wrongEngineResult.ExitCode -ne 0) "Deployment accepted a sandbox engine outside the fixed D-drive path"
  Assert-Equal (Get-FileHash -LiteralPath $wrongEngineDeployment.Target -Algorithm SHA256).Hash $wrongEngineDeployment.Hash "Rejected sandbox engine changed the deployed binary"

  $wrongBaseDeployment = New-LegacyDeployment -Root (Join-Path $caseRoot "wrong-base-deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $sourceRoot
  $wrongBaseManifestPath = Join-Path $wrongBaseDeployment.Root "runtime\sandbox\workflow-sandbox.manifest.json"
  $wrongBaseManifest = Get-Content -LiteralPath $wrongBaseManifestPath -Raw | ConvertFrom-Json
  $wrongBaseManifest.base = "oven/bun@sha256:$('f' * 64)"
  [IO.File]::WriteAllText($wrongBaseManifestPath, ($wrongBaseManifest | ConvertTo-Json -Depth 6 -Compress), [Text.UTF8Encoding]::new($false))
  $wrongBaseBefore = Get-TreeAndAclSnapshot -Root $wrongBaseDeployment.Root
  $wrongBaseResult = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $wrongBaseDeployment.Root -Version $newVersion
  Assert-True ($wrongBaseResult.ExitCode -ne 0) "Deployment accepted a sandbox built from an unreviewed base digest"
  Assert-Equal (Get-FileHash -LiteralPath $wrongBaseDeployment.Target -Algorithm SHA256).Hash $wrongBaseDeployment.Hash "Rejected sandbox base changed the deployed binary"
  Assert-Equal (Get-TreeAndAclSnapshot -Root $wrongBaseDeployment.Root) $wrongBaseBefore "Rejected sandbox base changed the deployment tree or ACL bytes"

  $alternateSource = New-FixtureSource -Root (Join-Path $caseRoot "alternate-sandbox-source") -Executable $newFixture -SandboxMarker "different-reviewed-source"
  $staleSourceDeployment = New-LegacyDeployment -Root (Join-Path $caseRoot "stale-source-deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $sourceRoot
  $staleSourceBefore = Get-TreeAndAclSnapshot -Root $staleSourceDeployment.Root
  $staleSourceResult = Invoke-Deploy -SourceRoot $alternateSource.Root -DeploymentRoot $staleSourceDeployment.Root -Version $alternateSource.Version
  Assert-True ($staleSourceResult.ExitCode -ne 0) "Deployment accepted sandbox hashes from a different clean SourceRoot"
  Assert-Equal (Get-FileHash -LiteralPath $staleSourceDeployment.Target -Algorithm SHA256).Hash $staleSourceDeployment.Hash "Rejected stale-source sandbox changed the deployed binary"
  Assert-Equal (Get-TreeAndAclSnapshot -Root $staleSourceDeployment.Root) $staleSourceBefore "Rejected stale-source sandbox changed the deployment tree or ACL bytes"

  $dirtySource = New-FixtureSource -Root (Join-Path $caseRoot "dirty-source") -Executable $newFixture
  $dirtySourceDeployment = New-LegacyDeployment -Root (Join-Path $caseRoot "dirty-source-deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $dirtySource.Root
  "dirty" | Set-Content -LiteralPath (Join-Path $dirtySource.Root "fixture.txt") -NoNewline -Encoding ASCII
  $dirtySourceBefore = Get-TreeAndAclSnapshot -Root $dirtySourceDeployment.Root
  $dirtySourceResult = Invoke-Deploy -SourceRoot $dirtySource.Root -DeploymentRoot $dirtySourceDeployment.Root -Version $dirtySource.Version
  Assert-True ($dirtySourceResult.ExitCode -ne 0) "Deployment accepted a dirty SourceRoot"
  Assert-Equal (Get-TreeAndAclSnapshot -Root $dirtySourceDeployment.Root) $dirtySourceBefore "Rejected dirty SourceRoot changed the deployment tree or ACL bytes"

  $degradedAclDeployment = New-LegacyDeployment -Root (Join-Path $caseRoot "degraded-acl-deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $sourceRoot
  $degradedAclRoot = Join-Path $degradedAclDeployment.Root "cache\playwright"
  $degradedAcl = Get-Acl -LiteralPath $degradedAclRoot
  $degradedAcl.SetAccessRuleProtection($false, $true)
  Set-Acl -LiteralPath $degradedAclRoot -AclObject $degradedAcl
  $degradedAclBefore = Get-TreeAndAclSnapshot -Root $degradedAclDeployment.Root
  $degradedAclResult = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $degradedAclDeployment.Root -Version $newVersion
  Assert-True ($degradedAclResult.ExitCode -ne 0) "Normal deployment repaired a downgraded production ACL without explicit PrepareHostOnly authority"
  Assert-True ($degradedAclResult.Output -match "Protected ACL") "Downgraded ACL rejection did not come from the read-only production ACL gate: $($degradedAclResult.Output)"
  Assert-Equal (Get-TreeAndAclSnapshot -Root $degradedAclDeployment.Root) $degradedAclBefore "Rejected downgraded ACL changed the deployment tree or ACL bytes"

  $poisonedEnvironmentDeployment = New-LegacyDeployment -Root (Join-Path $caseRoot "poisoned-environment-deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $sourceRoot
  $forbiddenChildRoot = "C:\opencode-child-environment-$([Guid]::NewGuid().ToString('N'))"
  $childEnvironmentNames = @(
    "PATH", "TEMP", "TMP", "TMPDIR", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR", "npm_config_cache", "PNPM_HOME", "YARN_CACHE_FOLDER",
    "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
    "DOCKER_CONFIG", "PLAYWRIGHT_BROWSERS_PATH",
    "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT",
    "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR"
  )
  $savedChildEnvironment = @{}
  try {
    foreach ($name in $childEnvironmentNames) {
      $savedChildEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
      $value = if ($name -ceq "PATH") {
        "C:\Windows\System32"
      } elseif (@("TEMP", "TMP", "TMPDIR") -ccontains $name) {
        "C:\Windows\Temp"
      } else {
        Join-Path $forbiddenChildRoot $name
      }
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
    $poisonedEnvironmentResult = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $poisonedEnvironmentDeployment.Root -Version $newVersion
  } finally {
    foreach ($entry in $savedChildEnvironment.GetEnumerator()) {
      Set-ProcessEnvironmentValue -Name $entry.Key -Value $entry.Value
    }
  }
  Assert-Equal $poisonedEnvironmentResult.ExitCode 0 "Deployment inherited poisoned ambient child-process paths: $($poisonedEnvironmentResult.Output)"
  Assert-True (-not (Test-Path -LiteralPath $forbiddenChildRoot)) "Deployment created child-process state on C drive"

  $mismatch = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $deploymentRoot -Version "wrong-version"
  Assert-True ($mismatch.ExitCode -ne 0) "Deployment accepted a mismatched binary version"
  Assert-Equal (Get-ExecutableVersion $targetBinary) $oldVersion "Version mismatch changed the deployed binary"
  Assert-Equal (Get-FileHash -LiteralPath $targetBinary -Algorithm SHA256).Hash $oldHash "Version mismatch changed target bytes"
  Assert-True (-not (Test-Path -LiteralPath $backupBinary)) "Version mismatch created a rollback binary"

  $deployed = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $deploymentRoot -Version $newVersion
  Assert-Equal $deployed.ExitCode 0 "Valid deployment failed: $($deployed.Output)"
  Assert-Equal (Get-ExecutableVersion $targetBinary) $newVersion "New executable was not deployed"
  Assert-Equal (Get-FileHash -LiteralPath $targetBinary -Algorithm SHA256).Hash $newHash "Deployed SHA is wrong"
  Assert-Equal (Get-ExecutableVersion $backupBinary) $oldVersion "Original executable was not retained"
  Assert-Equal (Get-FileHash -LiteralPath $backupBinary -Algorithm SHA256).Hash $oldHash "Rollback SHA is wrong"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $deploymentRoot "bin\opencode-local.new.exe"))) "Same-volume executable staging was not retired"

  $buildInfo = Get-Content -LiteralPath (Join-Path $deploymentRoot "BUILD-INFO.txt") -Raw
  Assert-True $buildInfo.Contains("Build version: $newVersion") "BUILD-INFO lacks the deployed version"
  Assert-True $buildInfo.Contains("Binary SHA256: $newHash") "BUILD-INFO lacks the deployed SHA"
  Assert-True $buildInfo.Contains("Rollback version: $oldVersion") "BUILD-INFO lacks the rollback version"
  Assert-True $buildInfo.Contains("Rollback SHA256: $oldHash") "BUILD-INFO lacks the rollback SHA"

  $idempotent = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $deploymentRoot -Version $newVersion
  Assert-Equal $idempotent.ExitCode 0 "Idempotent redeployment failed: $($idempotent.Output)"
  Assert-Equal (Get-FileHash -LiteralPath $targetBinary -Algorithm SHA256).Hash $newHash "Idempotent redeployment changed target bytes"
  Assert-Equal (Get-FileHash -LiteralPath $backupBinary -Algorithm SHA256).Hash $oldHash "Idempotent redeployment destroyed the original rollback point"

  $launcher = Join-Path $deploymentRoot "bin\opencode.cmd"
  $environmentDump = Join-Path $caseRoot "launcher-environment.txt"
  $environmentProbe = Join-Path $caseRoot "dump-workflow-environment.js"
  $environmentProbeText = @'
const names = Object.keys(process.env)
  .filter((name) => name === "PLAYWRIGHT_BROWSERS_PATH" || name.startsWith("OPENCODE_WORKFLOW_"))
  .sort()
const lines = names.map((name) => `${name}=${process.env[name]}`).join("\n")
await Bun.write(Bun.argv.at(-1), lines.length === 0 ? "" : `${lines}\n`)
'@
  [IO.File]::WriteAllText($environmentProbe, $environmentProbeText, [Text.UTF8Encoding]::new($false))
  & $launcher $environmentProbe $environmentDump
  Assert-Equal $LASTEXITCODE 0 "Generated launcher failed"
  $actualEnvironment = Read-EnvironmentDump $environmentDump
  $expectedEnvironment = [ordered]@{
    OPENCODE_WORKFLOW_HOST_ROOT = $deploymentRoot
    OPENCODE_WORKFLOW_HOST_DATA = Join-Path $deploymentRoot "data\workflow-host"
    OPENCODE_WORKFLOW_HOST_RUNTIME = Join-Path $deploymentRoot "runtime\playwright"
    OPENCODE_WORKFLOW_HOST_CACHE = Join-Path $deploymentRoot "cache\playwright"
    OPENCODE_WORKFLOW_HOST_TEMP = Join-Path $deploymentRoot "tmp\workflow-host"
    OPENCODE_WORKFLOW_EVIDENCE_ROOT = Join-Path $deploymentRoot "data\workflow-host"
    PLAYWRIGHT_BROWSERS_PATH = Join-Path $deploymentRoot "runtime\playwright"
    OPENCODE_WORKFLOW_SANDBOX_ENGINE = $enginePath
    OPENCODE_WORKFLOW_SANDBOX_IMAGE = $script:FixtureSandboxImage
    OPENCODE_WORKFLOW_SANDBOX_CONFIG = Join-Path $deploymentRoot "config\docker"
    OPENCODE_WORKFLOW_SANDBOX_TEMP = Join-Path $deploymentRoot "tmp\workflow-sandbox"
  }
  Assert-Equal $actualEnvironment.Count 11 "Launcher did not export exactly eleven workflow-host variables"
  foreach ($entry in $expectedEnvironment.GetEnumerator()) {
    Assert-Equal $actualEnvironment[$entry.Key] $entry.Value "Launcher exported the wrong $($entry.Key)"
  }
  $directDump = Join-Path $caseRoot "direct-binary-environment.txt"
  $savedWorkflowEnvironment = @{}
  try {
    foreach ($name in $expectedEnvironment.Keys) {
      $savedWorkflowEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
      Set-ProcessEnvironmentValue -Name $name -Value $null
    }
    & $targetBinary $environmentProbe $directDump
    Assert-Equal $LASTEXITCODE 0 "Direct fixture probe failed"
  } finally {
    foreach ($entry in $savedWorkflowEnvironment.GetEnumerator()) {
      Set-ProcessEnvironmentValue -Name $entry.Key -Value $entry.Value
    }
  }
  Assert-Equal (Read-EnvironmentDump $directDump).Count 0 "Direct binary invocation was incorrectly accepted as a production launcher smoke"

  $protectedRoots = @(
    $deploymentRoot,
    $expectedEnvironment.OPENCODE_WORKFLOW_HOST_DATA,
    $expectedEnvironment.OPENCODE_WORKFLOW_HOST_RUNTIME,
    $expectedEnvironment.OPENCODE_WORKFLOW_HOST_CACHE,
    $expectedEnvironment.OPENCODE_WORKFLOW_HOST_TEMP,
    $expectedEnvironment.OPENCODE_WORKFLOW_SANDBOX_CONFIG,
    $expectedEnvironment.OPENCODE_WORKFLOW_SANDBOX_TEMP
  )
  foreach ($root in $protectedRoots) { Assert-ProtectedAcl $root }

  $rolledBack = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $deploymentRoot -Version $oldVersion -Rollback
  Assert-Equal $rolledBack.ExitCode 0 "Rollback failed: $($rolledBack.Output)"
  Assert-Equal (Get-ExecutableVersion $targetBinary) $oldVersion "Rollback did not restore the prior executable"
  Assert-Equal (Get-FileHash -LiteralPath $targetBinary -Algorithm SHA256).Hash $oldHash "Rollback restored wrong bytes"
  Assert-Equal (Get-ExecutableVersion $backupBinary) $newVersion "Rollback did not preserve the replaced executable"
  Assert-Equal (Get-FileHash -LiteralPath $backupBinary -Algorithm SHA256).Hash $newHash "Rollback replacement SHA is wrong"

  $redeployed = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $deploymentRoot -Version $newVersion
  Assert-Equal $redeployed.ExitCode 0 "Redeploy with an existing rollback point failed: $($redeployed.Output)"
  Assert-Equal (Get-ExecutableVersion $targetBinary) $newVersion "Redeploy did not restore the candidate"
  Assert-Equal (Get-FileHash -LiteralPath $targetBinary -Algorithm SHA256).Hash $newHash "Redeploy target SHA is wrong"
  Assert-Equal (Get-ExecutableVersion $backupBinary) $oldVersion "Redeploy did not rotate the immediate prior executable"
  Assert-Equal (Get-FileHash -LiteralPath $backupBinary -Algorithm SHA256).Hash $oldHash "Redeploy rollback SHA is wrong"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $deploymentRoot "bin\opencode-local.rollback-swap.exe"))) "Redeploy left a rollback swap"
  Assert-Equal (Get-Content -LiteralPath $unknownDeploymentMarker -Raw) "preserve unknown deployment data" "Deployment changed an unknown sibling file"

  Copy-Item -LiteralPath $sourceBinary -Destination $backupBinary -Force
  $unknownBackupHash = (Get-FileHash -LiteralPath $backupBinary -Algorithm SHA256).Hash
  $unknownBackup = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $deploymentRoot -Version $newVersion
  Assert-True ($unknownBackup.ExitCode -ne 0) "Deployment deleted an unauthenticated rollback file"
  Assert-Equal (Get-FileHash -LiteralPath $backupBinary -Algorithm SHA256).Hash $unknownBackupHash "Rejected deployment changed an unauthenticated rollback file"
  Assert-Equal (Get-FileHash -LiteralPath $targetBinary -Algorithm SHA256).Hash $newHash "Rejected deployment changed the current executable"

  $forbiddenRoot = "C:\opencode-forbidden-$([Guid]::NewGuid().ToString('N'))"
  $forbidden = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $forbiddenRoot -Version $newVersion
  Assert-True ($forbidden.ExitCode -ne 0) "Deployment accepted a C-drive root"
  Assert-True (-not (Test-Path -LiteralPath $forbiddenRoot)) "C-drive refusal created a directory"

  $redirectedDeployment = Join-Path $caseRoot "redirected-deployment"
  $outsideBin = Join-Path $caseRoot "outside-bin"
  New-Item -ItemType Directory -Path $redirectedDeployment,$outsideBin -Force | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $redirectedDeployment "bin") -Target $outsideBin | Out-Null
  Write-SandboxManifest -DeploymentRoot $redirectedDeployment -EnginePath $enginePath -SourceRoot $sourceRoot
  $outsideMarker = Join-Path $outsideBin "preserve.txt"
  "preserve" | Set-Content -LiteralPath $outsideMarker -NoNewline -Encoding ASCII
  $redirected = Invoke-Deploy -SourceRoot $sourceRoot -DeploymentRoot $redirectedDeployment -Version $newVersion
  Assert-True ($redirected.ExitCode -ne 0) "Deployment followed a target junction outside its root"
  Assert-Equal (Get-Content -LiteralPath $outsideMarker -Raw) "preserve" "Rejected deployment changed the junction target"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $outsideBin "opencode-local.exe"))) "Rejected deployment wrote outside its root"

  $firstRootSource = New-FixtureSource -Root (Join-Path $caseRoot "first-root-source") -Executable $newFixture
  $firstRoot = Join-Path $caseRoot "first-created-deployment"
  Assert-True (-not (Test-Path -LiteralPath $firstRoot)) "First-root fixture unexpectedly exists"
  $firstRootResult = Invoke-Deploy -SourceRoot $firstRootSource.Root -DeploymentRoot $firstRoot -Version $firstRootSource.Version -PrepareHostOnly
  Assert-Equal $firstRootResult.ExitCode 0 "PrepareHostOnly could not initialize a fresh deployment root: $($firstRootResult.Output)"
  foreach ($expectedRoot in @(
      $firstRoot,
      (Join-Path $firstRoot "data\workflow-host"),
      (Join-Path $firstRoot "runtime\playwright"),
      (Join-Path $firstRoot "cache\playwright"),
      (Join-Path $firstRoot "tmp\workflow-host"),
      (Join-Path $firstRoot "config\docker"),
      (Join-Path $firstRoot "tmp\workflow-sandbox"),
      (Join-Path $firstRoot "runtime\sandbox")
    )) {
    Assert-True (Test-Path -LiteralPath $expectedRoot -PathType Container) "Deployment preflight did not create $expectedRoot"
    Assert-ProtectedAcl $expectedRoot
  }
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $firstRoot "bin\opencode-local.exe"))) "PrepareHostOnly touched the deployed executable"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $firstRoot "BUILD-INFO.txt"))) "PrepareHostOnly wrote BUILD-INFO"

  $actualSourceParent = Join-Path $caseRoot "source-ancestor-real"
  $aliasSourceParent = Join-Path $caseRoot "source-ancestor-alias"
  New-Item -ItemType Directory -Path $actualSourceParent | Out-Null
  $ancestorSource = New-FixtureSource -Root (Join-Path $actualSourceParent "source") -Executable $newFixture
  New-Item -ItemType Junction -Path $aliasSourceParent -Target $actualSourceParent | Out-Null
  $ancestorDeployment = New-LegacyDeployment -Root (Join-Path $caseRoot "source-ancestor-deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $ancestorSource.Root
  $ancestorResult = Invoke-Deploy -SourceRoot (Join-Path $aliasSourceParent "source") -DeploymentRoot $ancestorDeployment.Root -Version $ancestorSource.Version
  Assert-True ($ancestorResult.ExitCode -ne 0) "Deployment accepted a SourceRoot reached through a junction ancestor"
  Assert-True ($ancestorResult.Output -match 'reparse') "SourceRoot junction ancestor was not rejected by the reparse policy: $($ancestorResult.Output)"
  Assert-Equal (Get-FileHash -LiteralPath $ancestorDeployment.Target -Algorithm SHA256).Hash $ancestorDeployment.Hash "Rejected source-ancestor deployment changed target bytes"

  $hardlinkSource = New-FixtureSource -Root (Join-Path $caseRoot "hardlink-source") -Executable $newFixture
  $hardlinkOutside = Join-Path $caseRoot "hardlink-source-outside.exe"
  Move-Item -LiteralPath $hardlinkSource.Binary -Destination $hardlinkOutside
  New-Item -ItemType HardLink -Path $hardlinkSource.Binary -Target $hardlinkOutside | Out-Null
  $hardlinkDeployment = New-LegacyDeployment -Root (Join-Path $caseRoot "hardlink-deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $hardlinkSource.Root
  $hardlinkResult = Invoke-Deploy -SourceRoot $hardlinkSource.Root -DeploymentRoot $hardlinkDeployment.Root -Version $hardlinkSource.Version
  Assert-True ($hardlinkResult.ExitCode -ne 0) "Deployment accepted a hard-linked source executable"
  Assert-True ($hardlinkResult.Output -match 'hard.?link') "Hard-linked source was not rejected by the file-identity policy: $($hardlinkResult.Output)"
  Assert-Equal (Get-FileHash -LiteralPath $hardlinkDeployment.Target -Algorithm SHA256).Hash $hardlinkDeployment.Hash "Rejected hard-linked source changed target bytes"

  $hardlinkTargetSource = New-FixtureSource -Root (Join-Path $caseRoot "hardlink-target-source") -Executable $newFixture
  $hardlinkTargetDeployment = New-LegacyDeployment -Root (Join-Path $caseRoot "hardlink-target-deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $hardlinkTargetSource.Root
  $hardlinkTargetOutside = Join-Path $caseRoot "hardlink-target-outside.exe"
  New-Item -ItemType HardLink -Path $hardlinkTargetOutside -Target $hardlinkTargetDeployment.Target | Out-Null
  $hardlinkTargetResult = Invoke-Deploy -SourceRoot $hardlinkTargetSource.Root -DeploymentRoot $hardlinkTargetDeployment.Root -Version $hardlinkTargetSource.Version
  Assert-True ($hardlinkTargetResult.ExitCode -ne 0) "Deployment accepted a hard-linked current executable"
  Assert-True ($hardlinkTargetResult.Output -match 'hard.?link') "Hard-linked target was not rejected by the file-identity policy: $($hardlinkTargetResult.Output)"
  Assert-Equal (Get-FileHash -LiteralPath $hardlinkTargetOutside -Algorithm SHA256).Hash $hardlinkTargetDeployment.Hash "Rejected hard-linked target changed its outside peer"

  $processRoot = Join-Path $caseRoot "exact-process"
  $processSource = New-FixtureSource -Root (Join-Path $processRoot "source") -Executable $newFixture
  $processDeployment = New-LegacyDeployment -Root (Join-Path $processRoot "deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $processSource.Root
  $processInitial = Invoke-Deploy -SourceRoot $processSource.Root -DeploymentRoot $processDeployment.Root -Version $processSource.Version
  Assert-Equal $processInitial.ExitCode 0 "Exact-process fixture deployment failed: $($processInitial.Output)"
  Copy-Item -LiteralPath $upgradeFixture -Destination $processSource.Binary -Force
  $processUpgradeVersion = Get-ExecutableVersion $processSource.Binary
  $outsideProcessDirectory = Join-Path $processRoot "outside"
  New-Item -ItemType Directory -Path $outsideProcessDirectory | Out-Null
  $outsideProcessExecutable = Join-Path $outsideProcessDirectory "opencode-local.exe"
  Copy-Item -LiteralPath $processDeployment.Target -Destination $outsideProcessExecutable
  $targetProcess = Start-Process -FilePath $processDeployment.Target -ArgumentList '-e "await Bun.sleep(300000)"' -PassThru
  $outsideProcess = Start-Process -FilePath $outsideProcessExecutable -ArgumentList '-e "await Bun.sleep(300000)"' -PassThru
  $ownedProcesses.Add($targetProcess)
  $ownedProcesses.Add($outsideProcess)
  Start-Sleep -Milliseconds 300
  Assert-True (-not $targetProcess.HasExited -and -not $outsideProcess.HasExited) "Exact-process fixtures did not remain running"
  $processUpgrade = Invoke-Deploy -SourceRoot $processSource.Root -DeploymentRoot $processDeployment.Root -Version $processUpgradeVersion
  Assert-Equal $processUpgrade.ExitCode 0 "Deployment could not replace its exact running executable: $($processUpgrade.Output)"
  $targetProcess.Refresh()
  $outsideProcess.Refresh()
  Assert-True $targetProcess.HasExited "Deployment did not stop the exact deployed executable"
  Assert-True (-not $outsideProcess.HasExited) "Deployment stopped a same-named executable outside the deployment target"
  $outsideProcess.Kill()
  $outsideProcess.WaitForExit()

  $unknownTransactionRoot = Join-Path $caseRoot "unknown-transaction-artifact"
  $unknownTransactionSource = New-FixtureSource -Root (Join-Path $unknownTransactionRoot "source") -Executable $newFixture
  $unknownTransactionDeployment = New-LegacyDeployment -Root (Join-Path $unknownTransactionRoot "deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $unknownTransactionSource.Root
  $unknownTransactionCrash = Invoke-Deploy -SourceRoot $unknownTransactionSource.Root -DeploymentRoot $unknownTransactionDeployment.Root -Version $unknownTransactionSource.Version -CrashAfter "target-installed"
  Assert-True ($unknownTransactionCrash.ExitCode -ne 0) "Unknown-artifact fixture did not reach its crash point"
  $unknownBuildInfoPath = Join-Path $unknownTransactionDeployment.Root "BUILD-INFO.txt"
  $unknownBuildInfoBeforeRecovery = (Get-FileHash -LiteralPath $unknownBuildInfoPath -Algorithm SHA256).Hash
  $activeTransaction = Join-Path $unknownTransactionDeployment.Root ".opencode-deploy.transaction"
  $foreignTransactionFile = Join-Path $activeTransaction "foreign-user-file.txt"
  "preserve foreign transaction file" | Set-Content -LiteralPath $foreignTransactionFile -NoNewline -Encoding ASCII
  $unknownTransactionRecovery = Invoke-Deploy -SourceRoot $unknownTransactionSource.Root -DeploymentRoot $unknownTransactionDeployment.Root -Version $unknownTransactionSource.Version
  Assert-True ($unknownTransactionRecovery.ExitCode -ne 0) "Recovery committed a transaction containing an unknown file"
  Assert-True (Test-Path -LiteralPath $activeTransaction -PathType Container) "Recovery moved an active transaction containing an unknown file"
  Assert-Equal (Get-Content -LiteralPath $foreignTransactionFile -Raw) "preserve foreign transaction file" "Recovery deleted or changed an unknown transaction file"
  Assert-Equal (Get-FileHash -LiteralPath $unknownBuildInfoPath -Algorithm SHA256).Hash $unknownBuildInfoBeforeRecovery "Recovery mutated BUILD-INFO before rejecting an unknown transaction artifact"
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $guardOutput = & (Join-Path $unknownTransactionDeployment.Root "bin\opencode.cmd") --version 2>&1
    $guardExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  Assert-Equal $guardExitCode 74 "Launcher did not remain guarded after unknown transaction content blocked recovery: $(@($guardOutput) -join ' ')"

  foreach ($checkpoint in @(
      "transaction-staged",
      "transaction-published",
      "launcher-installed",
      "backup-installed",
      "target-installed",
      "build-info-installed",
      "transaction-committed"
    )) {
    $crashRoot = Join-Path $caseRoot "crash-$checkpoint"
    $crashSource = New-FixtureSource -Root (Join-Path $crashRoot "source") -Executable $newFixture
    $crashDeployment = New-LegacyDeployment -Root (Join-Path $crashRoot "deployment") -Executable $oldFixture -EnginePath $enginePath -SourceRoot $crashSource.Root
    $crashed = Invoke-Deploy -SourceRoot $crashSource.Root -DeploymentRoot $crashDeployment.Root -Version $crashSource.Version -CrashAfter $checkpoint
    Assert-True ($crashed.ExitCode -ne 0) "Crash checkpoint $checkpoint did not terminate the deployment child"
    $recovered = Invoke-Deploy -SourceRoot $crashSource.Root -DeploymentRoot $crashDeployment.Root -Version $crashSource.Version
    Assert-Equal $recovered.ExitCode 0 "Deployment did not recover checkpoint $checkpoint`: $($recovered.Output)"
    Assert-Equal (Get-FileHash -LiteralPath $crashDeployment.Target -Algorithm SHA256).Hash $crashSource.Hash "Recovered checkpoint $checkpoint installed wrong target bytes"
    $crashBackup = Join-Path $crashDeployment.Root "bin\opencode-local.bak.exe"
    Assert-Equal (Get-FileHash -LiteralPath $crashBackup -Algorithm SHA256).Hash $crashDeployment.Hash "Recovered checkpoint $checkpoint lost the legacy rollback point"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $crashDeployment.Root ".opencode-deploy.transaction"))) "Recovered checkpoint $checkpoint left an active transaction"
    Assert-True (@(Get-ChildItem -LiteralPath $crashDeployment.Root -Filter ".opencode-deploy.committed-*" -Force).Count -eq 0) "Recovered checkpoint $checkpoint left committed staging"
  }

  Write-Host "Task23.12 local deployment tests passed"
}
finally {
  if ($null -ne $ownedProcesses) {
    foreach ($process in $ownedProcesses) {
      try {
        $process.Refresh()
        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
      } catch {}
      $process.Dispose()
    }
  }
  if (Test-Path -LiteralPath $caseRoot) {
    $resolved = (Resolve-Path -LiteralPath $caseRoot).Path
    $leaf = Split-Path -Leaf $resolved
    if (
      -not $resolved.StartsWith("$testParent\", [StringComparison]::OrdinalIgnoreCase) -or
      $leaf -cnotmatch '^case-[a-f0-9]{32}$'
    ) {
      throw "Refusing unsafe deploy-test cleanup: $resolved"
    }
    Remove-VerifiedTestTree -Root $resolved
  }
}
