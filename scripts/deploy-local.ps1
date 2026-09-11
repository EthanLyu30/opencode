[CmdletBinding()]
param(
  [string]$SourceRoot,
  [Parameter(Mandatory = $true)][string]$DeploymentRoot,
  [string]$Version,
  [switch]$Rollback,
  [switch]$PrepareHostOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$fixedBunPath = "D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe"
$fixedGitPath = "C:\Program Files\Git\bin\git.exe"
$systemTarPath = "C:\Windows\System32\tar.exe"
$sandboxManifestRelative = "runtime\sandbox\workflow-sandbox.manifest.json"
$sandboxEnginePath = "D:\Applications\Docker\resources\bin\docker.exe"
$sandboxBaseImage = "oven/bun@sha256:621f249399228db47cf34611ee662585e77e015250ed29d5d0932b2d3282f0b0"
$sandboxRegistryImage = "registry@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278"
$sandboxDockerfileRelative = "packages\server\sandbox\Dockerfile"
$sandboxSupervisorRelative = "packages\server\sandbox\opencode-preview-supervisor.ts"
$sourceBinaryRelative = "packages\opencode\dist\opencode-windows-x64\bin\opencode.exe"
$managedLeaves = [ordered]@{
  Data = "data\workflow-host"
  BrowserRuntime = "runtime\playwright"
  BrowserCache = "cache\playwright"
  PreviewCapability = "tmp\workflow-host"
  DockerConfig = "config\docker"
  DockerTemp = "tmp\workflow-sandbox"
}

function Test-PathContained {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child,
    [switch]$Strict
  )
  $parentWithSeparator = $Parent.TrimEnd("\") + "\"
  if ($Child.Equals($Parent, [StringComparison]::OrdinalIgnoreCase)) { return -not $Strict }
  return $Child.StartsWith($parentWithSeparator, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeLiteral {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -match '[\x00-\x1f\x7f"%!!^&|<>]') {
    throw "$Name contains unsupported characters"
  }
}

function Assert-NoReparsePath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $cursor = Get-Item -LiteralPath $Path -Force
  while ($null -ne $cursor) {
    if (($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Name path contains a reparse point: $($cursor.FullName)"
    }
    if ($cursor -is [IO.DirectoryInfo]) {
      $cursor = $cursor.Parent
    } else {
      $cursor = $cursor.Directory
    }
  }
}

function Resolve-CanonicalDDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Name
  )
  Assert-SafeLiteral -Value $Value -Name $Name
  if (-not [IO.Path]::IsPathRooted($Value)) { throw "$Name must be absolute" }
  $lexical = [IO.Path]::GetFullPath($Value).TrimEnd("\")
  if ($lexical -notmatch '^D:\\') { throw "$Name must be on D drive" }
  if (-not (Test-Path -LiteralPath $lexical -PathType Container)) { throw "$Name does not exist" }
  Assert-NoReparsePath -Path $lexical -Name $Name
  $item = Get-Item -LiteralPath $lexical -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Name must not be a reparse point" }
  $canonical = (Resolve-Path -LiteralPath $lexical).Path.TrimEnd("\")
  if (-not $canonical.Equals($lexical, [StringComparison]::Ordinal)) { throw "$Name must use its canonical spelling" }
  return $canonical
}

function Resolve-OrCreateCanonicalDDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Name
  )
  Assert-SafeLiteral -Value $Value -Name $Name
  if (-not [IO.Path]::IsPathRooted($Value)) { throw "$Name must be absolute" }
  $lexical = [IO.Path]::GetFullPath($Value).TrimEnd("\")
  if ($lexical -notmatch '^D:\\') { throw "$Name must be on D drive" }
  $driveRoot = [IO.Path]::GetPathRoot($lexical)
  $current = $driveRoot.TrimEnd("\")
  foreach ($segment in $lexical.Substring($driveRoot.Length).Split(@("\"), [StringSplitOptions]::RemoveEmptyEntries)) {
    $next = "$current\$segment"
    if (Test-Path -LiteralPath $next) {
      $item = Get-Item -LiteralPath $next -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Name path is redirected: $next"
      }
    } else {
      [IO.Directory]::CreateDirectory($next) | Out-Null
    }
    $resolved = (Resolve-Path -LiteralPath $next).Path.TrimEnd("\")
    if (-not $resolved.Equals($next, [StringComparison]::Ordinal)) { throw "$Name must use its canonical spelling" }
    $current = $resolved
  }
  return $current
}

function Resolve-ProspectiveCanonicalDDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Name
  )
  Assert-SafeLiteral -Value $Value -Name $Name
  if (-not [IO.Path]::IsPathRooted($Value)) { throw "$Name must be absolute" }
  $lexical = [IO.Path]::GetFullPath($Value).TrimEnd("\")
  if ($lexical -notmatch '^D:\\') { throw "$Name must be on D drive" }
  if (-not $lexical.Equals($Value.TrimEnd("\"), [StringComparison]::Ordinal)) {
    throw "$Name must use a normalized canonical spelling"
  }
  $driveRoot = [IO.Path]::GetPathRoot($lexical)
  $current = $driveRoot.TrimEnd("\")
  $missingAncestor = $false
  foreach ($segment in $lexical.Substring($driveRoot.Length).Split(@("\"), [StringSplitOptions]::RemoveEmptyEntries)) {
    $next = "$current\$segment"
    if (-not $missingAncestor -and (Test-Path -LiteralPath $next)) {
      $item = Get-Item -LiteralPath $next -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Name path is redirected: $next"
      }
      $resolved = (Resolve-Path -LiteralPath $next).Path.TrimEnd("\")
      if (-not $resolved.Equals($next, [StringComparison]::Ordinal)) {
        throw "$Name must use its canonical spelling"
      }
      $current = $resolved
      continue
    }
    $missingAncestor = $true
    $current = $next
  }
  return $lexical
}

function Resolve-CanonicalDFile {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Name
  )
  Assert-SafeLiteral -Value $Value -Name $Name
  if (-not [IO.Path]::IsPathRooted($Value)) { throw "$Name must be absolute" }
  $lexical = [IO.Path]::GetFullPath($Value)
  if ($lexical -notmatch '^D:\\') { throw "$Name must be on D drive" }
  if (-not (Test-Path -LiteralPath $lexical -PathType Leaf)) { throw "$Name does not exist" }
  Assert-NoReparsePath -Path $lexical -Name $Name
  $item = Get-Item -LiteralPath $lexical -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Name must not be a reparse point" }
  if ($item.LinkType -eq "HardLink") { throw "$Name must not be a hard link" }
  $canonical = (Resolve-Path -LiteralPath $lexical).Path
  if (-not $canonical.Equals($lexical, [StringComparison]::Ordinal)) { throw "$Name must use its canonical spelling" }
  return $canonical
}

function Resolve-CanonicalFixedFile {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$Name,
    [switch]$AllowHardLink
  )
  Assert-SafeLiteral -Value $Value -Name $Name
  if (-not [IO.Path]::IsPathRooted($Value)) { throw "$Name must be absolute" }
  $lexical = [IO.Path]::GetFullPath($Value)
  if (-not (Test-Path -LiteralPath $lexical -PathType Leaf)) { throw "$Name does not exist" }
  Assert-NoReparsePath -Path $lexical -Name $Name
  $item = Get-Item -LiteralPath $lexical -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Name must not be a reparse point" }
  if ($item.LinkType -eq "HardLink") {
    if (-not $AllowHardLink) { throw "$Name must not be a hard link" }
    $signature = Get-AuthenticodeSignature -LiteralPath $lexical
    if (
      $signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or
      $null -eq $signature.SignerCertificate -or
      -not $signature.SignerCertificate.Subject.StartsWith("CN=Microsoft Windows,", [StringComparison]::Ordinal)
    ) {
      throw "$Name hard link is not an authenticated Windows component"
    }
  }
  $canonical = (Resolve-Path -LiteralPath $lexical).Path
  if (-not $canonical.Equals($lexical, [StringComparison]::Ordinal)) { throw "$Name must use its canonical spelling" }
  return $canonical
}

function Set-ScopedChildEnvironment {
  param([Parameter(Mandatory = $true)][Collections.IDictionary]$Values)
  $saved = @{}
  foreach ($entry in $Values.GetEnumerator()) {
    $name = [string]$entry.Key
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    if ($null -eq $entry.Value) {
      Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    } else {
      [Environment]::SetEnvironmentVariable($name, $entry.Value, "Process")
    }
  }
  return $saved
}

function Restore-ScopedChildEnvironment {
  param([Parameter(Mandatory = $true)][Collections.IDictionary]$Values)
  foreach ($entry in $Values.GetEnumerator()) {
    $name = [string]$entry.Key
    if ($null -eq $entry.Value) {
      Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    } else {
      [Environment]::SetEnvironmentVariable($name, $entry.Value, "Process")
    }
  }
}

function Ensure-ManagedDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Relative
  )
  if ([IO.Path]::IsPathRooted($Relative) -or $Relative -match '(^|\\)\.\.?($|\\)') {
    throw "Managed directory must be a simple relative path"
  }
  $current = $Root
  foreach ($segment in $Relative.Split(@("\"), [StringSplitOptions]::RemoveEmptyEntries)) {
    $next = Join-Path $current $segment
    if (Test-Path -LiteralPath $next) {
      $item = Get-Item -LiteralPath $next -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Managed directory path is redirected: $next"
      }
    } else {
      [IO.Directory]::CreateDirectory($next) | Out-Null
    }
    $resolved = (Resolve-Path -LiteralPath $next).Path
    if (-not (Test-PathContained -Parent $Root -Child $resolved -Strict)) {
      throw "Managed directory escaped deployment root"
    }
    $current = $resolved
  }
  return $current
}

function Resolve-ExistingManagedDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Relative,
    [Parameter(Mandatory = $true)][string]$Name
  )
  if ([IO.Path]::IsPathRooted($Relative) -or $Relative -match '(^|\\)\.\.?($|\\)') {
    throw "Managed directory must be a simple relative path"
  }
  $resolved = Resolve-CanonicalDDirectory -Value (Join-Path $Root $Relative) -Name $Name
  if (-not (Test-PathContained -Parent $Root -Child $resolved -Strict)) {
    throw "$Name escaped deployment root"
  }
  return $resolved
}

function Assert-ProtectedAcl {
  param([Parameter(Mandatory = $true)][string]$Path)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $currentSid) { throw "Current Windows identity has no SID" }
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $access = [Security.AccessControl.AccessControlType]::Allow
  $verified = Get-Acl -LiteralPath $Path
  if (-not $verified.AreAccessRulesProtected) { throw "Protected ACL inheritance is disabled: $Path" }
  $ownerSid = (New-Object Security.Principal.NTAccount($verified.Owner)).Translate([Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -cne $currentSid.Value) { throw "Protected ACL owner is wrong: $Path" }
  $rules = @($verified.Access)
  if ($rules.Count -ne 3) { throw "Protected ACL contains unexpected authority: $Path" }
  foreach ($sidValue in @($currentSid.Value, "S-1-5-18", "S-1-5-32-544")) {
    $matches = @($rules | Where-Object {
        $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sidValue -and
        $_.AccessControlType -eq $access -and
        [int]$_.FileSystemRights -eq [int][Security.AccessControl.FileSystemRights]::FullControl -and
        $_.InheritanceFlags -eq $inheritance -and
        $_.PropagationFlags -eq $propagation -and
        -not $_.IsInherited
      })
    if ($matches.Count -ne 1) { throw "Protected ACL is missing one exact trusted grant: $Path" }
  }
}

function Set-ProtectedAcl {
  param([Parameter(Mandatory = $true)][string]$Path)
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $currentSid) { throw "Current Windows identity has no SID" }
  $security = New-Object Security.AccessControl.DirectorySecurity
  $security.SetOwner($currentSid)
  $security.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $access = [Security.AccessControl.AccessControlType]::Allow
  foreach ($sidValue in @($currentSid.Value, "S-1-5-18", "S-1-5-32-544")) {
    $sid = New-Object Security.Principal.SecurityIdentifier($sidValue)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      $propagation,
      $access
    )
    [void]$security.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $security
  Assert-ProtectedAcl -Path $Path
}

function Assert-DeploymentAclBoundary {
  param(
    [Parameter(Mandatory = $true)][string]$Deployment,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Roots,
    [Parameter(Mandatory = $true)][string]$SandboxRuntimeRoot
  )
  Assert-ProtectedAcl -Path $Deployment
  foreach ($entry in $managedLeaves.GetEnumerator()) {
    Assert-ProtectedAcl -Path ([string]$Roots[$entry.Key])
  }
  Assert-ProtectedAcl -Path $SandboxRuntimeRoot
}

function Read-OciTarEntry {
  param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Entry,
    [Parameter(Mandatory = $true)][long]$MaximumBytes
  )
  if ($Entry -notmatch '^(?:oci-layout|index\.json|blobs/sha256/[a-f0-9]{64})$') {
    throw "OCI archive entry name is invalid"
  }
  if ($MaximumBytes -le 0) { throw "OCI archive entry limit is invalid" }
  $tarReader = Resolve-CanonicalFixedFile -Value $systemTarPath -Name "Fixed Windows tar reader" -AllowHardLink
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $tarReader
  $start.Arguments = "-xOf `"$Archive`" `"$Entry`""
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  $memory = New-Object IO.MemoryStream
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    if (-not $process.Start()) { throw "Could not start the fixed OCI archive reader" }
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $buffer = New-Object byte[] 65536
    [long]$length = 0
    while (($read = $process.StandardOutput.BaseStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $length += $read
      if ($length -gt $MaximumBytes) {
        try { $process.Kill() } catch {}
        throw "OCI archive entry exceeds its size limit: $Entry"
      }
      $memory.Write($buffer, 0, $read)
      $null = $sha.TransformBlock($buffer, 0, $read, $null, 0)
    }
    $null = $sha.TransformFinalBlock((New-Object byte[] 0), 0, 0)
    $process.WaitForExit()
    $stderr = [string]$stderrTask.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      if ($stderr.Length -gt 4096) { $stderr = $stderr.Substring(0, 4096) }
      throw "OCI archive entry could not be read: $Entry ($stderr)"
    }
    return [PSCustomObject]@{
      Bytes = $memory.ToArray()
      Hash = ([BitConverter]::ToString($sha.Hash)).Replace("-", "").ToLowerInvariant()
      Length = $length
    }
  } finally {
    $sha.Dispose()
    $memory.Dispose()
    $process.Dispose()
  }
}

function ConvertFrom-OciJson {
  param(
    [Parameter(Mandatory = $true)][byte[]]$Bytes,
    [Parameter(Mandatory = $true)][string]$Name
  )
  try {
    $text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes)
    return $text | ConvertFrom-Json
  } catch {
    throw "$Name is not strict UTF-8 JSON"
  }
}

function Assert-OciArchiveImage {
  param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Image
  )
  $imageMatch = [regex]::Match($Image, '^127\.0\.0\.1:5000/opencode/workflow-sandbox@sha256:([a-f0-9]{64})$')
  if (-not $imageMatch.Success) { throw "Sandbox image must be one exact repository digest" }
  $imageHex = $imageMatch.Groups[1].Value
  $layoutEntry = Read-OciTarEntry -Archive $Archive -Entry "oci-layout" -MaximumBytes 4096
  $layout = ConvertFrom-OciJson -Bytes $layoutEntry.Bytes -Name "OCI layout marker"
  if (
    $null -eq $layout.PSObject.Properties["imageLayoutVersion"] -or
    $layout.imageLayoutVersion -isnot [string] -or
    $layout.imageLayoutVersion -cne "1.0.0"
  ) {
    throw "OCI layout marker is invalid"
  }
  $indexEntry = Read-OciTarEntry -Archive $Archive -Entry "index.json" -MaximumBytes 1048576
  $index = ConvertFrom-OciJson -Bytes $indexEntry.Bytes -Name "OCI image index"
  if (
    $null -eq $index.PSObject.Properties["schemaVersion"] -or
    $index.schemaVersion -ne 2 -or
    $null -eq $index.PSObject.Properties["manifests"]
  ) {
    throw "OCI image index is invalid"
  }
  $descriptors = @($index.manifests)
  if ($descriptors.Count -ne 1) { throw "OCI image index must contain one release descriptor" }
  $descriptor = $descriptors[0]
  foreach ($property in @("digest", "mediaType", "platform", "size")) {
    if ($null -eq $descriptor.PSObject.Properties[$property]) {
      throw "OCI release descriptor is missing $property"
    }
  }
  if (
    $descriptor.digest -isnot [string] -or
    $descriptor.digest -cne "sha256:$imageHex" -or
    $descriptor.mediaType -isnot [string] -or
    $descriptor.mediaType -cne "application/vnd.oci.image.manifest.v1+json" -or
    $descriptor.platform -isnot [PSCustomObject] -or
    $null -eq $descriptor.platform.PSObject.Properties["architecture"] -or
    $null -eq $descriptor.platform.PSObject.Properties["os"] -or
    $descriptor.platform.architecture -isnot [string] -or
    $descriptor.platform.architecture -cne "amd64" -or
    $descriptor.platform.os -isnot [string] -or
    $descriptor.platform.os -cne "linux" -or
    $descriptor.size -isnot [ValueType] -or
    [long]$descriptor.size -le 0 -or
    [long]$descriptor.size -gt 16777216
  ) {
    throw "OCI release descriptor does not match the pinned image"
  }
  $manifestEntry = Read-OciTarEntry -Archive $Archive -Entry "blobs/sha256/$imageHex" -MaximumBytes 16777216
  if ($manifestEntry.Hash -cne $imageHex -or $manifestEntry.Length -ne [long]$descriptor.size) {
    throw "OCI image manifest blob does not match its descriptor"
  }
  $imageManifest = ConvertFrom-OciJson -Bytes $manifestEntry.Bytes -Name "OCI image manifest"
  if (
    $null -eq $imageManifest.PSObject.Properties["schemaVersion"] -or
    $imageManifest.schemaVersion -ne 2 -or
    $null -eq $imageManifest.PSObject.Properties["mediaType"] -or
    $imageManifest.mediaType -isnot [string] -or
    $imageManifest.mediaType -cne $descriptor.mediaType
  ) {
    throw "OCI image manifest structure is invalid"
  }
}

function Read-ExactSandboxManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$SourceRoot
  )
  $manifestPath = Resolve-CanonicalDFile -Value (Join-Path $Root $sandboxManifestRelative) -Name "Sandbox manifest"
  if (-not (Test-PathContained -Parent $Root -Child $manifestPath -Strict)) { throw "Sandbox manifest escaped deployment root" }
  $item = Get-Item -LiteralPath $manifestPath
  if ($item.Length -le 0 -or $item.Length -gt 16384) { throw "Sandbox manifest size is invalid" }
  $raw = [IO.File]::ReadAllText($manifestPath, [Text.UTF8Encoding]::new($false, $true))
  try { $manifest = $raw | ConvertFrom-Json } catch { throw "Sandbox manifest is malformed" }
  $names = @($manifest.PSObject.Properties.Name | Sort-Object)
  $expectedNames = @(
    "archive",
    "archiveSha256",
    "base",
    "dockerfileSha256",
    "engine",
    "engineSha256",
    "image",
    "platform",
    "registry",
    "schema",
    "supervisorSha256"
  ) | Sort-Object
  if ((@($names) -join "`0") -cne (@($expectedNames) -join "`0")) {
    throw "Sandbox manifest has an unsupported shape"
  }
  $stringFields = @(
    $manifest.archive,
    $manifest.archiveSha256,
    $manifest.base,
    $manifest.dockerfileSha256,
    $manifest.engine,
    $manifest.engineSha256,
    $manifest.image,
    $manifest.platform,
    $manifest.registry,
    $manifest.supervisorSha256
  )
  if ($manifest.schema -ne 1 -or @($stringFields | Where-Object { $_ -isnot [string] }).Count -ne 0) {
    throw "Sandbox manifest fields are invalid"
  }
  $reviewedDockerfile = Resolve-CanonicalDFile -Value (Join-Path $SourceRoot $sandboxDockerfileRelative) -Name "Reviewed sandbox Dockerfile"
  $reviewedSupervisor = Resolve-CanonicalDFile -Value (Join-Path $SourceRoot $sandboxSupervisorRelative) -Name "Reviewed sandbox supervisor"
  if (
    -not (Test-PathContained -Parent $SourceRoot -Child $reviewedDockerfile -Strict) -or
    -not (Test-PathContained -Parent $SourceRoot -Child $reviewedSupervisor -Strict)
  ) {
    throw "Reviewed sandbox sources escaped SourceRoot"
  }
  $dockerfileSha256 = (Get-FileHash -LiteralPath $reviewedDockerfile -Algorithm SHA256).Hash.ToLowerInvariant()
  $supervisorSha256 = (Get-FileHash -LiteralPath $reviewedSupervisor -Algorithm SHA256).Hash.ToLowerInvariant()
  $engine = Resolve-CanonicalDFile -Value $manifest.engine -Name "Sandbox engine"
  $expectedEngine = Resolve-CanonicalDFile -Value $sandboxEnginePath -Name "Approved sandbox engine"
  if (-not $engine.Equals($expectedEngine, [StringComparison]::Ordinal)) {
    throw "Sandbox engine is outside the fixed approved boundary"
  }
  if ($manifest.engineSha256 -cne (Get-FileHash -LiteralPath $engine -Algorithm SHA256).Hash.ToLowerInvariant()) {
    throw "Sandbox manifest engine hash does not match the approved engine"
  }
  if ($manifest.image -notmatch '^127\.0\.0\.1:5000/opencode/workflow-sandbox@sha256:[a-f0-9]{64}$') {
    throw "Sandbox image must be one exact repository digest"
  }
  $archiveNameMatch = [regex]::Match([string]$manifest.archive, '^workflow-sandbox\.([a-f0-9]{64})\.oci\.tar$')
  if (
    $manifest.base -cne $sandboxBaseImage -or
    $manifest.registry -cne $sandboxRegistryImage -or
    $manifest.platform -cne "linux/amd64" -or
    -not $archiveNameMatch.Success -or
    $manifest.archiveSha256 -notmatch '^[a-f0-9]{64}$' -or
    $archiveNameMatch.Groups[1].Value -cne $manifest.archiveSha256 -or
    $manifest.dockerfileSha256 -cne $dockerfileSha256 -or
    $manifest.supervisorSha256 -cne $supervisorSha256
  ) {
    throw "Sandbox manifest release evidence is invalid"
  }
  $archive = Resolve-CanonicalDFile -Value (Join-Path (Split-Path -Parent $manifestPath) $manifest.archive) -Name "Sandbox OCI archive"
  if (-not (Test-PathContained -Parent $Root -Child $archive -Strict)) { throw "Sandbox archive escaped deployment root" }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.archiveSha256) {
    throw "Sandbox archive hash does not match its manifest"
  }
  Assert-OciArchiveImage -Archive $archive -Image $manifest.image
  $archiveAfter = Resolve-CanonicalDFile -Value $archive -Name "Sandbox OCI archive"
  if (
    $archiveAfter -cne $archive -or
    (Get-FileHash -LiteralPath $archiveAfter -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifest.archiveSha256
  ) {
    throw "Sandbox archive identity changed while it was being inspected"
  }
  return [PSCustomObject]@{
    Archive = $manifest.archive
    ArchiveSha256 = $manifest.archiveSha256
    Base = $manifest.base
    DockerfileSha256 = $manifest.dockerfileSha256
    Engine = $engine
    EngineSha256 = $manifest.engineSha256
    Image = $manifest.image
    Registry = $manifest.registry
    SupervisorSha256 = $manifest.supervisorSha256
  }
}

function Get-ExecutableVersion {
  param([Parameter(Mandatory = $true)][string]$Path)
  $lines = & $Path --version 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Executable version probe failed: $Path" }
  $first = @($lines | Select-Object -First 1)
  if ($first.Count -ne 1) {
    throw "Executable version probe returned an invalid value"
  }
  $actual = ([string]$first[0]).Trim()
  if ([string]::IsNullOrWhiteSpace($actual)) { throw "Executable version probe returned an invalid value" }
  return $actual
}

function Stop-ExactExecutable {
  param([Parameter(Mandatory = $true)][string]$Executable)
  $canonical = [IO.Path]::GetFullPath($Executable)
  $owned = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $_.ExecutablePath -and ([IO.Path]::GetFullPath([string]$_.ExecutablePath)).Equals($canonical, [StringComparison]::OrdinalIgnoreCase)
    })
  foreach ($process in $owned) {
    $fresh = @(Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ProcessId)" -ErrorAction Stop)
    if ($fresh.Count -ne 1) { continue }
    if (
      -not $fresh[0].ExecutablePath -or
      -not ([IO.Path]::GetFullPath([string]$fresh[0].ExecutablePath)).Equals($canonical, [StringComparison]::OrdinalIgnoreCase) -or
      [string]$fresh[0].CreationDate -cne [string]$process.CreationDate
    ) {
      continue
    }
    Stop-Process -Id $fresh[0].ProcessId -Force -ErrorAction Stop
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
      $remaining = @(Get-CimInstance Win32_Process -Filter "ProcessId=$($fresh[0].ProcessId)" -ErrorAction Stop | Where-Object {
          $_.ExecutablePath -and
          ([IO.Path]::GetFullPath([string]$_.ExecutablePath)).Equals($canonical, [StringComparison]::OrdinalIgnoreCase) -and
          [string]$_.CreationDate -ceq [string]$fresh[0].CreationDate
        })
      if ($remaining.Count -eq 0) { break }
      [Threading.Thread]::Sleep(50)
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($remaining.Count -ne 0) {
      throw "Exact deployed executable process did not stop: $($fresh[0].ProcessId)"
    }
  }
}

function Write-FlushedCopy {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  if (Test-Path -LiteralPath $Destination) { throw "Deployment staging path already exists" }
  $input = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $output = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      $input.CopyTo($output)
      $output.Flush($true)
    } finally {
      $output.Dispose()
    }
  } finally {
    $input.Dispose()
  }
}

function Write-AtomicText {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Text
  )
  $stage = "$Path.new"
  if (Test-Path -LiteralPath $stage) { throw "Text staging path already exists: $stage" }
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
  $stream = [IO.File]::Open($stage, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  if (Test-Path -LiteralPath $Path) {
    $previous = "$Path.previous"
    if (Test-Path -LiteralPath $previous) { throw "Text replacement backup already exists: $previous" }
    [IO.File]::Replace($stage, $Path, $previous, $true)
    [IO.File]::Delete($previous)
  } else {
    [IO.File]::Move($stage, $Path)
  }
}

function Read-BuildInfoValue {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Name
  )
  $match = [regex]::Match($Text, "(?m)^$([regex]::Escape($Name)):\s*(.+)$")
  if (-not $match.Success) { return $null }
  return $match.Groups[1].Value.Trim()
}

function Read-AuthenticatedBuildInfo {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $canonical = Resolve-CanonicalDFile -Value $Path -Name "BUILD-INFO"
  $item = Get-Item -LiteralPath $canonical -Force
  if ($item.Length -le 0 -or $item.Length -gt 65536) { throw "BUILD-INFO size is invalid" }
  $text = [IO.File]::ReadAllText($canonical, [Text.UTF8Encoding]::new($false, $true))
  $buildVersion = Read-BuildInfoValue -Text $text -Name "Build version"
  $binaryHash = Read-BuildInfoValue -Text $text -Name "Binary SHA256"
  $rollbackVersion = Read-BuildInfoValue -Text $text -Name "Rollback version"
  $rollbackHash = Read-BuildInfoValue -Text $text -Name "Rollback SHA256"
  $legacy = $null -eq $rollbackVersion -and $null -eq $rollbackHash
  if ($legacy) {
    $rollbackVersion = "none"
    $rollbackHash = "none"
  }
  if (
    [string]::IsNullOrWhiteSpace($buildVersion) -or
    $binaryHash -notmatch '^[A-F0-9]{64}$' -or
    [string]::IsNullOrWhiteSpace($rollbackVersion) -or
    [string]::IsNullOrWhiteSpace($rollbackHash) -or
    (($rollbackVersion -ceq "none") -ne ($rollbackHash -ceq "none")) -or
    ($rollbackHash -cne "none" -and $rollbackHash -notmatch '^[A-F0-9]{64}$')
  ) {
    throw "BUILD-INFO cannot authenticate the deployment pair"
  }
  return [PSCustomObject]@{
    BuildVersion = $buildVersion
    BinaryHash = $binaryHash
    RollbackVersion = $rollbackVersion
    RollbackHash = $rollbackHash
    Legacy = $legacy
  }
}

function Write-FlushedText {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Text
  )
  if (Test-Path -LiteralPath $Path) { throw "Deployment text staging path already exists: $Path" }
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
  $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
}

function Get-ManagedFileState {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name,
    [switch]$Executable
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    return [PSCustomObject]@{ Present = $false; Hash = $null; Version = $null }
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Name is not an ordinary file" }
  $canonical = Resolve-CanonicalDFile -Value $Path -Name $Name
  $first = Get-Item -LiteralPath $canonical -Force
  $hash = (Get-FileHash -LiteralPath $canonical -Algorithm SHA256).Hash
  $version = if ($Executable) { Get-ExecutableVersion $canonical } else { $null }
  $second = Get-Item -LiteralPath (Resolve-CanonicalDFile -Value $canonical -Name $Name) -Force
  if (
    $first.Length -ne $second.Length -or
    $first.CreationTimeUtc.Ticks -ne $second.CreationTimeUtc.Ticks -or
    $first.LastWriteTimeUtc.Ticks -ne $second.LastWriteTimeUtc.Ticks
  ) {
    throw "$Name identity changed while it was being inspected"
  }
  return [PSCustomObject]@{ Present = $true; Hash = $hash; Version = $version }
}

function Test-FileStateEqual {
  param(
    [Parameter(Mandatory = $true)]$Left,
    [Parameter(Mandatory = $true)]$Right
  )
  if ([bool]$Left.Present -ne [bool]$Right.Present) { return $false }
  if (-not [bool]$Left.Present) { return $true }
  return [string]$Left.Hash -ceq [string]$Right.Hash -and [string]$Left.Version -ceq [string]$Right.Version
}

function Assert-FileStateShape {
  param(
    [Parameter(Mandatory = $true)]$State,
    [Parameter(Mandatory = $true)][string]$Name,
    [switch]$Executable
  )
  $names = @($State.PSObject.Properties.Name | Sort-Object)
  if (($names -join "`0") -cne ((@("Hash", "Present", "Version") | Sort-Object) -join "`0")) {
    throw "$Name transaction state has an unsupported shape"
  }
  if ($State.Present -isnot [bool]) { throw "$Name transaction presence is invalid" }
  if (-not $State.Present) {
    if ($null -ne $State.Hash -or $null -ne $State.Version) { throw "$Name absent transaction state contains data" }
    return
  }
  if ($State.Hash -isnot [string] -or $State.Hash -notmatch '^[A-F0-9]{64}$') {
    throw "$Name transaction hash is invalid"
  }
  if ($Executable) {
    if ($State.Version -isnot [string] -or $State.Version -notmatch '^[0-9A-Za-z][0-9A-Za-z .,_+()/=-]{0,127}$') {
      throw "$Name transaction version is invalid"
    }
  } elseif ($null -ne $State.Version) {
    throw "$Name non-executable transaction state has a version"
  }
}

function Assert-FileState {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)]$Expected,
    [switch]$Executable
  )
  $actual = Get-ManagedFileState -Path $Path -Name $Name -Executable:$Executable
  if (-not (Test-FileStateEqual -Left $actual -Right $Expected)) {
    throw "$Name does not match the authenticated deployment transaction"
  }
  return $actual
}

function Get-TextHash {
  param([Parameter(Mandatory = $true)][string]$Text)
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.UTF8Encoding]::new($false).GetBytes($Text))).Replace("-", ""))
  } finally {
    $sha.Dispose()
  }
}

function Invoke-DeploymentCrashPoint {
  param([Parameter(Mandatory = $true)][string]$Name)
  if ([Environment]::GetEnvironmentVariable("OPENCODE_DEPLOY_TEST_CRASH_AFTER", "Process") -cne $Name) { return }
  [Diagnostics.Process]::GetCurrentProcess().Kill()
  while ($true) { Start-Sleep -Seconds 1 }
}

function Invoke-AtomicFileReplace {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Backup
  )
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ($true) {
    try {
      [IO.File]::Replace($Source, $Destination, $Backup, $true)
      return
    } catch [IO.IOException] {
      $nativeCode = $_.Exception.HResult -band 0xffff
      if (@(32, 33) -cnotcontains $nativeCode -or [DateTime]::UtcNow -ge $deadline) { throw }
      [Threading.Thread]::Sleep(50)
    }
  }
}

function Invoke-AtomicDirectoryMove {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination
  )
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ($true) {
    try {
      [IO.Directory]::Move($Source, $Destination)
      return
    } catch [IO.IOException] {
      $nativeCode = $_.Exception.HResult -band 0xffff
      if (@(5, 32, 33) -cnotcontains $nativeCode -or [DateTime]::UtcNow -ge $deadline) { throw }
      [Threading.Thread]::Sleep(50)
    }
  }
}

function Assert-TransactionProperties {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string[]]$Names,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $expected = @($Names | Sort-Object)
  if (($actual -join "`0") -cne ($expected -join "`0")) { throw "$Label has an unsupported shape" }
}

function Read-DeploymentTransaction {
  param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$Deployment
  )
  $transactionDirectory = Resolve-CanonicalDDirectory -Value $Directory -Name "Deployment transaction directory"
  if (-not (Test-PathContained -Parent $Deployment -Child $transactionDirectory -Strict)) {
    throw "Deployment transaction escaped its root"
  }
  $manifestPath = Join-Path $transactionDirectory "manifest.json"
  $manifestState = Get-ManagedFileState -Path $manifestPath -Name "Deployment transaction manifest"
  if (-not $manifestState.Present) { throw "Deployment transaction manifest is missing" }
  $item = Get-Item -LiteralPath $manifestPath -Force
  if ($item.Length -le 0 -or $item.Length -gt 65536) { throw "Deployment transaction manifest size is invalid" }
  $raw = [IO.File]::ReadAllText($manifestPath, [Text.UTF8Encoding]::new($false, $true))
  try { $manifest = $raw | ConvertFrom-Json } catch { throw "Deployment transaction manifest is malformed" }
  Assert-TransactionProperties -Value $manifest -Label "Deployment transaction manifest" -Names @(
    "action",
    "candidateHash",
    "deploymentRoot",
    "desiredBackup",
    "desiredBuildInfoHash",
    "desiredLauncherHash",
    "previousBackup",
    "previousBuildInfo",
    "previousLauncher",
    "previousTarget",
    "schema",
    "transactionId",
    "version"
  )
  if (
    $manifest.schema -ne 1 -or
    $manifest.transactionId -isnot [string] -or $manifest.transactionId -notmatch '^[a-f0-9]{32}$' -or
    $manifest.deploymentRoot -isnot [string] -or $manifest.deploymentRoot -cne $Deployment -or
    $manifest.action -isnot [string] -or @("deploy", "rollback") -cnotcontains $manifest.action -or
    $manifest.version -isnot [string] -or $manifest.version -notmatch '^[0-9A-Za-z][0-9A-Za-z .,_+()/=-]{0,127}$' -or
    $manifest.candidateHash -isnot [string] -or $manifest.candidateHash -notmatch '^[A-F0-9]{64}$' -or
    $manifest.desiredLauncherHash -isnot [string] -or $manifest.desiredLauncherHash -notmatch '^[A-F0-9]{64}$' -or
    $manifest.desiredBuildInfoHash -isnot [string] -or $manifest.desiredBuildInfoHash -notmatch '^[A-F0-9]{64}$'
  ) {
    throw "Deployment transaction manifest fields are invalid"
  }
  Assert-FileStateShape -State $manifest.previousTarget -Name "Previous target" -Executable
  Assert-FileStateShape -State $manifest.previousBackup -Name "Previous backup" -Executable
  Assert-FileStateShape -State $manifest.previousLauncher -Name "Previous launcher"
  Assert-FileStateShape -State $manifest.previousBuildInfo -Name "Previous BUILD-INFO"
  Assert-FileStateShape -State $manifest.desiredBackup -Name "Desired backup" -Executable
  $desiredTarget = [PSCustomObject]@{ Present = $true; Hash = [string]$manifest.candidateHash; Version = [string]$manifest.version }
  $desiredLauncher = [PSCustomObject]@{ Present = $true; Hash = [string]$manifest.desiredLauncherHash; Version = $null }
  $desiredBuildInfo = [PSCustomObject]@{ Present = $true; Hash = [string]$manifest.desiredBuildInfoHash; Version = $null }
  return [PSCustomObject]@{
    Directory = $transactionDirectory
    ManifestPath = $manifestPath
    ManifestState = $manifestState
    Data = $manifest
    DesiredTarget = $desiredTarget
    DesiredLauncher = $desiredLauncher
    DesiredBuildInfo = $desiredBuildInfo
  }
}

function Install-TransactionFile {
  param(
    [Parameter(Mandatory = $true)]$Transaction,
    [Parameter(Mandatory = $true)][string]$StageName,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)]$Previous,
    [Parameter(Mandatory = $true)]$Desired,
    [Parameter(Mandatory = $true)][string]$DisplacedName,
    [switch]$Executable,
    [switch]$StopExactTarget
  )
  $current = Get-ManagedFileState -Path $Target -Name $Name -Executable:$Executable
  if (Test-FileStateEqual -Left $current -Right $Desired) { return }
  if (-not (Test-FileStateEqual -Left $current -Right $Previous)) {
    throw "$Name changed outside the authenticated deployment transaction"
  }
  if (-not $Desired.Present) {
    if ($current.Present) { throw "$Name would require an unauthorized deletion" }
    return
  }
  $stage = Join-Path $Transaction.Directory $StageName
  $null = Assert-FileState -Path $stage -Name "$Name stage" -Expected $Desired -Executable:$Executable
  $displaced = Join-Path $Transaction.Directory $DisplacedName
  if (Test-Path -LiteralPath $displaced) { throw "$Name displaced-file path is already occupied" }
  if ($StopExactTarget -and $current.Present) {
    Stop-ExactExecutable -Executable $Target
    $null = Assert-FileState -Path $Target -Name $Name -Expected $Previous -Executable:$Executable
  }
  if ($current.Present) {
    Invoke-AtomicFileReplace -Source $stage -Destination $Target -Backup $displaced
  } else {
    [IO.File]::Move($stage, $Target)
  }
  $null = Assert-FileState -Path $Target -Name $Name -Expected $Desired -Executable:$Executable
}

function Assert-CompletedTransaction {
  param(
    [Parameter(Mandatory = $true)]$Transaction,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$Backup,
    [Parameter(Mandatory = $true)][string]$Launcher,
    [Parameter(Mandatory = $true)][string]$BuildInfo
  )
  $null = Assert-FileState -Path $Target -Name "Deployed executable" -Expected $Transaction.DesiredTarget -Executable
  $null = Assert-FileState -Path $Backup -Name "Rollback executable" -Expected $Transaction.Data.desiredBackup -Executable
  $null = Assert-FileState -Path $Launcher -Name "Launcher" -Expected $Transaction.DesiredLauncher
  $null = Assert-FileState -Path $BuildInfo -Name "BUILD-INFO" -Expected $Transaction.DesiredBuildInfo
}

function Remove-AuthenticatedTransactionArtifact {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)]$Expected,
    [switch]$Executable
  )
  if (-not (Test-Path -LiteralPath $Path)) { return }
  if (-not $Expected.Present) { throw "$Name exists without deletion authority" }
  $null = Assert-FileState -Path $Path -Name $Name -Expected $Expected -Executable:$Executable
  [IO.File]::Delete($Path)
}

function Assert-NoUnknownTransactionArtifacts {
  param([Parameter(Mandatory = $true)]$Transaction)
  $allowed = @(
    "backup.exe",
    "build-info.txt",
    "candidate.exe",
    "launcher.cmd",
    "manifest.json",
    "previous-backup.exe",
    "previous-build-info.txt",
    "previous-launcher.cmd",
    "previous-target.exe"
  )
  foreach ($entry in @(Get-ChildItem -LiteralPath $Transaction.Directory -Force)) {
    if ($entry.PSIsContainer -or $allowed -cnotcontains $entry.Name) {
      throw "Deployment transaction contains an unknown artifact: $($entry.Name)"
    }
  }
}

function Remove-CompletedTransaction {
  param([Parameter(Mandatory = $true)]$Transaction)
  Assert-NoUnknownTransactionArtifacts -Transaction $Transaction
  Remove-AuthenticatedTransactionArtifact -Path (Join-Path $Transaction.Directory "candidate.exe") -Name "Candidate stage" -Expected $Transaction.DesiredTarget -Executable
  Remove-AuthenticatedTransactionArtifact -Path (Join-Path $Transaction.Directory "backup.exe") -Name "Backup stage" -Expected $Transaction.Data.desiredBackup -Executable
  Remove-AuthenticatedTransactionArtifact -Path (Join-Path $Transaction.Directory "launcher.cmd") -Name "Launcher stage" -Expected $Transaction.DesiredLauncher
  Remove-AuthenticatedTransactionArtifact -Path (Join-Path $Transaction.Directory "build-info.txt") -Name "BUILD-INFO stage" -Expected $Transaction.DesiredBuildInfo
  Remove-AuthenticatedTransactionArtifact -Path (Join-Path $Transaction.Directory "previous-target.exe") -Name "Displaced target" -Expected $Transaction.Data.previousTarget -Executable
  Remove-AuthenticatedTransactionArtifact -Path (Join-Path $Transaction.Directory "previous-backup.exe") -Name "Displaced backup" -Expected $Transaction.Data.previousBackup -Executable
  Remove-AuthenticatedTransactionArtifact -Path (Join-Path $Transaction.Directory "previous-launcher.cmd") -Name "Displaced launcher" -Expected $Transaction.Data.previousLauncher
  Remove-AuthenticatedTransactionArtifact -Path (Join-Path $Transaction.Directory "previous-build-info.txt") -Name "Displaced BUILD-INFO" -Expected $Transaction.Data.previousBuildInfo
  $null = Assert-FileState -Path $Transaction.ManifestPath -Name "Deployment transaction manifest" -Expected $Transaction.ManifestState
  [IO.File]::Delete($Transaction.ManifestPath)
  [IO.Directory]::Delete($Transaction.Directory, $false)
}

function Complete-DeploymentTransaction {
  param(
    [Parameter(Mandatory = $true)]$Transaction,
    [Parameter(Mandatory = $true)][string]$Deployment,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$Backup,
    [Parameter(Mandatory = $true)][string]$Launcher,
    [Parameter(Mandatory = $true)][string]$BuildInfo
  )
  Assert-NoUnknownTransactionArtifacts -Transaction $Transaction
  Install-TransactionFile -Transaction $Transaction -StageName "launcher.cmd" -Target $Launcher -Name "Launcher" -Previous $Transaction.Data.previousLauncher -Desired $Transaction.DesiredLauncher -DisplacedName "previous-launcher.cmd"
  Invoke-DeploymentCrashPoint -Name "launcher-installed"
  Install-TransactionFile -Transaction $Transaction -StageName "backup.exe" -Target $Backup -Name "Rollback executable" -Previous $Transaction.Data.previousBackup -Desired $Transaction.Data.desiredBackup -DisplacedName "previous-backup.exe" -Executable
  Invoke-DeploymentCrashPoint -Name "backup-installed"
  Install-TransactionFile -Transaction $Transaction -StageName "candidate.exe" -Target $Target -Name "Deployed executable" -Previous $Transaction.Data.previousTarget -Desired $Transaction.DesiredTarget -DisplacedName "previous-target.exe" -Executable -StopExactTarget
  Invoke-DeploymentCrashPoint -Name "target-installed"
  Install-TransactionFile -Transaction $Transaction -StageName "build-info.txt" -Target $BuildInfo -Name "BUILD-INFO" -Previous $Transaction.Data.previousBuildInfo -Desired $Transaction.DesiredBuildInfo -DisplacedName "previous-build-info.txt"
  Invoke-DeploymentCrashPoint -Name "build-info-installed"
  Assert-CompletedTransaction -Transaction $Transaction -Target $Target -Backup $Backup -Launcher $Launcher -BuildInfo $BuildInfo
  Assert-NoUnknownTransactionArtifacts -Transaction $Transaction
  $committed = Join-Path $Deployment ".opencode-deploy.committed-$($Transaction.Data.transactionId)"
  if (Test-Path -LiteralPath $committed) { throw "Committed deployment transaction path already exists" }
  Invoke-AtomicDirectoryMove -Source $Transaction.Directory -Destination $committed
  $Transaction = Read-DeploymentTransaction -Directory $committed -Deployment $Deployment
  Invoke-DeploymentCrashPoint -Name "transaction-committed"
  Remove-CompletedTransaction -Transaction $Transaction
}

function Recover-DeploymentTransactions {
  param(
    [Parameter(Mandatory = $true)][string]$Deployment,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$Backup,
    [Parameter(Mandatory = $true)][string]$Launcher,
    [Parameter(Mandatory = $true)][string]$BuildInfo
  )
  $active = Join-Path $Deployment ".opencode-deploy.transaction"
  $pending = @(Get-ChildItem -LiteralPath $Deployment -Directory -Filter ".opencode-deploy.pending-*" -Force)
  if ($pending.Count -gt 1 -or ($pending.Count -eq 1 -and (Test-Path -LiteralPath $active))) {
    throw "Deployment contains ambiguous pending transaction state"
  }
  if ($pending.Count -eq 1) {
    if ($pending[0].Name -cnotmatch '^\.opencode-deploy\.pending-[a-f0-9]{32}$') {
      throw "Unknown deployment artifact resembles a pending transaction: $($pending[0].Name)"
    }
    $transaction = Read-DeploymentTransaction -Directory $pending[0].FullName -Deployment $Deployment
    if ($pending[0].Name -cne ".opencode-deploy.pending-$($transaction.Data.transactionId)") {
      throw "Pending deployment transaction identity does not match its directory"
    }
    Invoke-AtomicDirectoryMove -Source $pending[0].FullName -Destination $active
    $transaction = Read-DeploymentTransaction -Directory $active -Deployment $Deployment
    Complete-DeploymentTransaction -Transaction $transaction -Deployment $Deployment -Target $Target -Backup $Backup -Launcher $Launcher -BuildInfo $BuildInfo
  }
  if (Test-Path -LiteralPath $active) {
    if (-not (Test-Path -LiteralPath $active -PathType Container)) { throw "Active deployment transaction is not a directory" }
    $transaction = Read-DeploymentTransaction -Directory $active -Deployment $Deployment
    Complete-DeploymentTransaction -Transaction $transaction -Deployment $Deployment -Target $Target -Backup $Backup -Launcher $Launcher -BuildInfo $BuildInfo
  }
  foreach ($entry in @(Get-ChildItem -LiteralPath $Deployment -Directory -Filter ".opencode-deploy.committed-*" -Force)) {
    if ($entry.Name -cnotmatch '^\.opencode-deploy\.committed-[a-f0-9]{32}$') {
      throw "Unknown deployment artifact resembles a committed transaction: $($entry.Name)"
    }
    $transaction = Read-DeploymentTransaction -Directory $entry.FullName -Deployment $Deployment
    if ($entry.Name -cne ".opencode-deploy.committed-$($transaction.Data.transactionId)") {
      throw "Committed deployment transaction identity does not match its directory"
    }
    Assert-CompletedTransaction -Transaction $transaction -Target $Target -Backup $Backup -Launcher $Launcher -BuildInfo $BuildInfo
    Remove-CompletedTransaction -Transaction $transaction
  }
}

function New-DeploymentTransaction {
  param(
    [Parameter(Mandatory = $true)][string]$Deployment,
    [Parameter(Mandatory = $true)][string]$Action,
    [Parameter(Mandatory = $true)][string]$Candidate,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$Backup,
    [Parameter(Mandatory = $true)]$PreviousTarget,
    [Parameter(Mandatory = $true)]$PreviousBackup,
    [Parameter(Mandatory = $true)]$PreviousLauncher,
    [Parameter(Mandatory = $true)]$PreviousBuildInfo,
    [Parameter(Mandatory = $true)]$DesiredBackup,
    [Parameter(Mandatory = $true)][string]$LauncherText,
    [Parameter(Mandatory = $true)][string]$BuildInfoText,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$CandidateHash
  )
  $id = [Guid]::NewGuid().ToString("N")
  $pending = Join-Path $Deployment ".opencode-deploy.pending-$id"
  $active = Join-Path $Deployment ".opencode-deploy.transaction"
  if (Test-Path -LiteralPath $active) { throw "An active deployment transaction already exists" }
  [IO.Directory]::CreateDirectory($pending) | Out-Null
  $pending = Resolve-CanonicalDDirectory -Value $pending -Name "Pending deployment transaction"
  $candidateStage = Join-Path $pending "candidate.exe"
  Write-FlushedCopy -Source $Candidate -Destination $candidateStage
  $desiredTarget = [PSCustomObject]@{ Present = $true; Hash = $CandidateHash; Version = $Version }
  $null = Assert-FileState -Path $candidateStage -Name "Candidate stage" -Expected $desiredTarget -Executable
  if ($DesiredBackup.Present) {
    $backupSource = if (Test-FileStateEqual -Left $DesiredBackup -Right $PreviousTarget) {
      $Target
    } else {
      $Backup
    }
    Write-FlushedCopy -Source $backupSource -Destination (Join-Path $pending "backup.exe")
    $null = Assert-FileState -Path (Join-Path $pending "backup.exe") -Name "Backup stage" -Expected $DesiredBackup -Executable
  }
  Write-FlushedText -Path (Join-Path $pending "launcher.cmd") -Text $LauncherText
  Write-FlushedText -Path (Join-Path $pending "build-info.txt") -Text $BuildInfoText
  $desiredLauncherHash = Get-TextHash -Text $LauncherText
  $desiredBuildInfoHash = Get-TextHash -Text $BuildInfoText
  $manifest = [ordered]@{
    schema = 1
    transactionId = $id
    deploymentRoot = $Deployment
    action = $Action
    version = $Version
    candidateHash = $CandidateHash
    previousTarget = $PreviousTarget
    previousBackup = $PreviousBackup
    previousLauncher = $PreviousLauncher
    previousBuildInfo = $PreviousBuildInfo
    desiredBackup = $DesiredBackup
    desiredLauncherHash = $desiredLauncherHash
    desiredBuildInfoHash = $desiredBuildInfoHash
  }
  Write-FlushedText -Path (Join-Path $pending "manifest.json") -Text (($manifest | ConvertTo-Json -Depth 6 -Compress) + "`n")
  Invoke-DeploymentCrashPoint -Name "transaction-staged"
  Invoke-AtomicDirectoryMove -Source $pending -Destination $active
  $transaction = Read-DeploymentTransaction -Directory $active -Deployment $Deployment
  Invoke-DeploymentCrashPoint -Name "transaction-published"
  return $transaction
}

if ($PrepareHostOnly -and $Rollback) {
  throw "PrepareHostOnly and Rollback cannot be combined"
}
$prospectiveDeployment = Resolve-ProspectiveCanonicalDDirectory -Value $DeploymentRoot -Name "DeploymentRoot"
if ($PrepareHostOnly) {
  $deployment = Resolve-OrCreateCanonicalDDirectory -Value $prospectiveDeployment -Name "DeploymentRoot"
  $null = Set-ProtectedAcl -Path $deployment
  $null = Ensure-ManagedDirectory -Root $deployment -Relative "bin"
  foreach ($entry in $managedLeaves.GetEnumerator()) {
    $root = Ensure-ManagedDirectory -Root $deployment -Relative $entry.Value
    $null = Set-ProtectedAcl -Path $root
  }
  foreach ($relative in @(
      "data",
      "config",
      "cache",
      "state",
      "tmp\process",
      "cache\bun",
      "cache\npm",
      "cache\pnpm",
      "cache\yarn"
    )) {
    $null = Ensure-ManagedDirectory -Root $deployment -Relative $relative
  }
  $sandboxRuntimeRoot = Ensure-ManagedDirectory -Root $deployment -Relative "runtime\sandbox"
  $null = Set-ProtectedAcl -Path $sandboxRuntimeRoot
  Write-Output "Prepared workflow production host roots beneath $deployment"
  exit 0
}

Assert-SafeLiteral -Value $Version -Name "Version"
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z .,_+()/=-]{0,127}$') { throw "Version has an unsupported shape" }
$source = Resolve-CanonicalDDirectory -Value $SourceRoot -Name "SourceRoot"
if ((Test-PathContained -Parent $source -Child $prospectiveDeployment) -or (Test-PathContained -Parent $prospectiveDeployment -Child $source)) {
  throw "SourceRoot and DeploymentRoot must not overlap"
}

$deployment = Resolve-CanonicalDDirectory -Value $prospectiveDeployment -Name "DeploymentRoot"
$bin = Resolve-ExistingManagedDirectory -Root $deployment -Relative "bin" -Name "Deployment bin root"
$target = Join-Path $bin "opencode-local.exe"
$backup = Join-Path $bin "opencode-local.bak.exe"
$launcher = Join-Path $bin "opencode.cmd"
$buildInfoPath = Join-Path $deployment "BUILD-INFO.txt"

$roots = [ordered]@{}
foreach ($entry in $managedLeaves.GetEnumerator()) {
  $roots[$entry.Key] = Resolve-ExistingManagedDirectory -Root $deployment -Relative $entry.Value -Name "Managed $($entry.Key) root"
}
$childDataRoot = Resolve-ExistingManagedDirectory -Root $deployment -Relative "data" -Name "Child data root"
$childConfigRoot = Resolve-ExistingManagedDirectory -Root $deployment -Relative "config" -Name "Child config root"
$childCacheRoot = Resolve-ExistingManagedDirectory -Root $deployment -Relative "cache" -Name "Child cache root"
$childStateRoot = Resolve-ExistingManagedDirectory -Root $deployment -Relative "state" -Name "Child state root"
$childTempRoot = Resolve-ExistingManagedDirectory -Root $deployment -Relative "tmp\process" -Name "Child temp root"
$bunCacheRoot = Resolve-ExistingManagedDirectory -Root $deployment -Relative "cache\bun" -Name "Bun cache root"
$npmCacheRoot = Resolve-ExistingManagedDirectory -Root $deployment -Relative "cache\npm" -Name "npm cache root"
$pnpmRoot = Resolve-ExistingManagedDirectory -Root $deployment -Relative "cache\pnpm" -Name "pnpm cache root"
$yarnCacheRoot = Resolve-ExistingManagedDirectory -Root $deployment -Relative "cache\yarn" -Name "Yarn cache root"
$sandboxRuntimeRoot = Resolve-ExistingManagedDirectory -Root $deployment -Relative "runtime\sandbox" -Name "Sandbox release root"
Assert-DeploymentAclBoundary -Deployment $deployment -Roots $roots -SandboxRuntimeRoot $sandboxRuntimeRoot

$releaseBun = Resolve-CanonicalDFile -Value $fixedBunPath -Name "Pinned Bun runtime"
$releaseGit = Resolve-CanonicalFixedFile -Value $fixedGitPath -Name "Fixed Git client"
$releaseTar = Resolve-CanonicalFixedFile -Value $systemTarPath -Name "Fixed Windows tar reader" -AllowHardLink
$childEnvironment = [ordered]@{
  PATH = "$(Split-Path -Parent $releaseBun);$(Split-Path -Parent $releaseGit);C:\Windows\System32;C:\Windows"
  TEMP = $childTempRoot
  TMP = $childTempRoot
  TMPDIR = $childTempRoot
  BUN_INSTALL = Split-Path -Parent $releaseBun
  BUN_INSTALL_CACHE_DIR = $bunCacheRoot
  npm_config_cache = $npmCacheRoot
  PNPM_HOME = $pnpmRoot
  YARN_CACHE_FOLDER = $yarnCacheRoot
  XDG_DATA_HOME = $childDataRoot
  XDG_CONFIG_HOME = $childConfigRoot
  XDG_CACHE_HOME = $childCacheRoot
  XDG_STATE_HOME = $childStateRoot
  DOCKER_CONFIG = $roots.DockerConfig
  PLAYWRIGHT_BROWSERS_PATH = $roots.BrowserRuntime
  GIT_CONFIG_GLOBAL = "NUL"
  GIT_CONFIG_SYSTEM = "NUL"
  GIT_CONFIG_NOSYSTEM = "1"
  GIT_CONFIG_COUNT = "0"
  GIT_OPTIONAL_LOCKS = "0"
  GIT_TERMINAL_PROMPT = "0"
  GIT_DIR = $null
  GIT_WORK_TREE = $null
  GIT_INDEX_FILE = $null
  GIT_OBJECT_DIRECTORY = $null
  GIT_ALTERNATE_OBJECT_DIRECTORIES = $null
  GIT_COMMON_DIR = $null
}
$savedChildEnvironment = Set-ScopedChildEnvironment -Values $childEnvironment
try {
$sourceCommitOutput = @(& $releaseGit -C $source rev-parse HEAD 2>$null)
$sourceCommitExit = $LASTEXITCODE
$sourceCommit = if ($sourceCommitOutput.Count -eq 1) { ([string]$sourceCommitOutput[0]).Trim() } else { "" }
if ($sourceCommitExit -ne 0 -or $sourceCommit -notmatch '^(?:[a-f0-9]{40}|[a-f0-9]{64})$') {
  throw "SourceRoot has no exact Git commit"
}
& $releaseGit -C $source diff --quiet HEAD --
if ($LASTEXITCODE -ne 0) { throw "SourceRoot contains uncommitted tracked changes" }
& $releaseGit -C $source diff --cached --quiet
if ($LASTEXITCODE -ne 0) { throw "SourceRoot index contains uncommitted changes" }
$sourceBranchOutput = @(& $releaseGit -C $source branch --show-current)
$sourceBranchExit = $LASTEXITCODE
$sourceBranch = if ($sourceBranchOutput.Count -eq 1) { ([string]$sourceBranchOutput[0]).Trim() } else { "" }
if ($sourceBranchExit -ne 0 -or [string]::IsNullOrWhiteSpace($sourceBranch)) { $sourceBranch = "detached" }
$sourceRemoteNames = @(& $releaseGit -C $source remote)
if ($LASTEXITCODE -ne 0) { throw "SourceRoot remotes could not be inspected" }
if ($sourceRemoteNames -contains "origin") {
  $sourceRemoteOutput = @(& $releaseGit -C $source remote get-url origin)
  if ($LASTEXITCODE -ne 0 -or $sourceRemoteOutput.Count -ne 1) { throw "SourceRoot origin is invalid" }
  $sourceRemote = ([string]$sourceRemoteOutput[0]).Trim()
} else {
  $sourceRemote = "none"
}
foreach ($metadata in @($sourceBranch, $sourceRemote)) {
  if ([string]::IsNullOrWhiteSpace($metadata) -or $metadata -match '[\x00-\x1f\x7f]') {
    throw "Source metadata cannot be represented safely"
  }
}
$sandbox = Read-ExactSandboxManifest -Root $deployment -SourceRoot $source
& $releaseGit -C $source diff --quiet HEAD --
if ($LASTEXITCODE -ne 0) { throw "SourceRoot changed while sandbox release evidence was inspected" }
$reviewedDockerfileAfter = Resolve-CanonicalDFile -Value (Join-Path $source $sandboxDockerfileRelative) -Name "Reviewed sandbox Dockerfile"
$reviewedSupervisorAfter = Resolve-CanonicalDFile -Value (Join-Path $source $sandboxSupervisorRelative) -Name "Reviewed sandbox supervisor"
if (
  (Get-FileHash -LiteralPath $reviewedDockerfileAfter -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sandbox.DockerfileSha256 -or
  (Get-FileHash -LiteralPath $reviewedSupervisorAfter -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sandbox.SupervisorSha256
) {
  throw "Reviewed sandbox sources changed while release evidence was inspected"
}

$sourceCommitAfter = @(& $releaseGit -C $source rev-parse HEAD 2>$null)
if (
  $LASTEXITCODE -ne 0 -or
  $sourceCommitAfter.Count -ne 1 -or
  ([string]$sourceCommitAfter[0]).Trim() -cne $sourceCommit
) {
  throw "SourceRoot commit changed while deployment was being validated"
}
if ($Rollback) {
  $preflightCandidate = Resolve-CanonicalDFile -Value $backup -Name "Rollback candidate"
} else {
  $preflightCandidate = Resolve-CanonicalDFile -Value (Join-Path $source $sourceBinaryRelative) -Name "Source binary"
  if (-not (Test-PathContained -Parent $source -Child $preflightCandidate -Strict)) {
    throw "Source binary escaped SourceRoot"
  }
}
$preflightCandidateState = Get-ManagedFileState -Path $preflightCandidate -Name "Candidate executable" -Executable
if (-not $preflightCandidateState.Present -or $preflightCandidateState.Version -cne $Version) {
  throw "Candidate executable version does not match -Version"
}

if ((Resolve-CanonicalDDirectory -Value $deployment -Name "DeploymentRoot") -cne $deployment) {
  throw "DeploymentRoot changed after preflight"
}
if ((Resolve-ExistingManagedDirectory -Root $deployment -Relative "bin" -Name "Deployment bin root") -cne $bin) {
  throw "Deployment bin root changed after preflight"
}
foreach ($entry in $managedLeaves.GetEnumerator()) {
  $confirmed = Resolve-ExistingManagedDirectory -Root $deployment -Relative $entry.Value -Name "Managed $($entry.Key) root"
  if ($confirmed -cne $roots[$entry.Key]) { throw "Managed $($entry.Key) root changed after preflight" }
}
foreach ($entry in @(
    [PSCustomObject]@{ Relative = "data"; Expected = $childDataRoot; Name = "Child data root" },
    [PSCustomObject]@{ Relative = "config"; Expected = $childConfigRoot; Name = "Child config root" },
    [PSCustomObject]@{ Relative = "cache"; Expected = $childCacheRoot; Name = "Child cache root" },
    [PSCustomObject]@{ Relative = "state"; Expected = $childStateRoot; Name = "Child state root" },
    [PSCustomObject]@{ Relative = "tmp\process"; Expected = $childTempRoot; Name = "Child temp root" },
    [PSCustomObject]@{ Relative = "cache\bun"; Expected = $bunCacheRoot; Name = "Bun cache root" },
    [PSCustomObject]@{ Relative = "cache\npm"; Expected = $npmCacheRoot; Name = "npm cache root" },
    [PSCustomObject]@{ Relative = "cache\pnpm"; Expected = $pnpmRoot; Name = "pnpm cache root" },
    [PSCustomObject]@{ Relative = "cache\yarn"; Expected = $yarnCacheRoot; Name = "Yarn cache root" },
    [PSCustomObject]@{ Relative = "runtime\sandbox"; Expected = $sandboxRuntimeRoot; Name = "Sandbox release root" }
  )) {
  $confirmed = Resolve-ExistingManagedDirectory -Root $deployment -Relative $entry.Relative -Name $entry.Name
  if ($confirmed -cne $entry.Expected) { throw "$($entry.Name) changed after preflight" }
}

Assert-DeploymentAclBoundary -Deployment $deployment -Roots $roots -SandboxRuntimeRoot $sandboxRuntimeRoot

Recover-DeploymentTransactions -Deployment $deployment -Target $target -Backup $backup -Launcher $launcher -BuildInfo $buildInfoPath
Assert-DeploymentAclBoundary -Deployment $deployment -Roots $roots -SandboxRuntimeRoot $sandboxRuntimeRoot
$confirmedSandbox = Read-ExactSandboxManifest -Root $deployment -SourceRoot $source
foreach ($name in @(
    "Archive",
    "ArchiveSha256",
    "Base",
    "DockerfileSha256",
    "Engine",
    "EngineSha256",
    "Image",
    "Registry",
    "SupervisorSha256"
  )) {
  if ([string]$confirmedSandbox.$name -cne [string]$sandbox.$name) {
    throw "Sandbox release evidence changed after deployment preflight"
  }
}
$sandbox = $confirmedSandbox
& $releaseGit -C $source diff --quiet HEAD --
if ($LASTEXITCODE -ne 0) { throw "SourceRoot changed after deployment preflight" }
$sourceCommitConfirmed = @(& $releaseGit -C $source rev-parse HEAD 2>$null)
if (
  $LASTEXITCODE -ne 0 -or
  $sourceCommitConfirmed.Count -ne 1 -or
  ([string]$sourceCommitConfirmed[0]).Trim() -cne $sourceCommit
) {
  throw "SourceRoot commit changed after deployment preflight"
}

$currentTarget = Get-ManagedFileState -Path $target -Name "Deployed executable" -Executable
$currentBackup = Get-ManagedFileState -Path $backup -Name "Rollback executable" -Executable
$currentLauncher = Get-ManagedFileState -Path $launcher -Name "Launcher"
$currentBuildInfo = Get-ManagedFileState -Path $buildInfoPath -Name "BUILD-INFO"
$existingBuildInfo = Read-AuthenticatedBuildInfo -Path $buildInfoPath
if ($currentTarget.Present) {
  if ($null -eq $existingBuildInfo) { throw "Existing deployed executable has no authenticated BUILD-INFO" }
  if ($currentTarget.Version -cne $existingBuildInfo.BuildVersion -or $currentTarget.Hash -cne $existingBuildInfo.BinaryHash) {
    throw "Deployed executable does not match BUILD-INFO"
  }
  if ($existingBuildInfo.RollbackHash -ceq "none") {
    if ($currentBackup.Present) { throw "Unexpected rollback executable has no BUILD-INFO authority" }
  } elseif (-not $currentBackup.Present -or $currentBackup.Version -cne $existingBuildInfo.RollbackVersion -or $currentBackup.Hash -cne $existingBuildInfo.RollbackHash) {
    throw "Existing rollback executable does not match BUILD-INFO"
  }
} elseif ($currentBuildInfo.Present -or $currentBackup.Present) {
  throw "Deployment metadata or rollback exists without a current executable"
}

if ($Rollback) {
  if ($null -eq $existingBuildInfo -or $existingBuildInfo.Legacy -or -not $currentBackup.Present) {
    throw "Rollback requires an authenticated current/backup pair"
  }
  $candidate = $backup
  $action = "rollback"
} else {
  $candidate = Resolve-CanonicalDFile -Value (Join-Path $source $sourceBinaryRelative) -Name "Source binary"
  if (-not (Test-PathContained -Parent $source -Child $candidate -Strict)) { throw "Source binary escaped SourceRoot" }
  $action = "deploy"
}
$candidateState = Get-ManagedFileState -Path $candidate -Name "Candidate executable" -Executable
if (-not $candidateState.Present -or $candidateState.Version -cne $Version) {
  throw "Candidate executable version does not match -Version"
}
if ($candidate -cne $preflightCandidate -or -not (Test-FileStateEqual -Left $candidateState -Right $preflightCandidateState)) {
  throw "Candidate executable changed after deployment preflight"
}
$binaryChange = -not (Test-FileStateEqual -Left $candidateState -Right $currentTarget)
$desiredBackup = if ($binaryChange -and $currentTarget.Present) { $currentTarget } else { $currentBackup }

$environmentFile = Join-Path $source "packages\llm\.env.local"
Assert-SafeLiteral -Value $environmentFile -Name "Environment file path"
$launcherText = @"
@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "OPENCODE_ROOT=$deployment"
if exist "%OPENCODE_ROOT%\.opencode-deploy.transaction" (
  >&2 echo OpenCode deployment recovery is required before launch.
  exit /b 74
)
set "OPENCODE_CONFIG_DIR=%OPENCODE_ROOT%\config"
set "OPENCODE_DB=%OPENCODE_ROOT%\data\opencode.sqlite"
set "OPENCODE_DISABLE_AUTOUPDATE=1"
set "XDG_DATA_HOME=%OPENCODE_ROOT%\data"
set "XDG_CONFIG_HOME=%OPENCODE_ROOT%\config"
set "XDG_CACHE_HOME=%OPENCODE_ROOT%\cache"
set "XDG_STATE_HOME=%OPENCODE_ROOT%\state"
set "TEMP=%OPENCODE_ROOT%\tmp\process"
set "TMP=%OPENCODE_ROOT%\tmp\process"
set "BUN_INSTALL_CACHE_DIR=%OPENCODE_ROOT%\cache\bun"
set "npm_config_cache=%OPENCODE_ROOT%\cache\npm"
set "PNPM_HOME=%OPENCODE_ROOT%\cache\pnpm"
set "YARN_CACHE_FOLDER=%OPENCODE_ROOT%\cache\yarn"
set "OPENCODE_WORKFLOW_HOST_ROOT=$deployment"
set "OPENCODE_WORKFLOW_HOST_DATA=$($roots.Data)"
set "OPENCODE_WORKFLOW_HOST_RUNTIME=$($roots.BrowserRuntime)"
set "OPENCODE_WORKFLOW_HOST_CACHE=$($roots.BrowserCache)"
set "OPENCODE_WORKFLOW_HOST_TEMP=$($roots.PreviewCapability)"
set "OPENCODE_WORKFLOW_EVIDENCE_ROOT=$($roots.Data)"
set "PLAYWRIGHT_BROWSERS_PATH=$($roots.BrowserRuntime)"
set "OPENCODE_WORKFLOW_SANDBOX_ENGINE=$($sandbox.Engine)"
set "OPENCODE_WORKFLOW_SANDBOX_IMAGE=$($sandbox.Image)"
set "OPENCODE_WORKFLOW_SANDBOX_CONFIG=$($roots.DockerConfig)"
set "OPENCODE_WORKFLOW_SANDBOX_TEMP=$($roots.DockerTemp)"

set "OPENCODE_ENV_FILE=$environmentFile"
if exist "%OPENCODE_ENV_FILE%" for /f "usebackq tokens=1,* delims==" %%A in (`findstr /b /c:"DEEPSEEK_API_KEY=" /c:"MOONSHOT_API_KEY=" "%OPENCODE_ENV_FILE%"`) do set "%%A=%%B"

"%OPENCODE_ROOT%\bin\opencode-local.exe" %*
exit /b %ERRORLEVEL%
"@
$launcherText = $launcherText.TrimStart() + "`r`n"
$rollbackVersionText = if ($desiredBackup.Present) { [string]$desiredBackup.Version } else { "none" }
$rollbackHashText = if ($desiredBackup.Present) { [string]$desiredBackup.Hash } else { "none" }
$buildInfoText = @(
  "Source commit: $sourceCommit",
  "Source branch: $sourceBranch",
  "Remote: $sourceRemote",
  "Build target: opencode-windows-x64",
  "Build version: $Version",
  "Binary SHA256: $($candidateState.Hash)",
  "Rollback version: $rollbackVersionText",
  "Rollback SHA256: $rollbackHashText",
  "Sandbox image: $($sandbox.Image)",
  "Sandbox archive: $($sandbox.Archive)",
  "Sandbox archive SHA256: $($sandbox.ArchiveSha256)",
  "Sandbox base: $($sandbox.Base)",
  "Sandbox registry: $($sandbox.Registry)",
  "Sandbox Dockerfile SHA256: $($sandbox.DockerfileSha256)",
  "Sandbox supervisor SHA256: $($sandbox.SupervisorSha256)",
  "Sandbox engine: $($sandbox.Engine)",
  "Sandbox engine SHA256: $($sandbox.EngineSha256)",
  "Deployment root: $deployment"
) -join "`r`n"
$buildInfoText += "`r`n"

Assert-DeploymentAclBoundary -Deployment $deployment -Roots $roots -SandboxRuntimeRoot $sandboxRuntimeRoot
if (-not $binaryChange -and $null -ne $existingBuildInfo -and -not $existingBuildInfo.Legacy -and $currentLauncher.Present -and $currentLauncher.Hash -ceq (Get-TextHash -Text $launcherText)) {
  Write-Output "Deployment already contains $target version $Version ($($candidateState.Hash))"
  exit 0
}

$transaction = New-DeploymentTransaction -Deployment $deployment -Action $action -Candidate $candidate -Target $target -Backup $backup -PreviousTarget $currentTarget -PreviousBackup $currentBackup -PreviousLauncher $currentLauncher -PreviousBuildInfo $currentBuildInfo -DesiredBackup $desiredBackup -LauncherText $launcherText -BuildInfoText $buildInfoText -Version $Version -CandidateHash $candidateState.Hash
Assert-DeploymentAclBoundary -Deployment $deployment -Roots $roots -SandboxRuntimeRoot $sandboxRuntimeRoot
Complete-DeploymentTransaction -Transaction $transaction -Deployment $deployment -Target $target -Backup $backup -Launcher $launcher -BuildInfo $buildInfoPath

Write-Output "Deployed $target version $Version ($($candidateState.Hash))"
} finally {
  Restore-ScopedChildEnvironment -Values $savedChildEnvironment
}
