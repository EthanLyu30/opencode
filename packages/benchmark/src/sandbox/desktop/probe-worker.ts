import { sha256Text } from "../../hash"
/** Fixed hidden supervisor. JOB_LIST assigns the suspended child atomically; no PID-tree guessing or global kill. */
const preamble = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$p=[Console]::ReadLine()|ConvertFrom-Json
`
export const desktopProbeBootstrap = String.raw`
# Bootstrap in-memory P/Invoke before Add-Type can create a compiler child. The supervisor's own
# unnamed kill-on-close job contains that compiler as well as the later atomically assigned worker.
if([IntPtr]::Size -ne 8){exit 249}
$assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('Task24ProbeBootstrap'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$builder=$assembly.DefineDynamicModule('m').DefineType('Task24ProbeBootstrap',[Reflection.TypeAttributes]'Public,Sealed,Abstract')
$methods=@(
 @{name='CreateJobObjectW';result=[IntPtr];args=[Type[]]@([IntPtr],[IntPtr])},
 @{name='SetInformationJobObject';result=[bool];args=[Type[]]@([IntPtr],[int],[IntPtr],[uint32])},
 @{name='AssignProcessToJobObject';result=[bool];args=[Type[]]@([IntPtr],[IntPtr])},
 @{name='GetCurrentProcess';result=[IntPtr];args=[Type[]]@()},
 @{name='CloseHandle';result=[bool];args=[Type[]]@([IntPtr])},
 @{name='CreateFileW';result=[IntPtr];args=[Type[]]@([string],[uint32],[uint32],[IntPtr],[uint32],[uint32],[IntPtr])},
 @{name='GetFileInformationByHandle';result=[bool];args=[Type[]]@([IntPtr],[IntPtr])},
 @{name='GetFinalPathNameByHandleW';result=[uint32];args=[Type[]]@([IntPtr],[Text.StringBuilder],[uint32],[uint32])}
)
foreach($m in $methods){
 $method=$builder.DefinePInvokeMethod($m.name,'kernel32.dll',[Reflection.MethodAttributes]'Public,Static',[Reflection.CallingConventions]::Standard,$m.result,$m.args,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
 $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
}
$bootstrap=$builder.CreateType()
$bootstrapJob=$bootstrap::CreateJobObjectW([IntPtr]::Zero,[IntPtr]::Zero)
if($bootstrapJob -eq [IntPtr]::Zero){exit 249}
$limits=[Runtime.InteropServices.Marshal]::AllocHGlobal(144)
try {
 [Runtime.InteropServices.Marshal]::Copy([byte[]]::new(144),0,$limits,144)
 [Runtime.InteropServices.Marshal]::WriteInt32($limits,16,0x2000)
 if(!$bootstrap::SetInformationJobObject($bootstrapJob,9,$limits,144)){[void]$bootstrap::CloseHandle($bootstrapJob);exit 249}
 if(!$bootstrap::AssignProcessToJobObject($bootstrapJob,$bootstrap::GetCurrentProcess())){[void]$bootstrap::CloseHandle($bootstrapJob);exit 249}
} finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($limits)}
# Do not explicitly close this self-containing job while executing: OS process teardown closes
# the non-inheritable handle, reclaiming descendants even on forced supervisor cancellation.
$pins=[Collections.Generic.List[IntPtr]]::new()
$info=[Runtime.InteropServices.Marshal]::AllocHGlobal(52)
function Get-U32([int]$offset){[uint64]([int64][Runtime.InteropServices.Marshal]::ReadInt32($info,$offset) -band 0xffffffffL)}
function Pin-RootPath([string]$value,[bool]$directory){
 $flags=if($directory){0x02200000}else{0x00200000}
 $access=if($directory){0x1000A0}else{0x100081}
 $h=$bootstrap::CreateFileW($value,$access,1,[IntPtr]::Zero,3,$flags,[IntPtr]::Zero)
 if($h -eq [IntPtr]::Zero -or $h -eq [IntPtr]::new(-1)){exit 249}
 $pins.Add($h)
 if(!$bootstrap::GetFileInformationByHandle($h,$info)){exit 249}
 $attributes=Get-U32 0
 if(($attributes -band 0x400) -ne 0 -or (($attributes -band 0x10) -ne 0) -ne $directory){exit 249}
 $text=[Text.StringBuilder]::new(32768)
 $n=$bootstrap::GetFinalPathNameByHandleW($h,$text,32768,0)
 if($n -eq 0 -or $n -ge 32768 -or ![string]::Equals($text.ToString(),'\\?\'+$value,[StringComparison]::OrdinalIgnoreCase)){exit 249}
 return $h
}
try {
 $current=[IO.Path]::GetPathRoot([string]$p.cwd)
 [void](Pin-RootPath $current $true)
 foreach($part in ([string]$p.cwd).Substring($current.Length).Split('\')){$current=[IO.Path]::Combine($current,$part);[void](Pin-RootPath $current $true)}
 $expected=([string]$p.tempIdentity).Split(':')
 $index=(Get-U32 48) -bor ((Get-U32 44) -shl 32)
 if([string](Get-U32 28) -cne $expected[0] -or [string]$index -cne $expected[1]){exit 249}
 $owner=Pin-RootPath ([IO.Path]::Combine([string]$p.cwd,'owner.json')) $false
 if((Get-U32 40) -ne 1 -or (Get-U32 32) -ne 0 -or (Get-U32 36) -gt 4096){exit 249}
 $stream=[IO.FileStream]::new([Microsoft.Win32.SafeHandles.SafeFileHandle]::new($owner,$false),[IO.FileAccess]::Read)
 $hash=[Security.Cryptography.SHA256]::Create()
 try {$digest=[BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant()} finally {$stream.Dispose();$hash.Dispose()}
 if($digest -cne [string]$p.tempOwnerSha256){exit 249}
} finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($info)}
`
export const desktopProbeWorkerCode = String.raw`
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DesktopProbeWorker {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int Size; public IntPtr Security; public int Inherit; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI { public int Size; public IntPtr Reserved,Desktop,Title; public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags; public ushort Show,ReservedSize; public IntPtr ReservedPtr,In,Out,Err; }
  [StructLayout(LayoutKind.Sequential)] struct SX { public SI Info; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr Process,Thread; public uint PID,TID; }
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long ProcessTime,JobTime; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic Basic; public Counters IO; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes,CLo,CHi,ALo,AHi,WLo,WHi,Volume,SizeHi,SizeLo,Links,IndexHi,IndexLo; }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr sa,IntPtr name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int type,ref Limits value,uint size);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr j,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DuplicateHandle(IntPtr p,IntPtr h,IntPtr q,out IntPtr result,uint access,bool inherit,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref SA sa,uint size);
  [DllImport("kernel32.dll")] static extern bool SetHandleInformation(IntPtr h,uint mask,uint flags);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr p,int count,int flags,ref IntPtr size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr p,uint flags,IntPtr type,IntPtr value,IntPtr size,IntPtr old,IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr p);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcessW(string exe,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SX info,out PI process);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string name,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);
  [DllImport("kernel32.dll")] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder text,uint count,uint flags);
  static readonly List<SafeFileHandle> pins=new List<SafeFileHandle>();
  static readonly HashSet<string> names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  static void Require(bool ok) { if(!ok) throw new IOException("probe containment unavailable"); }
  static void Pin(string value,bool dir) {
    if(names.Contains(value)) return;
    string parent=Path.GetDirectoryName(value);
    if(parent!=null && parent!=value) Pin(parent,true);
    var h=CreateFileW(value,dir?0x1000A0u:0x100081u,1,IntPtr.Zero,3,dir?0x02200000u:0x00200000u,IntPtr.Zero);
    Info info=new Info(); Require(!h.IsInvalid && GetFileInformationByHandle(h,out info));
    Require((info.Attributes&0x400)==0 && ((info.Attributes&0x10)!=0)==dir);
    if(!dir && value.StartsWith("D:",StringComparison.OrdinalIgnoreCase)) Require(info.Links==1);
    var text=new StringBuilder(32768); uint n=GetFinalPathNameByHandleW(h,text,32768,0);
    Require(n>0 && n<32768 && String.Equals(text.ToString(),@"\\?\"+value,StringComparison.OrdinalIgnoreCase));
    pins.Add(h); names.Add(value);
  }
  static string Quote(string value) {
    if(value.IndexOf('\0')>=0) throw new IOException("invalid argument");
    if(value.Length>0 && value.IndexOfAny(new char[]{' ','\t','\n','\r','"'})<0) return value;
    var b=new StringBuilder("\""); int slash=0;
    foreach(char c in value) { if(c=='\\') { slash++; continue; } if(c=='\"') { b.Append('\\',slash*2+1); b.Append(c); } else { b.Append('\\',slash); b.Append(c); } slash=0; }
    b.Append('\\',slash*2); b.Append('"'); return b.ToString();
  }
  public static int Run(string exe,string supervisor,string cwd,string[] args,string[] env,byte[] input,uint timeout) {
    IntPtr job=IntPtr.Zero,attrs=IntPtr.Zero,handles=IntPtr.Zero,jobs=IntPtr.Zero,environment=IntPtr.Zero;
    IntPtr stdin=IntPtr.Zero,writer=IntPtr.Zero,stdout=IntPtr.Zero,stderr=IntPtr.Zero; PI child=new PI();
    try {
      Pin(cwd,true); Pin(exe,false); Pin(supervisor,false);
      Console.Out.WriteLine("TASK24_PROBE_PINNED"); Console.Out.Flush();
      Require(Console.In.ReadLine()=="continue");
      job=CreateJobObjectW(IntPtr.Zero,IntPtr.Zero); Require(job!=IntPtr.Zero);
      var limits=new Limits(); limits.Basic.Flags=0x2000; Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))));
      var sa=new SA(); sa.Size=Marshal.SizeOf(typeof(SA)); sa.Inherit=1;
      Require(CreatePipe(out stdin,out writer,ref sa,0)); Require(SetHandleInformation(writer,1,0));
      Require(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-11),GetCurrentProcess(),out stdout,0,true,2));
      Require(DuplicateHandle(GetCurrentProcess(),GetStdHandle(-12),GetCurrentProcess(),out stderr,0,true,2));
      IntPtr size=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size); Require(size!=IntPtr.Zero);
      attrs=Marshal.AllocHGlobal(size); Require(InitializeProcThreadAttributeList(attrs,2,0,ref size));
      handles=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handles,0,stdin); Marshal.WriteIntPtr(handles,IntPtr.Size,stdout); Marshal.WriteIntPtr(handles,IntPtr.Size*2,stderr);
      jobs=Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);
      Require(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
      Require(UpdateProcThreadAttribute(attrs,0,new IntPtr(0x2000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
      var start=new SX(); start.Info.Size=Marshal.SizeOf(typeof(SX)); start.Info.Flags=0x100; start.Info.In=stdin; start.Info.Out=stdout; start.Info.Err=stderr; start.Attributes=attrs;
      Array.Sort(env,StringComparer.OrdinalIgnoreCase); environment=Marshal.StringToHGlobalUni(String.Join("\0",env)+"\0\0");
      var command=new StringBuilder(Quote(exe)); foreach(string arg in args) { command.Append(' '); command.Append(Quote(arg)); } Require(command.Length<32760);
      Require(CreateProcessW(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x08080404,environment,cwd,ref start,out child));
      CloseHandle(stdin); stdin=IntPtr.Zero;
      IntPtr output=writer; writer=IntPtr.Zero;
      var thread=new Thread(()=>{try { using(var stream=new FileStream(new SafeFileHandle(output,true),FileAccess.Write)) { stream.Write(input,0,input.Length); } } catch {} }); thread.IsBackground=true; thread.Start();
      Require(ResumeThread(child.Thread)!=UInt32.MaxValue);
      if(WaitForSingleObject(child.Process,timeout)!=0) return 248;
      uint code; Require(GetExitCodeProcess(child.Process,out code)); return unchecked((int)code);
    } finally {
      if(job!=IntPtr.Zero) { TerminateJobObject(job,248); CloseHandle(job); }
      if(child.Thread!=IntPtr.Zero) CloseHandle(child.Thread); if(child.Process!=IntPtr.Zero) CloseHandle(child.Process);
      foreach(IntPtr h in new IntPtr[]{stdin,writer,stdout,stderr}) if(h!=IntPtr.Zero) CloseHandle(h);
      if(attrs!=IntPtr.Zero) { DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs); }
      foreach(IntPtr p in new IntPtr[]{handles,jobs,environment}) if(p!=IntPtr.Zero) Marshal.FreeHGlobal(p);
      for(int i=pins.Count-1;i>=0;i--) pins[i].Dispose();
    }
  }
}
`
const tail = String.raw`
try {
 $pairs=@($p.env.PSObject.Properties|ForEach-Object {$_.Name+'='+[string]$_.Value})
 exit [DesktopProbeWorker]::Run([string]$p.exe,[string]$p.supervisor,[string]$p.cwd,[string[]]$p.argv,[string[]]$pairs,[Convert]::FromBase64String([string]$p.input),[uint32]$p.timeoutMs)
} catch { exit 249 }
`
// The source is fixed by this module, not a caller-provided script. Hash verification precedes compilation.
export const desktopProbeWorker =
  preamble +
  desktopProbeBootstrap +
  String.raw`
$hash=[Security.Cryptography.SHA256]::Create()
try {$digest=[BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$p.workerSource))).Replace('-','').ToLowerInvariant()} finally {$hash.Dispose()}
if($digest -cne '${sha256Text(desktopProbeWorkerCode)}'){exit 249}
Add-Type -TypeDefinition ([string]$p.workerSource)
` +
  tail
