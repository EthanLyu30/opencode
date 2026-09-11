[CmdletBinding()]
param(
  [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$DeploymentRoot = "D:\OpenCode-Local",
  [string]$DockerEngine = "D:\Applications\Docker\resources\bin\docker.exe",
  [string]$DockerConfig = "D:\OpenCode-Local\config\docker",
  [string]$DockerTemp = "D:\OpenCode-Local\tmp\workflow-sandbox",
  [string]$DockerSettings = (Join-Path $env:APPDATA "Docker\settings-store.json"),
  [string]$DockerDataVhd = "D:\Applications\DockerWSL\disk\docker_data.vhdx",
  [string]$DockerMainVhd = "D:\Applications\DockerWSL\main\ext4.vhdx",
  [string]$DockerWslDistribution = "docker-desktop",
  [string]$ApprovedDockerRoot = "D:\Applications\Docker",
  [string]$ApprovedDockerDataRoot = "D:\Applications\DockerWSL",
  [string]$BunRuntime = "D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Release {
$bunBase = "oven/bun@sha256:621f249399228db47cf34611ee662585e77e015250ed29d5d0932b2d3282f0b0"
$registryImage = "registry@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278"
$pinnedBunRuntime = "D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe"
$runtimeRepository = "127.0.0.1:5000/opencode/workflow-sandbox"
$runtimeDigestPrefix = "127.0.0.1:5000/opencode/workflow-sandbox@sha256:"
$releaseID = [Guid]::NewGuid().ToString("N")
$repository = Resolve-VerifiedPath -Path $RepositoryRoot -Kind Directory
$deployment = Resolve-VerifiedPath -Path $DeploymentRoot -Kind Directory
$dataRoot = Resolve-VerifiedPath -Path (Join-Path $deployment "data\workflow-host") -Kind Directory
$browserRuntime = Resolve-VerifiedPath -Path (Join-Path $deployment "runtime\playwright") -Kind Directory
$browserCache = Resolve-VerifiedPath -Path (Join-Path $deployment "cache\playwright") -Kind Directory
$previewCapability = Resolve-VerifiedPath -Path (Join-Path $deployment "tmp\workflow-host") -Kind Directory
$expectedDockerConfiguration = Resolve-VerifiedPath -Path (Join-Path $deployment "config\docker") -Kind Directory
$expectedDockerTemporary = Resolve-VerifiedPath -Path (Join-Path $deployment "tmp\workflow-sandbox") -Kind Directory
$dockerConfiguration = Resolve-VerifiedPath -Path $DockerConfig -Kind Directory
$dockerTemporary = Resolve-VerifiedPath -Path $DockerTemp -Kind Directory
if (
  -not [string]::Equals($dockerConfiguration, $expectedDockerConfiguration, [StringComparison]::Ordinal) -or
  -not [string]::Equals($dockerTemporary, $expectedDockerTemporary, [StringComparison]::Ordinal)
) {
  throw "Each Docker release root must use its frozen deployment leaf"
}
$outputRoot = Resolve-VerifiedPath -Path (Join-Path $deployment "runtime\sandbox") -Kind Directory
$isolatedRoots = @($dataRoot, $browserRuntime, $browserCache, $previewCapability, $dockerConfiguration, $dockerTemporary)
foreach ($root in $isolatedRoots) { Assert-StrictDescendant -Parent $deployment -Child $root }
Assert-StrictDescendant -Parent $deployment -Child $outputRoot
for ($left = 0; $left -lt $isolatedRoots.Count; $left += 1) {
  for ($right = $left + 1; $right -lt $isolatedRoots.Count; $right += 1) {
    Assert-Separate -Left $isolatedRoots[$left] -Right $isolatedRoots[$right]
  }
  Assert-Separate -Left $isolatedRoots[$left] -Right $outputRoot
}
foreach ($root in @($deployment) + $isolatedRoots + @($outputRoot)) {
  Assert-ProtectedReleaseAcl -Path $root
}
$engine = Resolve-VerifiedPath -Path $DockerEngine -Kind File
$approvedDocker = Resolve-VerifiedPath -Path $ApprovedDockerRoot -Kind Directory
$approvedDockerData = Resolve-VerifiedPath -Path $ApprovedDockerDataRoot -Kind Directory
$bunRuntime = Resolve-VerifiedPath -Path $BunRuntime -Kind File
$dockerExecutableDirectory = Resolve-VerifiedPath -Path (Split-Path -Parent $engine) -Kind Directory
$dockerPluginDirectory = Resolve-VerifiedPath -Path (Join-Path $approvedDocker "cli-plugins") -Kind Directory
$bunDirectory = Resolve-VerifiedPath -Path (Split-Path -Parent $bunRuntime) -Kind Directory
$context = Resolve-VerifiedPath -Path (Join-Path $repository "packages\server\sandbox") -Kind Directory
$sourceDockerfile = Resolve-VerifiedPath -Path (Join-Path $context "Dockerfile") -Kind File
$sourceSupervisor = Resolve-VerifiedPath -Path (Join-Path $context "opencode-preview-supervisor.ts") -Kind File
$sourceDockerfileSha256 = (Get-FileHash -LiteralPath $sourceDockerfile -Algorithm SHA256).Hash.ToLowerInvariant()
$sourceSupervisorSha256 = (Get-FileHash -LiteralPath $sourceSupervisor -Algorithm SHA256).Hash.ToLowerInvariant()
$dataVhd = Resolve-VerifiedPath -Path $DockerDataVhd -Kind File
$mainVhd = Resolve-VerifiedPath -Path $DockerMainVhd -Kind File
if (-not [string]::Equals($bunRuntime, $pinnedBunRuntime, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Release identity checks require the pinned D-drive Bun runtime"
}
$script:ReleaseEnginePath = $engine
$script:ReleaseEngineSha256 = (Get-FileHash -LiteralPath $engine -Algorithm SHA256).Hash.ToLowerInvariant()

Assert-StrictDescendant -Parent $approvedDocker -Child $engine
if (-not [string]::Equals([IO.Path]::GetRelativePath($approvedDocker, $engine), "resources\bin\docker.exe", [StringComparison]::OrdinalIgnoreCase)) {
  throw "Docker engine is outside the approved installation location"
}
Assert-DockerStorage -SettingsPath $DockerSettings -DataVhd $dataVhd -MainVhd $mainVhd -Distribution $DockerWslDistribution -ApprovedRoot $approvedDockerData
Assert-NoUnknownReleaseState -TempRoot $dockerTemporary -OutputRoot $outputRoot

$stageRoot = Join-Path $dockerTemporary ".release-$releaseID"
$registryStorage = Join-Path $stageRoot "registry"
$stagedContext = Join-Path $stageRoot "context"
$stagedArchive = Join-Path $stageRoot "workflow-sandbox.oci.tar"
$stagedMetadata = Join-Path $stageRoot "build-metadata.json"
$stagedManifest = Join-Path $stageRoot "workflow-sandbox.manifest.json"
$registryContainer = "ocw-registry-$releaseID"
$registryNetwork = "ocw-registry-$releaseID"
$registryTag = "${runtimeRepository}:task23-$releaseID"
$bunCache = Join-Path $dockerTemporary "bun-cache"
$releasePath = "$dockerExecutableDirectory;$dockerPluginDirectory;$bunDirectory"
$stageIdentity = $null
$preserveStage = $false
$releasedReference = $null
$releaseFailure = $null
$cleanupFailures = [Collections.Generic.List[Exception]]::new()
$environmentBefore = Save-Environment -Names @(
  "DOCKER_CONFIG", "TEMP", "TMP",
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
  "BUILDX_BUILDER", "BUILDKIT_HOST", "BUILDX_CONFIG", "BUN_INSTALL_CACHE_DIR", "PATH"
)

try {
  $env:DOCKER_CONFIG = $dockerConfiguration
  $env:TEMP = $dockerTemporary
  $env:TMP = $dockerTemporary
  $env:PATH = $releasePath
  Clear-Environment -Names @(
    "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
    "BUILDX_BUILDER", "BUILDKIT_HOST", "BUILDX_CONFIG"
  )
  $env:DOCKER_CONTEXT = "default"

  [IO.Directory]::CreateDirectory($bunCache) | Out-Null
  $bunCache = Resolve-VerifiedPath -Path $bunCache -Kind Directory
  Assert-StrictDescendant -Parent $dockerTemporary -Child $bunCache
  $env:BUN_INSTALL_CACHE_DIR = $bunCache

  [IO.Directory]::CreateDirectory($stageRoot) | Out-Null
  $stageRoot = Resolve-VerifiedPath -Path $stageRoot -Kind Directory
  Assert-StrictDescendant -Parent $dockerTemporary -Child $stageRoot
  try {
    $stageIdentity = Get-PathIdentity -Path $stageRoot -Bun $bunRuntime
  } catch {
    $preserveStage = $true
    throw
  }

  [IO.Directory]::CreateDirectory($registryStorage) | Out-Null
  [IO.Directory]::CreateDirectory($stagedContext) | Out-Null
  $registryStorage = Resolve-VerifiedPath -Path $registryStorage -Kind Directory
  $stagedContext = Resolve-VerifiedPath -Path $stagedContext -Kind Directory
  Assert-StrictDescendant -Parent $stageRoot -Child $registryStorage
  Assert-StrictDescendant -Parent $stageRoot -Child $stagedContext
  [IO.File]::Copy($sourceDockerfile, (Join-Path $stagedContext "Dockerfile"), $false)
  [IO.File]::Copy($sourceSupervisor, (Join-Path $stagedContext "opencode-preview-supervisor.ts"), $false)
  Assert-ReleaseSource -SourceContext $context -StagedContext $stagedContext -DockerfileSha256 $sourceDockerfileSha256 -SupervisorSha256 $sourceSupervisorSha256

  Invoke-Docker -Engine $engine -Arguments @("version", "--format", "{{.Server.Version}}") | Out-Null
  Invoke-Docker -Engine $engine -Arguments @("pull", $bunBase) | Out-Null
  Invoke-Docker -Engine $engine -Arguments @("pull", $registryImage) | Out-Null
  Assert-ImageDigest -Engine $engine -Reference $bunBase
  Assert-ImageDigest -Engine $engine -Reference $registryImage

  # Docker Engine 29 omits published host ports for containers attached only to an
  # internal bridge. The registry remains loopback-only through the explicit
  # 127.0.0.1 publish binding; runtime preview containers are still network-none.
  Invoke-Docker -Engine $engine -Arguments @("network", "create", "--driver", "bridge", $registryNetwork) | Out-Null
  Invoke-Docker -Engine $engine -Arguments @(
    "container", "run", "--detach", "--rm",
    "--name", $registryContainer,
    "--network", $registryNetwork,
    "--publish", "127.0.0.1:5000:5000",
    "--pull=never",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges=true",
    "--pids-limit", "64",
    "--memory", "268435456",
    "--cpus", "0.5",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=16777216,mode=1777",
    "--mount", "type=bind,src=$registryStorage,dst=/var/lib/registry",
    $registryImage
  ) | Out-Null
  Wait-Registry -Engine $engine -Container $registryContainer

  Invoke-Docker -Engine $engine -Arguments @(
    "buildx", "build", "--builder", "default",
    "--pull=false",
    "--provenance=false",
    "--sbom=false",
    "--platform", "linux/amd64",
    "--metadata-file", $stagedMetadata,
    "--output", "type=image,name=$registryTag,push=true,oci-mediatypes=true",
    "--output", "type=oci,dest=$stagedArchive,oci-mediatypes=true",
    $stagedContext
  ) | Out-Null
  $metadata = Get-Content -LiteralPath $stagedMetadata -Raw | ConvertFrom-Json
  $imageDigest = [string]$metadata.'containerimage.digest'
  if ($imageDigest -notmatch '^sha256:[a-f0-9]{64}$') { throw "BuildKit did not return one exact image digest" }
  $exactReference = "$runtimeRepository@$imageDigest"
  if (-not $exactReference.StartsWith($runtimeDigestPrefix, [StringComparison]::Ordinal)) {
    throw "BuildKit returned an unexpected workflow sandbox repository"
  }
  Invoke-Docker -Engine $engine -Arguments @("pull", $exactReference) | Out-Null
  Assert-ImageDigest -Engine $engine -Reference $exactReference

  $archiveSha256 = (Get-FileHash -LiteralPath $stagedArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  $archiveName = "workflow-sandbox.$archiveSha256.oci.tar"
  Assert-OciDigest -Archive $stagedArchive -ExpectedDigest $imageDigest -VerificationRoot $stageRoot -Bun $bunRuntime

  $manifest = [ordered]@{
    schema = 1
    image = $exactReference
    engine = $engine
    engineSha256 = $script:ReleaseEngineSha256
    base = $bunBase
    registry = $registryImage
    platform = "linux/amd64"
    archive = $archiveName
    archiveSha256 = $archiveSha256
    dockerfileSha256 = $sourceDockerfileSha256
    supervisorSha256 = $sourceSupervisorSha256
  }
  [IO.File]::WriteAllText($stagedManifest, ($manifest | ConvertTo-Json -Depth 3) + "`n", [Text.UTF8Encoding]::new($false))

  Assert-ReleaseSource -SourceContext $context -StagedContext $stagedContext -DockerfileSha256 $sourceDockerfileSha256 -SupervisorSha256 $sourceSupervisorSha256
  Assert-StagedRelease -ManifestPath $stagedManifest -ArchivePath $stagedArchive -ExpectedImage $exactReference -ExpectedEngine $engine -ExpectedBase $bunBase -ExpectedRegistry $registryImage -Context $stagedContext -VerificationRoot $stageRoot -Bun $bunRuntime
  Publish-ImmutableFile -Source $stagedArchive -Destination (Join-Path $outputRoot $archiveName) -Sha256 $archiveSha256
  $manifestDestination = Join-Path $outputRoot "workflow-sandbox.manifest.json"
  $preserveStage = $true
  $manifestPublication = Publish-Manifest -Source $stagedManifest -Destination $manifestDestination -Backup (Join-Path $stageRoot "workflow-sandbox.previous.manifest.json")
  try {
    Assert-ReleaseSource -SourceContext $context -StagedContext $stagedContext -DockerfileSha256 $sourceDockerfileSha256 -SupervisorSha256 $sourceSupervisorSha256
    Assert-PublishedRelease -Root $outputRoot -ExpectedImage $exactReference -ExpectedEngine $engine -ExpectedBase $bunBase -ExpectedRegistry $registryImage -Context $stagedContext -VerificationRoot $stageRoot -Bun $bunRuntime
    $preserveStage = $false
  } catch {
    $validationFailure = $_
    try {
      Restore-ManifestPublication -Publication $manifestPublication
      $preserveStage = $false
    } catch {
      throw
    }
    throw $validationFailure
  }

  $releasedReference = $exactReference
} catch {
  $releaseFailure = $_
} finally {
  try {
    try {
      Invoke-Docker -Engine $engine -Arguments @("container", "rm", "--force", $registryContainer) -AllowFailure | Out-Null
      Assert-DockerResourceAbsent -Engine $engine -Kind Container -Name $registryContainer
    } catch {
      $cleanupFailures.Add($_.Exception)
    }
    try {
      Invoke-Docker -Engine $engine -Arguments @("network", "rm", $registryNetwork) -AllowFailure | Out-Null
      Assert-DockerResourceAbsent -Engine $engine -Kind Network -Name $registryNetwork
    } catch {
      $cleanupFailures.Add($_.Exception)
    }
    if ($cleanupFailures.Count -ne 0) {
      $preserveStage = $true
    }
    if (-not $preserveStage -and $null -ne $stageIdentity) {
      try {
        Remove-VerifiedStage -Stage $stageRoot -Parent $dockerTemporary -ExpectedIdentity $stageIdentity -Bun $bunRuntime
      } catch {
        $preserveStage = $true
        $cleanupFailures.Add($_.Exception)
      }
    }
  } finally {
    try {
      Restore-Environment -Values $environmentBefore
    } catch {
      $cleanupFailures.Add($_.Exception)
    }
  }
}

if ($null -ne $releaseFailure) {
  if ($cleanupFailures.Count -eq 0) { throw $releaseFailure }
  $failures = [Collections.Generic.List[Exception]]::new()
  $failures.Add($releaseFailure.Exception)
  foreach ($failure in $cleanupFailures) { $failures.Add($failure) }
  throw [AggregateException]::new("Workflow sandbox release and cleanup both failed", $failures.ToArray())
}
if ($cleanupFailures.Count -ne 0) {
  throw [AggregateException]::new("Workflow sandbox release cleanup could not prove resource absence", $cleanupFailures.ToArray())
}
if ([string]::IsNullOrWhiteSpace($releasedReference)) { throw "Workflow sandbox release returned no image reference" }
Write-Output $releasedReference
}

function Resolve-VerifiedPath {
  param([string]$Path, [ValidateSet("Directory", "File")][string]$Kind)
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '[,=\x00-\x1f\x7f]' -or -not [IO.Path]::IsPathFullyQualified($Path)) {
    throw "Release paths must be clean absolute paths"
  }
  $lexical = [IO.Path]::GetFullPath($Path)
  if (-not $lexical.StartsWith("D:\", [StringComparison]::OrdinalIgnoreCase)) { throw "Release paths must stay on D:" }
  $resolved = (Resolve-Path -LiteralPath $lexical -ErrorAction Stop).ProviderPath
  if (-not [string]::Equals($lexical.TrimEnd('\'), $resolved.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw "Release path changed spelling or identity"
  }
  Assert-NoReparsePath -Path $lexical
  $item = Get-Item -LiteralPath $lexical -Force
  if ($Kind -eq "Directory" -and -not $item.PSIsContainer) { throw "Expected release directory: $lexical" }
  if ($Kind -eq "File" -and $item.PSIsContainer) { throw "Expected release file: $lexical" }
  return $resolved.TrimEnd('\')
}

function Assert-NoReparsePath {
  param([string]$Path)
  $cursor = Get-Item -LiteralPath $Path -Force
  while ($null -ne $cursor) {
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Release path contains a reparse point" }
    $cursor = if ($cursor -is [IO.DirectoryInfo]) { $cursor.Parent } else { $cursor.Directory }
  }
}

function Assert-ProtectedReleaseAcl {
  param([string]$Path)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $currentSid) { throw "Current Windows identity has no SID" }
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) { throw "Workflow sandbox protected ACL inheritance is disabled: $Path" }
  $ownerSid = (New-Object Security.Principal.NTAccount($acl.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -cne $currentSid.Value) { throw "Workflow sandbox protected ACL owner is wrong: $Path" }
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rules = @($acl.Access)
  if ($rules.Count -ne 3) { throw "Workflow sandbox protected ACL contains unexpected authority: $Path" }
  foreach ($sidValue in @($currentSid.Value, "S-1-5-18", "S-1-5-32-544")) {
    $matches = @($rules | Where-Object {
        $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sidValue -and
        $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        [int]$_.FileSystemRights -eq [int][Security.AccessControl.FileSystemRights]::FullControl -and
        $_.InheritanceFlags -eq $inheritance -and
        $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None -and
        -not $_.IsInherited
      })
    if ($matches.Count -ne 1) { throw "Workflow sandbox protected ACL is missing one exact trusted grant: $Path" }
  }
}

function Assert-StrictDescendant {
  param([string]$Parent, [string]$Child)
  $relative = [IO.Path]::GetRelativePath($Parent, $Child)
  if ($relative -eq "." -or $relative -eq ".." -or $relative.StartsWith("..\") -or [IO.Path]::IsPathFullyQualified($relative)) {
    throw "Release leaf must be a strict deployment descendant"
  }
}

function Assert-Separate {
  param([string]$Left, [string]$Right)
  if ((Test-ContainsPath -Parent $Left -Child $Right) -or (Test-ContainsPath -Parent $Right -Child $Left)) {
    throw "Release roots must not overlap"
  }
}

function Test-ContainsPath {
  param([string]$Parent, [string]$Child)
  $relative = [IO.Path]::GetRelativePath($Parent, $Child)
  return (
    $relative -eq "." -or
    (-not [IO.Path]::IsPathFullyQualified($relative) -and $relative -ne ".." -and -not $relative.StartsWith("..\"))
  )
}

function Assert-DockerStorage {
  param([string]$SettingsPath, [string]$DataVhd, [string]$MainVhd, [string]$Distribution, [string]$ApprovedRoot)
  $settings = Get-Content -LiteralPath $SettingsPath -Raw | ConvertFrom-Json
  $customRoot = Resolve-VerifiedPath -Path ([string]$settings.CustomWslDistroDir) -Kind Directory
  if (-not [string]::Equals($customRoot, $ApprovedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Docker Desktop data is outside the approved D-drive root"
  }
  $expectedDataVhd = Join-Path $customRoot "disk\docker_data.vhdx"
  if (-not [string]::Equals($DataVhd, $expectedDataVhd, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Docker data VHD is not bound to the approved Docker Desktop data disk"
  }
  $lxss = Get-ChildItem -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss" | ForEach-Object {
    Get-ItemProperty -LiteralPath $_.PSPath
  }
  $selected = @($lxss | Where-Object { $_.DistributionName -eq $Distribution })
  if ($selected.Count -ne 1) { throw "Docker WSL distribution identity is ambiguous" }
  $basePath = ([string]$selected[0].BasePath) -replace '^\\\\\?\\', ''
  $resolvedBase = Resolve-VerifiedPath -Path $basePath -Kind Directory
  Assert-StrictDescendant -Parent $customRoot -Child $resolvedBase
  $expectedMainVhd = Join-Path $resolvedBase "ext4.vhdx"
  if (-not [string]::Equals($MainVhd, $expectedMainVhd, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Docker main VHD is not bound to the selected WSL distribution"
  }
}

function Get-PathIdentity {
  param([string]$Path, [string]$Bun)
  $identityScript = 'import fs from "node:fs"; import path from "node:path"; const target = process.argv[1]; const lexical = path.resolve(target); const canonical = fs.realpathSync.native(lexical); const stat = fs.lstatSync(lexical, { bigint: true }); if (canonical !== lexical || !stat.isDirectory() || stat.isSymbolicLink()) process.exit(64); console.log(JSON.stringify({ canonical, dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: String(stat.birthtimeMs) }))'
  $output = & $Bun "--no-env-file" "-e" $identityScript $Path 2>&1 | ForEach-Object { $_.ToString() }
  if ($LASTEXITCODE -ne 0) { throw "Release staging identity could not be authenticated" }
  $joined = ($output -join "`n").Trim()
  $parsed = $joined | ConvertFrom-Json
  if (
    [string]::IsNullOrWhiteSpace([string]$parsed.canonical) -or
    [string]::IsNullOrWhiteSpace([string]$parsed.dev) -or
    [string]::IsNullOrWhiteSpace([string]$parsed.ino) -or
    [string]::IsNullOrWhiteSpace([string]$parsed.birthtimeMs)
  ) {
    throw "Release staging identity is incomplete"
  }
  return $joined
}

function Assert-NoReparseTree {
  param([string]$Root)
  $rootItem = Get-Item -LiteralPath $Root -Force
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Release staging root became a reparse point"
  }
  foreach ($item in Get-ChildItem -LiteralPath $Root -Force -Recurse) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Release staging tree contains a reparse point"
    }
  }
}

function Assert-NoUnknownReleaseState {
  param([string]$TempRoot, [string]$OutputRoot)
  $abandoned = @(Get-ChildItem -LiteralPath $TempRoot -Force | Where-Object { $_.Name -like ".release-*" })
  $incoming = @(Get-ChildItem -LiteralPath $OutputRoot -Force | Where-Object { $_.Name -like "*.incoming" -or $_.Name -like "*.previous-*" })
  if ($abandoned.Count -ne 0 -or $incoming.Count -ne 0) {
    throw "Unknown workflow sandbox release state requires operator review"
  }
}

function Save-Environment {
  param([string[]]$Names)
  $saved = @{}
  foreach ($name in $Names) {
    $value = [Environment]::GetEnvironmentVariable($name, "Process")
    $saved[$name] = if ($null -eq $value) { [DBNull]::Value } else { $value }
  }
  return $saved
}

function Restore-Environment {
  param([hashtable]$Values)
  foreach ($entry in $Values.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $(if ($entry.Value -is [DBNull]) { $null } else { [string]$entry.Value }), "Process")
  }
}

function Clear-Environment {
  param([string[]]$Names)
  foreach ($name in $Names) {
    [Environment]::SetEnvironmentVariable($name, $null, "Process")
  }
}

function Invoke-Docker {
  param([string]$Engine, [string[]]$Arguments, [switch]$AllowFailure)
  if (
    -not [string]::Equals($Engine, $script:ReleaseEnginePath, [StringComparison]::OrdinalIgnoreCase) -or
    (Resolve-VerifiedPath -Path $Engine -Kind File) -cne $script:ReleaseEnginePath -or
    (Get-FileHash -LiteralPath $Engine -Algorithm SHA256).Hash.ToLowerInvariant() -cne $script:ReleaseEngineSha256
  ) {
    throw "Docker release engine identity changed before spawn"
  }
  $output = & $Engine @Arguments 2>&1 | ForEach-Object { $_.ToString() }
  if ($LASTEXITCODE -ne 0 -and -not $AllowFailure) {
    throw "Docker command failed ($LASTEXITCODE): $($Arguments[0..([Math]::Min(2, $Arguments.Count - 1))] -join ' ')"
  }
  return ($output -join "`n").Trim()
}

function Assert-ReleaseSource {
  param(
    [string]$SourceContext,
    [string]$StagedContext,
    [string]$DockerfileSha256,
    [string]$SupervisorSha256
  )
  $sourceDockerfile = Resolve-VerifiedPath -Path (Join-Path $SourceContext "Dockerfile") -Kind File
  $sourceSupervisor = Resolve-VerifiedPath -Path (Join-Path $SourceContext "opencode-preview-supervisor.ts") -Kind File
  $stagedDockerfile = Resolve-VerifiedPath -Path (Join-Path $StagedContext "Dockerfile") -Kind File
  $stagedSupervisor = Resolve-VerifiedPath -Path (Join-Path $StagedContext "opencode-preview-supervisor.ts") -Kind File
  Assert-StrictDescendant -Parent $StagedContext -Child $stagedDockerfile
  Assert-StrictDescendant -Parent $StagedContext -Child $stagedSupervisor
  foreach ($candidate in @(
    [pscustomobject]@{ Path = $sourceDockerfile; Sha256 = $DockerfileSha256 },
    [pscustomobject]@{ Path = $stagedDockerfile; Sha256 = $DockerfileSha256 },
    [pscustomobject]@{ Path = $sourceSupervisor; Sha256 = $SupervisorSha256 },
    [pscustomobject]@{ Path = $stagedSupervisor; Sha256 = $SupervisorSha256 }
  )) {
    if ((Get-FileHash -LiteralPath $candidate.Path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $candidate.Sha256) {
      throw "Workflow sandbox release source changed during the build"
    }
  }
}

function Invoke-DockerJson {
  param([string]$Engine, [string[]]$Arguments)
  $output = Invoke-Docker -Engine $Engine -Arguments $Arguments
  return $output | ConvertFrom-Json
}

function Assert-DockerResourceAbsent {
  param(
    [string]$Engine,
    [ValidateSet("Container", "Network")][string]$Kind,
    [string]$Name
  )
  $arguments = if ($Kind -eq "Container") {
    @("container", "ls", "--all", "--format", "{{.Names}}")
  } else {
    @("network", "ls", "--format", "{{.Name}}")
  }
  $output = Invoke-Docker -Engine $Engine -Arguments $arguments
  $names = @(($output -split "`r?`n") | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($names -ccontains $Name) {
    throw "Release $Kind still exists after cleanup: $Name"
  }
}

function Assert-ImageDigest {
  param([string]$Engine, [string]$Reference)
  $id = Invoke-Docker -Engine $Engine -Arguments @("image", "inspect", "--format", "{{.Id}}", $Reference)
  if ($id -notmatch '^sha256:[a-f0-9]{64}$') { throw "Pinned release image was not verified" }
  $repoDigestsJson = Invoke-Docker -Engine $Engine -Arguments @("image", "inspect", "--format", "{{json .RepoDigests}}", $Reference)
  $repoDigests = @($repoDigestsJson | ConvertFrom-Json)
  if (-not ($repoDigests -ccontains $Reference)) { throw "Pinned release image digest identity did not match" }
}

function Wait-Registry {
  param([string]$Engine, [string]$Container)
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $handler = [Net.Http.HttpClientHandler]::new()
  $handler.UseProxy = $false
  $client = [Net.Http.HttpClient]::new($handler)
  try {
    do {
      $running = Invoke-Docker -Engine $Engine -Arguments @("container", "inspect", "--format", "{{.State.Running}}", $Container) -AllowFailure
      if ($running -eq "true") {
        try {
          $response = $client.GetAsync("http://127.0.0.1:5000/v2/").GetAwaiter().GetResult()
          if ([int]$response.StatusCode -eq 200) { return }
        } catch {}
      }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Loopback release registry did not start"
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Publish-Manifest {
  param([string]$Source, [string]$Destination, [string]$Backup)
  $incoming = "$Destination.incoming"
  if (Test-Path -LiteralPath $incoming) { throw "Unknown release staging file already exists: $incoming" }
  if (Test-Path -LiteralPath $Backup) { throw "Unknown release manifest backup already exists: $Backup" }
  $publishedSha256 = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::Move($Source, $incoming)
  $hadPrevious = Test-Path -LiteralPath $Destination
  if (Test-Path -LiteralPath $Destination) {
    [IO.File]::Replace($incoming, $Destination, $Backup, $true)
  } else {
    [IO.File]::Move($incoming, $Destination)
  }
  return [pscustomobject]@{
    Destination = $Destination
    Backup = $Backup
    HadPrevious = $hadPrevious
    PublishedSha256 = $publishedSha256
  }
}

function Restore-ManifestPublication {
  param([pscustomobject]$Publication)
  $destination = [string]$Publication.Destination
  $backup = [string]$Publication.Backup
  $publishedSha256 = [string]$Publication.PublishedSha256
  if (-not (Test-Path -LiteralPath $destination)) { throw "Published manifest disappeared before rollback" }
  $current = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($current -ne $publishedSha256) { throw "Published manifest changed identity before rollback" }
  if ([bool]$Publication.HadPrevious) {
    if (-not (Test-Path -LiteralPath $backup)) { throw "Previous manifest is unavailable for rollback" }
    [IO.File]::Replace($backup, $destination, $null, $true)
    return
  }
  [IO.File]::Delete($destination)
}

function Publish-ImmutableFile {
  param([string]$Source, [string]$Destination, [string]$Sha256)
  if ($Sha256 -notmatch '^[a-f0-9]{64}$') { throw "Immutable release hash is invalid" }
  if (Test-Path -LiteralPath $Destination) {
    $existing = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($existing -ne $Sha256) { throw "Content-addressed release artifact changed identity" }
    [IO.File]::Delete($Source)
    return
  }
  try {
    [IO.File]::Move($Source, $Destination)
  } catch [IO.IOException] {
    if (-not (Test-Path -LiteralPath $Destination)) { throw }
    $winner = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($winner -ne $Sha256) { throw "Content-addressed release publication raced with another artifact" }
    [IO.File]::Delete($Source)
  }
  $published = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($published -ne $Sha256) { throw "Content-addressed release artifact failed verification" }
}

function Assert-OciDigest {
  param([string]$Archive, [string]$ExpectedDigest, [string]$VerificationRoot, [string]$Bun)
  if ($ExpectedDigest -notmatch '^sha256:[a-f0-9]{64}$') { throw "OCI expected digest is invalid" }
  $tar = "C:\Windows\System32\tar.exe"
  if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { throw "Fixed Windows tar reader is unavailable" }
  $verification = Join-Path $VerificationRoot (".release-" + [Guid]::NewGuid().ToString("N"))
  [IO.Directory]::CreateDirectory($verification) | Out-Null
  $verificationIdentity = Get-PathIdentity -Path $verification -Bun $Bun
  try {
    & $tar "-xf" $Archive "-C" $verification "index.json" "oci-layout"
    if ($LASTEXITCODE -ne 0) { throw "OCI index could not be read" }
    Assert-NoReparseTree -Root $verification
    $indexPath = Resolve-VerifiedPath -Path (Join-Path $verification "index.json") -Kind File
    $layoutPath = Resolve-VerifiedPath -Path (Join-Path $verification "oci-layout") -Kind File
    $index = Get-Content -LiteralPath $indexPath -Raw | ConvertFrom-Json
    $layout = Get-Content -LiteralPath $layoutPath -Raw | ConvertFrom-Json
    $manifests = @($index.manifests)
    if (
      $layout.imageLayoutVersion -cne "1.0.0" -or
      $index.schemaVersion -ne 2 -or
      $manifests.Count -ne 1 -or
      [string]$manifests[0].digest -cne $ExpectedDigest -or
      [string]$manifests[0].platform.os -cne "linux" -or
      [string]$manifests[0].platform.architecture -cne "amd64"
    ) {
      throw "OCI archive digest differs from the registry image digest"
    }
    $mediaType = [string]$manifests[0].mediaType
    if ($mediaType -cne "application/vnd.oci.image.manifest.v1+json") {
      throw "OCI descriptor media type is not canonical"
    }
    $digestHex = $ExpectedDigest.Substring("sha256:".Length)
    $blobRelative = "blobs/sha256/$digestHex"
    & $tar "-xf" $Archive "-C" $verification $blobRelative
    if ($LASTEXITCODE -ne 0) { throw "OCI descriptor blob could not be read" }
    Assert-NoReparseTree -Root $verification
    $blobPath = Resolve-VerifiedPath -Path (Join-Path $verification "blobs\sha256\$digestHex") -Kind File
    $blobSha256 = (Get-FileHash -LiteralPath $blobPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($blobSha256 -cne $digestHex) { throw "OCI descriptor blob hash differs from its digest" }
    if ([long]$manifests[0].size -ne (Get-Item -LiteralPath $blobPath -Force).Length) {
      throw "OCI descriptor blob size differs from its descriptor"
    }
    $descriptor = Get-Content -LiteralPath $blobPath -Raw | ConvertFrom-Json
    if (
      $descriptor.schemaVersion -ne 2 -or
      [string]$descriptor.mediaType -cne "application/vnd.oci.image.manifest.v1+json"
    ) { throw "OCI descriptor blob is malformed" }
  } finally {
    Remove-VerifiedStage -Stage $verification -Parent $VerificationRoot -ExpectedIdentity $verificationIdentity -Bun $Bun
  }
}

function Assert-StagedRelease {
  param(
    [string]$ManifestPath,
    [string]$ArchivePath,
    [string]$ExpectedImage,
    [string]$ExpectedEngine,
    [string]$ExpectedBase,
    [string]$ExpectedRegistry,
    [string]$Context,
    [string]$VerificationRoot,
    [string]$Bun
  )
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  $expectedKeys = @("schema", "image", "engine", "engineSha256", "base", "registry", "platform", "archive", "archiveSha256", "dockerfileSha256", "supervisorSha256")
  $actualKeys = @($manifest.PSObject.Properties.Name)
  $actualShape = (($actualKeys | Sort-Object) -join "`n")
  $expectedShape = (($expectedKeys | Sort-Object) -join "`n")
  if ($actualShape -cne $expectedShape) {
    throw "Workflow sandbox manifest shape is not exact"
  }
  $archiveSha256 = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $expectedArchive = "workflow-sandbox.$archiveSha256.oci.tar"
  if (
    $manifest.schema -ne 1 -or
    $manifest.image -cne $ExpectedImage -or
    $manifest.engine -cne $ExpectedEngine -or
    $manifest.engineSha256 -cne (Get-FileHash -LiteralPath $ExpectedEngine -Algorithm SHA256).Hash.ToLowerInvariant() -or
    $manifest.base -cne $ExpectedBase -or
    $manifest.registry -cne $ExpectedRegistry -or
    $manifest.platform -cne "linux/amd64" -or
    $manifest.archive -cne $expectedArchive -or
    $manifest.archiveSha256 -cne $archiveSha256 -or
    $manifest.dockerfileSha256 -cne (Get-FileHash -LiteralPath (Join-Path $Context "Dockerfile") -Algorithm SHA256).Hash.ToLowerInvariant() -or
    $manifest.supervisorSha256 -cne (Get-FileHash -LiteralPath (Join-Path $Context "opencode-preview-supervisor.ts") -Algorithm SHA256).Hash.ToLowerInvariant()
  ) {
    throw "Staged workflow sandbox manifest is not fully authenticated"
  }
  $digest = $ExpectedImage.Substring($ExpectedImage.LastIndexOf("@") + 1)
  Assert-OciDigest -Archive $ArchivePath -ExpectedDigest $digest -VerificationRoot $VerificationRoot -Bun $Bun
}

function Assert-PublishedRelease {
  param(
    [string]$Root,
    [string]$ExpectedImage,
    [string]$ExpectedEngine,
    [string]$ExpectedBase,
    [string]$ExpectedRegistry,
    [string]$Context,
    [string]$VerificationRoot,
    [string]$Bun
  )
  $manifestPath = Join-Path $Root "workflow-sandbox.manifest.json"
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $archive = Join-Path $Root ([string]$manifest.archive)
  Assert-StagedRelease -ManifestPath $manifestPath -ArchivePath $archive -ExpectedImage $ExpectedImage -ExpectedEngine $ExpectedEngine -ExpectedBase $ExpectedBase -ExpectedRegistry $ExpectedRegistry -Context $Context -VerificationRoot $VerificationRoot -Bun $Bun
  Assert-ImageDigest -Engine $ExpectedEngine -Reference $ExpectedImage
}

function Remove-VerifiedStage {
  param([string]$Stage, [string]$Parent, [string]$ExpectedIdentity, [string]$Bun)
  if (-not (Test-Path -LiteralPath $Stage)) { return }
  $fullStage = [IO.Path]::GetFullPath($Stage)
  $relative = [IO.Path]::GetRelativePath($Parent, $fullStage)
  if ($relative -notmatch '^\.release-[a-f0-9]{32}$') {
    throw "Refusing to remove an unauthenticated release stage"
  }
  $resolvedStage = Resolve-VerifiedPath -Path $fullStage -Kind Directory
  if ($resolvedStage -cne $fullStage -or (Get-PathIdentity -Path $resolvedStage -Bun $Bun) -cne $ExpectedIdentity) {
    throw "Release staging directory identity changed"
  }
  Assert-NoReparseTree -Root $resolvedStage
  if ((Get-PathIdentity -Path $resolvedStage -Bun $Bun) -cne $ExpectedIdentity) {
    throw "Release staging directory identity changed before cleanup"
  }
  [IO.Directory]::Delete($fullStage, $true)
}

if ($MyInvocation.InvocationName -ne ".") {
  Invoke-Release
}
