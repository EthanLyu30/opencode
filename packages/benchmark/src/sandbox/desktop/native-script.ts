/** Metadata only: no distro execution, daemon API, helper reconfiguration or disk content reads. */
export function desktopNativeQueryScript() {
  return String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$sid=$identity.User.Value
$profileKey=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\'+$sid)
if(!$profileKey){throw 'profile unavailable'}
try {$windowsProfile=[string]$profileKey.GetValue('ProfileImagePath')} finally {$profileKey.Dispose()}
if($windowsProfile.Contains('%')){throw 'unexpanded profile'}
$root=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Lxss')
if(!$root){throw 'registration unavailable'}
$names=@();$registration=$null
try {
 foreach($keyName in $root.GetSubKeyNames()) {
  $key=$root.OpenSubKey($keyName)
  if(!$key){throw 'partial registry'}
  try {
   $name=[string]$key.GetValue('DistributionName')
   if(!$name){throw 'partial registration'}
   $names+= $name
   if($name -ceq 'docker-desktop') {
    if($null -ne $registration){throw 'duplicate main registration'}
    $base=[string]$key.GetValue('BasePath')
    if($base.StartsWith('\\?\')){$base=$base.Substring(4)}
    $registration=@{key=$keyName;distributionName=$name;basePath=$base;version=[int]$key.GetValue('Version');build=[int]$key.GetValue('DockerDesktopBuildNumber')}
   }
  } finally {$key.Dispose()}
 }
} finally {$root.Dispose()}
if($null -eq $registration){throw 'main registration absent'}
$rows=@(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'Docker Desktop.exe' OR Name LIKE 'com.docker.%' OR Name LIKE 'vmmem%' OR Name = 'wslhost.exe'")
if($rows.Count -gt 256){throw 'process limit'}
$processes=@()
foreach($row in $rows) {
 $proc=Get-Process -Id $row.ProcessId -ErrorAction Stop
 $created=$proc.StartTime.ToUniversalTime()
 if([Math]::Abs(($created-$row.CreationDate.ToUniversalTime()).TotalMilliseconds) -ge 1){throw 'process changed'}
 $owner=Invoke-CimMethod -InputObject $row -MethodName GetOwnerSid
 if($owner.ReturnValue -ne 0 -or !$owner.Sid -or !$row.ExecutablePath){throw 'process identity unavailable'}
 $role='backend'
 if($row.Name -eq 'Docker Desktop.exe'){$role='desktop'}
 if($row.Name -eq 'com.docker.service' -or $row.Name -eq 'com.docker.service.exe'){$role='service'}
 if($row.Name -like 'vmmem*' -or $row.Name -eq 'wslhost.exe'){$role='vm'}
 $after=Get-Process -Id $row.ProcessId -ErrorAction Stop
 if($after.StartTime.ToUniversalTime().Ticks -ne $created.Ticks){throw 'process reused'}
 $processes+=@{pid=[int]$row.ProcessId;parentPID=[int]$row.ParentProcessId;createdAt=([DateTimeOffset]$created).ToUnixTimeMilliseconds();ownerSID=[string]$owner.Sid;imagePath=[string]$row.ExecutablePath;role=$role}
}
$pipeNames=@('home-oc-task24-dd479dockerDesktopEngine','dockerDesktopEngine','docker_engine')
$existing=@([IO.Directory]::GetFiles('\\.\pipe\'))
$pipes=@()
foreach($pipeName in $pipeNames){$pipes+=@{endpoint='npipe:////./pipe/'+$pipeName;present=($existing -contains ('\\.\pipe\'+$pipeName))}}
if([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $sid){throw 'identity changed'}
@{schemaVersion=1;complete=$true;sampledAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();sid=$sid;profileSID=$sid;windowsProfile=$windowsProfile;registration=$registration;processes=@($processes);pipes=@($pipes);installedWsl=@($names|Sort-Object);runningWsl=@()}|ConvertTo-Json -Depth 8 -Compress
`
}
