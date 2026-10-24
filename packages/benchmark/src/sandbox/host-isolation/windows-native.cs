using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Windows x64 only. The controller owns the outer kill-on-close job before compiling this class.
public static partial class Task24NativeIsolation {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int Size; public IntPtr Security; public int Inherit; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI { public int Size; public IntPtr Reserved,Desktop,Title; public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags; public ushort Show,ReservedSize; public IntPtr ReservedPtr,In,Out,Err; }
  [StructLayout(LayoutKind.Sequential)] struct SX { public SI Info; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr Process,Thread; public uint PID,TID; }
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long ProcessTime,JobTime; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct Limits { public Basic Basic; public Counters IO; public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Capabilities { public IntPtr Sid,Items; public uint Count,Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct SidAttributes { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct FileInfo { public uint Attributes,CLo,CHi,ALo,AHi,WLo,WHi,Volume,SizeHi,SizeLo,Links,IndexHi,IndexLo; }
  public sealed class FilePin { public string path,fileID,sha256; }
  public sealed class DirectoryPin { public string path,fileID; }
  public sealed class PinPlan { public FilePin exe;public FilePin[] benchmarkFiles;public DirectoryPin[] directories;public string profile,policyJournal,benchmarkAclRecord;public string[] mediatedRoots;public bool ancestorMetadata; }
  public sealed class BenchmarkAclGrant { public string path,fileID;public int mask,flags; }
  public sealed class BenchmarkAclRecord { public int schemaVersion;public string nonce,campaignID,runID,bindingSha256,executableSha256;public long expiresAt;public BenchmarkAclGrant[] grants; }
  [StructLayout(LayoutKind.Sequential)] struct Display { public IntPtr Name,Description; }
  [StructLayout(LayoutKind.Sequential)] struct Blob { public uint Size; public IntPtr Data; }
  [StructLayout(LayoutKind.Explicit,Size=16)] struct Value { [FieldOffset(0)] public uint Type; [FieldOffset(8)] public ulong Number; [FieldOffset(8)] public IntPtr Pointer; }
  [StructLayout(LayoutKind.Sequential)] struct Condition { public Guid Key; public uint Match; public Value Value; }
  [StructLayout(LayoutKind.Sequential)] struct FilterAction { public uint Type; public Guid Callout; }
  [StructLayout(LayoutKind.Explicit,Size=16)] struct Context { [FieldOffset(0)] public ulong Raw; [FieldOffset(0)] public Guid Provider; }
  [StructLayout(LayoutKind.Sequential)] struct Filter { public Guid Key; public Display Display; public uint Flags; public IntPtr Provider; public Blob Data; public Guid Layer,SubLayer; public Value Weight; public uint Count; public IntPtr Conditions; public FilterAction Action; public Context Context; public IntPtr Reserved; public ulong ID; public Value EffectiveWeight; }
  [StructLayout(LayoutKind.Sequential)] struct Session { public Guid Key; public Display Display; public uint Flags,Timeout,PID; public IntPtr Sid,Username; public int Kernel; }
  [StructLayout(LayoutKind.Sequential)] struct SubLayer { public Guid Key; public Display Display; public uint Flags; public IntPtr Provider; public Blob Data; public ushort Weight; }
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
  [DllImport("userenv.dll",CharSet=CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid,out IntPtr path);
  [DllImport("kernelbase.dll",CharSet=CharSet.Unicode)] static extern int AppContainerRegisterSid(IntPtr sid,string moniker,string displayName);
  [DllImport("kernelbase.dll")] static extern int AppContainerUnregisterSid(IntPtr sid);
  [DllImport("kernelbase.dll")] static extern int AppContainerLookupMoniker(IntPtr sid,out IntPtr moniker);
  [DllImport("kernelbase.dll")] static extern void AppContainerFreeMemory(IntPtr memory);
  [DllImport("kernelbase.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool DeriveCapabilitySidsFromName(string name,out IntPtr groups,out uint groupCount,out IntPtr capabilities,out uint capabilityCount);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr value,int size,out int required);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s,uint version,out IntPtr sd,out uint size);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorSacl(IntPtr sd,out bool present,out IntPtr sacl,out bool defaulted);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr sd,out bool present,out IntPtr dacl,out bool defaulted);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle handle,int type,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr sd);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(SafeFileHandle handle,int type,uint info,IntPtr owner,IntPtr group,IntPtr dacl,IntPtr sacl);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr sd);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetProcessHeap();
  [DllImport("kernel32.dll")] static extern bool HeapFree(IntPtr heap,uint flags,IntPtr memory);
  [DllImport("FirewallAPI.dll")] static extern uint NetworkIsolationGetAppContainerConfig(out uint count,out IntPtr sids);
  [DllImport("FirewallAPI.dll")] static extern uint NetworkIsolationSetAppContainerConfig(uint count,IntPtr sids);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr sa,IntPtr name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int type,ref Limits value,uint size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int type,IntPtr value,uint size,IntPtr returned);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr j,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
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
  [DllImport("kernel32.dll")] static extern bool GetFileInformationByHandle(SafeFileHandle h,out FileInfo info);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder text,uint count,uint flags);
  [DllImport("fwpuclnt.dll",CharSet=CharSet.Unicode)] static extern uint FwpmEngineOpen0(string server,uint auth,IntPtr authIdentity,ref Session session,out IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmEngineClose0(IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerAdd0(IntPtr engine,ref SubLayer layer,IntPtr sd);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterAdd0(IntPtr engine,ref Filter filter,IntPtr sd,out ulong id);

  static void Require(bool ok,string operation) { if(!ok) {int code=Marshal.GetLastWin32Error();throw new Win32Exception(code,operation+" win32="+code);} }
  static void Status(uint code,string operation) { if(code!=0) throw new IOException(operation+"="+code.ToString("x")); }
  static string Quote(string value) {
    if(value.IndexOf('\0')>=0) throw new IOException("argument");
    var b=new StringBuilder("\""); int slash=0;
    foreach(char c in value) { if(c=='\\') {slash++;continue;} b.Append('\\',c=='"'?slash*2+1:slash);b.Append(c);slash=0; }
    b.Append('\\',slash*2);return b.Append('"').ToString();
  }
  static IntPtr Struct(object value,List<IntPtr> memory) { var p=Marshal.AllocHGlobal(Marshal.SizeOf(value));memory.Add(p);Marshal.StructureToPtr(value,p,false);return p; }
  static Display Name(string value,List<IntPtr> memory) { var p=Marshal.StringToHGlobalUni(value);memory.Add(p);return new Display {Name=p}; }
  static void ExpectedID(SafeFileHandle handle,string expected) {
    if(expected==null)return;
    FileInfo info;Require(GetFileInformationByHandle(handle,out info),"recheck pinned identity");
    var parts=expected.Split(':');ulong index=((ulong)info.IndexHi<<32)|info.IndexLo;
    if(parts.Length!=3 || parts[0]!=info.Volume.ToString() || parts[1]!=index.ToString())
      throw new IOException("pin expected file ID="+expected+" actual="+info.Volume+":"+index);
  }
  static bool MediatedPath(string value,string[] roots) {
    if(roots!=null)foreach(string root in roots)if(String.Equals(value,root,StringComparison.OrdinalIgnoreCase)||value.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase))return true;
    return false;
  }
  static SafeFileHandle Pin(string value,bool directory,string expected,bool grant,Dictionary<string,SafeFileHandle> pins,HashSet<string> grantPaths,bool mutable,string[] mediatedRoots=null,HashSet<string> metadataPaths=null) {
    SafeFileHandle prior;
    if(pins.TryGetValue(value,out prior)){ExpectedID(prior,expected);return prior;}
    grant=grant||grantPaths.Contains(value);
    string parent=Path.GetDirectoryName(value);
    if(parent!=null && parent!=value)Pin(parent,true,null,false,pins,grantPaths,false,mediatedRoots,metadataPaths);
    // A mediated directory permits trusted child-entry updates, but never shares
    // DELETE: its ancestry cannot move. Its package ACL still grants read only.
    var handle=CreateFileW(value,metadataPaths!=null && metadataPaths.Contains(value)?0x00060080u:(grant?0x1e0080u:(directory?0x1000a0u:0x100081u)),(mutable&&!directory)||(directory&&MediatedPath(value,mediatedRoots))?3u:1u,IntPtr.Zero,3,directory?0x02200000u:0x00200000u,IntPtr.Zero);
    try {
      FileInfo info=new FileInfo();
      Require(!handle.IsInvalid && GetFileInformationByHandle(handle,out info),"pin identity");
      Require((info.Attributes&0x400)==0 && ((info.Attributes&0x10)!=0)==directory && (directory||info.Links==1),"direct unique identity");
      var text=new StringBuilder(32768);uint count=GetFinalPathNameByHandleW(handle,text,32768,0);
      Require(count>0 && count<32768 && String.Equals(text.ToString(),@"\\?\"+value,StringComparison.OrdinalIgnoreCase),"pin final path");
      ExpectedID(handle,expected);
      pins.Add(value,handle);return handle;
    } catch {handle.Dispose();throw;}
  }
  static void PinTree(string root,bool mutable,Dictionary<string,SafeFileHandle> pins,HashSet<string> grantPaths,int depth,ref int entries,string[] mediatedRoots=null) {
    Require(depth<=128,"admitted tree depth");
    foreach(var entry in Directory.GetFileSystemEntries(root)) {
      Require(++entries<=25000,"admitted tree size");
      var attributes=File.GetAttributes(entry);
      Require((attributes&FileAttributes.ReparsePoint)==0,"no admitted descendant reparse points");
      bool directory=(attributes&FileAttributes.Directory)!=0;
      Pin(entry,directory,null,false,pins,grantPaths,mutable,mediatedRoots);
      if(directory)PinTree(entry,mutable,pins,grantPaths,depth+1,ref entries,mediatedRoots);
    }
  }
  // Only the trusted controller may mutate mediated roots. Their package SID
  // remains ReadAndExecute. Seal admission with restrictive handles first. Once
  // inheritance is settled, retire only these leaf pins: Windows cannot replace
  // an open target even with delete sharing. Directory pins still seal ancestry;
  // the read-only package ACL prevents the child creating/replacing leaf entries.
  static void AdmitMediatedReplacement(string[] roots,string[] reads,string[] writes,Dictionary<string,SafeFileHandle> pins) {
    foreach(string root in roots) {
      bool admitted=false;foreach(string read in reads)if(String.Equals(read,root,StringComparison.OrdinalIgnoreCase))admitted=true;
      Require(admitted,"mediated root must have read-only package authority");
      foreach(string write in writes)Require(!String.Equals(write,root,StringComparison.OrdinalIgnoreCase) && !root.StartsWith(write+"\\",StringComparison.OrdinalIgnoreCase) && !write.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase),"no mediated writable overlap");
    }
    foreach(string file in new List<string>(pins.Keys)) {
      bool mediated=false;foreach(string root in roots)if(file.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase))mediated=true;
      if(!mediated)continue;
      FileInfo before;Require(GetFileInformationByHandle(pins[file],out before),"mediated old identity");
      if((before.Attributes&0x10)!=0)continue;
      Require((before.Attributes&0x410)==0 && before.Links==1,"mediated unique file");
      var text=new StringBuilder(32768);uint count=GetFinalPathNameByHandleW(pins[file],text,32768,0);
      Require(count>0 && count<32768 && String.Equals(text.ToString(),@"\\?\"+file,StringComparison.OrdinalIgnoreCase),"mediated final path");
      pins[file].Dispose();pins.Remove(file);
    }
  }
  static void Cleanup(Action action,List<Exception> failures) {try{action();}catch(Exception error){failures.Add(error);}}
  static IntPtr Capability(string name) {
    IntPtr groups=IntPtr.Zero,capabilities=IntPtr.Zero;uint groupCount=0,capabilityCount=0;
    Require(DeriveCapabilitySidsFromName(name,out groups,out groupCount,out capabilities,out capabilityCount),"derive LPAC capability");
    try {
      Require(capabilityCount==1,"single LPAC capability");
      return Marshal.ReadIntPtr(capabilities);
    } finally {
      for(int i=0;i<groupCount;i++)LocalFree(Marshal.ReadIntPtr(groups,i*IntPtr.Size));
      if(groups!=IntPtr.Zero)LocalFree(groups);
      if(capabilities!=IntPtr.Zero)LocalFree(capabilities);
    }
  }
  static void Loopback(IntPtr ownSid,bool add) {
    // Re-read before each additive/subtractive update; never restore an old global snapshot.
    using(var mutex=new Mutex(false,"Local\\opencode-task24-loopback-registration")) {
      bool held=false;
      try {
        try {held=mutex.WaitOne(30000);}catch(AbandonedMutexException){held=true;}
        if(!held)throw new IOException("loopback registration busy");
        uint count;IntPtr entries;Status(NetworkIsolationGetAppContainerConfig(out count,out entries),"read loopback registrations");
        int size=Marshal.SizeOf(typeof(SidAttributes));var keep=new List<SidAttributes>();string own=new SecurityIdentifier(ownSid).Value;
        try {
          for(uint i=0;i<count;i++) {var entry=(SidAttributes)Marshal.PtrToStructure(IntPtr.Add(entries,(int)i*size),typeof(SidAttributes));if(new SecurityIdentifier(entry.Sid).Value!=own)keep.Add(entry);}
          if(add)keep.Add(new SidAttributes{Sid=ownSid});
          var target=Marshal.AllocHGlobal(Math.Max(1,keep.Count)*size);
          try {
            for(int i=0;i<keep.Count;i++)Marshal.StructureToPtr(keep[i],IntPtr.Add(target,i*size),false);
            Status(NetworkIsolationSetAppContainerConfig((uint)keep.Count,target),"update own loopback registration");
            uint observedCount;IntPtr observed;
            Status(NetworkIsolationGetAppContainerConfig(out observedCount,out observed),"verify loopback registrations");
            try {
              var expected=new HashSet<string>();foreach(var entry in keep)expected.Add(new SecurityIdentifier(entry.Sid).Value);
              var actual=new HashSet<string>();
              for(uint i=0;i<observedCount;i++){var entry=(SidAttributes)Marshal.PtrToStructure(IntPtr.Add(observed,(int)i*size),typeof(SidAttributes));actual.Add(new SecurityIdentifier(entry.Sid).Value);}
              Require(expected.SetEquals(actual),"own loopback update preserved other registrations");
            } finally {
              for(uint i=0;i<observedCount;i++){var entry=(SidAttributes)Marshal.PtrToStructure(IntPtr.Add(observed,(int)i*size),typeof(SidAttributes));HeapFree(GetProcessHeap(),0,entry.Sid);}
              HeapFree(GetProcessHeap(),0,observed);
            }
          }
          finally{Marshal.FreeHGlobal(target);}
        } finally {
          for(uint i=0;i<count;i++){var entry=(SidAttributes)Marshal.PtrToStructure(IntPtr.Add(entries,(int)i*size),typeof(SidAttributes));HeapFree(GetProcessHeap(),0,entry.Sid);}
          HeapFree(GetProcessHeap(),0,entries);
        }
      } finally {if(held)mutex.ReleaseMutex();}
    }
  }
  static readonly Guid package=new Guid("71bc78fa-f17c-4997-a602-6abb261f351c"),remote=new Guid("b235ae9a-1d64-49b8-a44c-5ff3d9095045"),portKey=new Guid("c35a604d-d22b-4e1a-91b4-68f674ee674b");
  static void AddFilter(IntPtr engine,Guid sub,Guid layer,IntPtr sid,int port,bool allow,List<IntPtr> memory) {
    Require(allow,"volatile raw policy session is permit-only");
    var conditions=new List<Condition>();
    conditions.Add(new Condition{Key=package,Value=new Value{Type=13,Pointer=sid}});
    if(allow) {
      conditions.Add(new Condition{Key=remote,Value=new Value{Type=3,Number=0x7f000001}});
      conditions.Add(new Condition{Key=portKey,Value=new Value{Type=2,Number=(ulong)port}});
      conditions.Add(new Condition{Key=policyProtocol,Value=new Value{Type=1,Number=6}});
    }
    int size=Marshal.SizeOf(typeof(Condition));var data=Marshal.AllocHGlobal(size*conditions.Count);memory.Add(data);
    for(int i=0;i<conditions.Count;i++)Marshal.StructureToPtr(conditions[i],IntPtr.Add(data,i*size),false);
    var f=new Filter{Key=Guid.NewGuid(),Display=Name("Task24 ephemeral AppContainer boundary",memory),Flags=allow?8u:0u,Layer=layer,SubLayer=sub,Weight=new Value{Type=1,Number=allow?15ul:1ul},Count=(uint)conditions.Count,Conditions=data,Action=new FilterAction{Type=allow?0x1002u:0x1001u}};
    ulong id;Status(FwpmFilterAdd0(engine,ref f,IntPtr.Zero,out id),"WFP filter");
  }
  sealed class Grant : IDisposable {
    SafeFileHandle handle;byte[] original;SecurityIdentifier sid;bool write;bool applied;
    public Grant(SafeFileHandle handle,SecurityIdentifier sid,bool write) {this.handle=handle;this.sid=sid;this.write=write;}
    public void Apply() {
      IntPtr owner,group,dacl,sacl,descriptor;
      Status(GetSecurityInfo(handle,1,4u|(write?0x10u:0u),out owner,out group,out dacl,out sacl,out descriptor),"read own directory security");
      try {original=new byte[GetSecurityDescriptorLength(descriptor)];Marshal.Copy(descriptor,original,0,original.Length);}finally{LocalFree(descriptor);}
      var acl=new DirectorySecurity();acl.SetSecurityDescriptorBinaryForm(original,AccessControlSections.Access);
      acl.AddAccessRule(new FileSystemAccessRule(sid,write?FileSystemRights.Modify:FileSystemRights.ReadAndExecute,InheritanceFlags.ContainerInherit|InheritanceFlags.ObjectInherit,PropagationFlags.None,AccessControlType.Allow));
      applied=true;
      var bytes=acl.GetSecurityDescriptorBinaryForm();var pin=GCHandle.Alloc(bytes,GCHandleType.Pinned);
      try {bool present,defaulted;Require(GetSecurityDescriptorDacl(pin.AddrOfPinnedObject(),out present,out dacl,out defaulted),"own grant DACL");Status(SetSecurityInfo(handle,1,4,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero),"apply own grant");}finally{pin.Free();}
      if(write) {
        IntPtr sd;uint size;Require(ConvertStringSecurityDescriptorToSecurityDescriptorW("S:(ML;OICI;NW;;;LW)",1,out sd,out size),"low integrity descriptor");
        try {bool present,defaulted;Require(GetSecurityDescriptorSacl(sd,out present,out sacl,out defaulted),"low integrity ACL");Status(SetSecurityInfo(handle,1,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,sacl),"set own directory integrity");}finally{LocalFree(sd);}
      }
    }
    public void Dispose() {
      if(!applied)return;
      var failures=new List<Exception>();var pin=GCHandle.Alloc(original,GCHandleType.Pinned);
      try {
        IntPtr dacl;bool present,defaulted;
        if(write)Cleanup(()=>{IntPtr label;bool exists,unused;Require(GetSecurityDescriptorSacl(pin.AddrOfPinnedObject(),out exists,out label,out unused),"restore integrity descriptor");Status(SetSecurityInfo(handle,1,0x10,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,label),"restore own integrity");},failures);
        Require(GetSecurityDescriptorDacl(pin.AddrOfPinnedObject(),out present,out dacl,out defaulted),"restore DACL descriptor");
        Status(SetSecurityInfo(handle,1,4,IntPtr.Zero,IntPtr.Zero,dacl,IntPtr.Zero),"restore own DACL");
        applied=false;
      } finally {pin.Free();}
      if(failures.Count>0)throw new AggregateException("own directory cleanup failed",failures);
    }
  }
  // Non-inheriting metadata only. Never restore an ancestor's whole old DACL:
  // remove this unique SID's exact ACE from the current descriptor instead.
  sealed class MetadataGrant : IDisposable {
    readonly SafeFileHandle handle;readonly SecurityIdentifier sid;readonly string path;bool applied;
    public bool Retired {get;private set;}
    public MetadataGrant(SafeFileHandle handle,SecurityIdentifier sid,string path){this.handle=handle;this.sid=sid;this.path=path;}
    [DllImport("ntdll.dll")]static extern int NtSetSecurityObject(SafeFileHandle handle,uint flags,IntPtr descriptor);
    RawSecurityDescriptor ReadAcl() {
      IntPtr owner,group,dacl,sacl,descriptor;
      Status(GetSecurityInfo(handle,1,4,out owner,out group,out dacl,out sacl,out descriptor),"read ancestor metadata DACL");
      try {var bytes=new byte[GetSecurityDescriptorLength(descriptor)];Marshal.Copy(descriptor,bytes,0,bytes.Length);var result=new RawSecurityDescriptor(bytes,0);Require(result.DiscretionaryAcl!=null,"ancestor DACL exists");return result;}finally{LocalFree(descriptor);}
    }
    void WriteAcl(RawSecurityDescriptor descriptor) {
      var controls=descriptor.ControlFlags;
      var expected=new byte[descriptor.DiscretionaryAcl.BinaryLength];descriptor.DiscretionaryAcl.GetBinaryForm(expected,0);
      // The handle-based native operation changes only this object. Unlike
      // SetSecurityInfo it does not walk existing children. AUTO_INHERITED
      // requires AUTO_INHERIT_REQ in the incoming descriptor to survive the
      // filesystem update; do not enable either bit on legacy/protected ACLs.
      if((controls&ControlFlags.DiscretionaryAclAutoInherited)!=0)descriptor.SetFlags(controls|ControlFlags.DiscretionaryAclAutoInheritRequired);
      var bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);var pin=GCHandle.Alloc(bytes,GCHandleType.Pinned);
      try {Status(unchecked((uint)NtSetSecurityObject(handle,4,pin.AddrOfPinnedObject())),"update own ancestor metadata ACE");}finally{pin.Free();}
      var after=ReadAcl();var actual=new byte[after.DiscretionaryAcl.BinaryLength];after.DiscretionaryAcl.GetBinaryForm(actual,0);
      if(after.ControlFlags!=controls||Convert.ToBase64String(actual)!=Convert.ToBase64String(expected))throw new IOException("ancestor metadata ACL/control verification: "+path);
    }
    public void Apply() {
      var descriptor=ReadAcl();int index=descriptor.DiscretionaryAcl.Count;
      for(int i=0;i<descriptor.DiscretionaryAcl.Count;i++) {
        var ace=descriptor.DiscretionaryAcl[i] as KnownAce;
        Require(ace==null || !ace.SecurityIdentifier.Equals(sid),"fresh ancestor metadata SID");
        if(index==descriptor.DiscretionaryAcl.Count && (descriptor.DiscretionaryAcl[i].AceFlags&AceFlags.Inherited)!=0)index=i;
      }
      // 0x80 FILE_READ_ATTRIBUTES + 0x20 FILE_TRAVERSE. No LIST_DIRECTORY,
      // READ_DATA, SYNCHRONIZE, inheritance, write, owner or ACL authority.
      descriptor.DiscretionaryAcl.InsertAce(index,new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,0xa0,sid,false,null));
      applied=true;WriteAcl(descriptor);
    }
    public void Dispose() {
      if(!applied){Retired=true;return;}
      var descriptor=ReadAcl();int found=-1;
      for(int i=0;i<descriptor.DiscretionaryAcl.Count;i++) {
        var ace=descriptor.DiscretionaryAcl[i] as KnownAce;
        if(ace==null || !ace.SecurityIdentifier.Equals(sid))continue;
        var expected=ace as CommonAce;
        Require(found<0 && expected!=null && expected.AceFlags==AceFlags.None && expected.AceQualifier==AceQualifier.AccessAllowed && expected.AccessMask==0xa0,"exact own ancestor metadata ACE");found=i;
      }
      Require(found>=0,"own ancestor metadata ACE still present");
      descriptor.DiscretionaryAcl.RemoveAce(found);WriteAcl(descriptor);
      var after=ReadAcl();foreach(GenericAce item in after.DiscretionaryAcl){var ace=item as KnownAce;Require(ace==null || !ace.SecurityIdentifier.Equals(sid),"ancestor metadata ACE retired");}
      Retired=true;
    }
  }
  static HashSet<string> MetadataPaths(bool enabled,string exe,string cwd,string[] reads,string[] writes) {
    var result=new HashSet<string>(StringComparer.OrdinalIgnoreCase);if(!enabled)return result;
    var values=new List<string>(reads);values.AddRange(writes);values.Add(cwd);values.Add(exe);
    foreach(string value in values) {
      string parent=Path.GetDirectoryName(value);
      while(parent!=null) {
        Require(parent.StartsWith(@"D:\",StringComparison.OrdinalIgnoreCase),"D-only metadata ancestor");
        bool admitted=false;foreach(string root in reads)if(String.Equals(parent,root,StringComparison.OrdinalIgnoreCase)||parent.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase))admitted=true;
        foreach(string root in writes)if(String.Equals(parent,root,StringComparison.OrdinalIgnoreCase)||parent.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase))admitted=true;
        if(!admitted)result.Add(parent);
        string next=Path.GetDirectoryName(parent);if(next==parent)break;parent=next;
      }
    }
    Require(result.Count<=512,"bounded metadata ancestors");return result;
  }
  static byte[] Read(IntPtr pipe,int limit,IntPtr job,Action truncate) {
    using(var stream=new FileStream(new SafeFileHandle(pipe,true),FileAccess.Read,8192,false))using(var output=new MemoryStream()) {
      var buffer=new byte[8192];int count;
      try {while((count=stream.Read(buffer,0,buffer.Length))>0) {int keep=Math.Min(count,limit-(int)output.Length);if(keep>0)output.Write(buffer,0,keep);if(keep<count){truncate();TerminateJobObject(job,125);break;}}}catch(IOException){}
      return output.ToArray();
    }
  }
  public static string Run(string exe,string[] argv,string cwd,string[] reads,string[] writes,int[] ports,string environment,string input,int timeout,int outLimit,int errLimit,string pinsJSON) {
    IntPtr sid=IntPtr.Zero,registryRead=IntPtr.Zero,network=IntPtr.Zero,engine=IntPtr.Zero,job=IntPtr.Zero,attributes=IntPtr.Zero,env=IntPtr.Zero;
    IntPtr ri=IntPtr.Zero,wi=IntPtr.Zero,ro=IntPtr.Zero,wo=IntPtr.Zero,re=IntPtr.Zero,we=IntPtr.Zero;
    var memory=new List<IntPtr>();var grants=new List<IDisposable>();var metadataGrants=new List<MetadataGrant>();var pi=new PI();PersistentPolicy policy=null;bool dynamicApplied=false;
    Thread outThread=null,errThread=null,inThread=null;byte[] stdout=new byte[0],stderr=new byte[0];int truncated=0;bool ended=false,started=false;uint exit=125;
    var pins=new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
    var serializer=new JavaScriptSerializer{MaxJsonLength=4194304};var plan=serializer.Deserialize<PinPlan>(pinsJSON);
    var metadataPaths=MetadataPaths(plan.ancestorMetadata,exe,cwd,reads,writes);string metadataJournal=Path.Combine(Path.GetDirectoryName(plan.policyJournal),"ancestor-metadata.intent.json");bool metadataRetired=metadataPaths.Count==0;
    string sidString="",profile=plan.profile,profilePath="",defaultProfilePath="";bool profileCreated=false,loopbackAdded=false,lockHeld=false;
    var exclusive=new Mutex(false,"Global\\opencode-task24-native-isolation-grants");
    int cancelled=0;Exception failure=null;
    var watcher=new Thread(()=>{try{Console.In.ReadLine();}finally{Interlocked.Exchange(ref cancelled,1);}});watcher.IsBackground=true;watcher.Start();
    try {
      if(plan.benchmarkAclRecord==null) {
        Require(profile!=null && System.Text.RegularExpressions.Regex.IsMatch(profile,@"^opencode\.task24\.[a-f0-9]{32}$"),"owned profile name");
      } else {
        var bytes=Encoding.UTF8.GetBytes(plan.benchmarkAclRecord);
        Require(bytes.Length>0 && bytes.Length<=65536,"bounded benchmark ACL record");
        string commitment;using(var hash=SHA256.Create())commitment=BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant().Substring(0,48);
        Require(profile=="opencode.task24."+commitment,"benchmark ACL package commitment");
        var record=serializer.Deserialize<BenchmarkAclRecord>(plan.benchmarkAclRecord);
        long now=(long)(DateTime.UtcNow-new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
        Require(record.schemaVersion==1 && record.expiresAt>now && record.expiresAt<=now+3600000 && record.executableSha256==plan.exe.sha256 && record.grants!=null && record.grants.Length==writes.Length-1,"benchmark ACL launch binding");
        for(int index=0;index<record.grants.Length;index++) {
          var grant=record.grants[index];bool matched=false;
          foreach(var directory in plan.directories)if(directory.path==grant.path && directory.fileID==grant.fileID)matched=true;
          Require(grant.path==writes[index+1] && grant.mask==0x1301bf && grant.flags==3 && matched,"exact benchmark ACL write grant");
        }
      }
      try{lockHeld=exclusive.WaitOne(30000);}catch(AbandonedMutexException){lockHeld=true;}
      if(!lockHeld)throw new IOException("isolation grants busy");
      var grantPaths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);foreach(var directory in plan.directories)grantPaths.Add(directory.path);
      foreach(var directory in plan.directories)Pin(directory.path,true,directory.fileID,true,pins,grantPaths,false,plan.mediatedRoots,metadataPaths);
      var exeHandle=Pin(exe,false,plan.exe.fileID,false,pins,grantPaths,false);
      Require(String.Equals(exe,plan.exe.path,StringComparison.OrdinalIgnoreCase),"pin executable path");
      using(var stream=new FileStream(new SafeFileHandle(exeHandle.DangerousGetHandle(),false),FileAccess.Read))using(var hash=SHA256.Create()) {
        Require(BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant()==plan.exe.sha256,"pin executable hash");
      }
      if(plan.benchmarkFiles!=null) {
        Require(plan.benchmarkAclRecord!=null && plan.benchmarkFiles.Length==3,"benchmark files require native authority");
        foreach(var file in plan.benchmarkFiles) {
          var handle=Pin(file.path,false,file.fileID,false,pins,grantPaths,false);
          using(var stream=new FileStream(new SafeFileHandle(handle.DangerousGetHandle(),false),FileAccess.Read))using(var hash=SHA256.Create())
            Require(BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant()==file.sha256,"pinned benchmark host file hash");
        }
      }
      if(Interlocked.CompareExchange(ref cancelled,0,0)!=0)throw new OperationCanceledException("controller disconnected before launch");
      // Register only the security identity. CreateAppContainerProfile also creates a default
      // C-drive application-data tree. Chromium uses these Windows registration exports with
      // an explicitly provisioned data directory; missing exports fail closed before launch.
      int derived=DeriveAppContainerSidFromAppContainerName(profile,out sid);
      if(derived<0)Marshal.ThrowExceptionForHR(derived);
      int registered=AppContainerRegisterSid(sid,profile,profile);
      if(registered!=0)throw new IOException("new AppContainer registration failed="+registered.ToString("x"));
      profileCreated=true;
      var identity=new SecurityIdentifier(sid);sidString=identity.Value;
      if(metadataPaths.Count>0) {
        var records=new List<object>();foreach(string p in metadataPaths){FileInfo info=new FileInfo();Require(pins.ContainsKey(p)&&GetFileInformationByHandle(pins[p],out info),"pinned metadata ancestor");records.Add(new{path=p,volume=info.Volume.ToString(),fileID=(((ulong)info.IndexHi<<32)|info.IndexLo).ToString()});}
        var bytes=Encoding.UTF8.GetBytes(serializer.Serialize(new{purpose="task24-ancestor-metadata",sid=sidString,mask=160,inherited=false,paths=records}));
        using(var journal=new FileStream(metadataJournal,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){journal.Write(bytes,0,bytes.Length);journal.Flush(true);}
        foreach(string p in metadataPaths){var grant=new MetadataGrant(pins[p],identity,p);metadataGrants.Add(grant);grants.Add(grant);grant.Apply();}
      }
      IntPtr folder;int located=GetAppContainerFolderPath(sidString,out folder);if(located<0)Marshal.ThrowExceptionForHR(located);
      try{defaultProfilePath=Marshal.PtrToStringUni(folder);}finally{Marshal.FreeCoTaskMem(folder);}
      var vars=serializer.Deserialize<Dictionary<string,string>>(environment);
      Require(!Directory.Exists(Path.GetDirectoryName(defaultProfilePath)),"no default C-drive application data");
      profilePath=Path.Combine(vars["LOCALAPPDATA"],"Packages",profile,"AC");
      Require(profilePath.StartsWith(@"D:\",StringComparison.OrdinalIgnoreCase),"D-only AppContainer data");
      Directory.CreateDirectory(Path.Combine(profilePath,"Temp"));
      if(plan.benchmarkAclRecord!=null) {
        var bytes=Encoding.UTF8.GetBytes(plan.benchmarkAclRecord);
        using(var record=new FileStream(Path.Combine(Path.GetDirectoryName(exe),"benchmark-acl-authority.json"),FileMode.CreateNew,FileAccess.Write,FileShare.Read)){record.Write(bytes,0,bytes.Length);record.Flush(true);}
      }
      // Inherited DACL/MIC updates affect existing descendants. Seal every admitted tree
      // first so a pre-existing hardlink/junction cannot transfer a grant outside its root.
      int treeEntries=0;
      foreach(var read in reads)PinTree(read,false,pins,grantPaths,0,ref treeEntries,plan.mediatedRoots);
      foreach(var write in writes)PinTree(write,true,pins,grantPaths,0,ref treeEntries);
      PolicyCreate(exe,plan.policyJournal,plan.exe,plan.exe,plan.directories,pins,"sid",sidString,PolicySidBytes(sid),ref policy);
      var session=new Session{Key=Guid.NewGuid(),Flags=1,Display=Name("Task24 dynamic sandbox",memory)};
      Status(FwpmEngineOpen0(null,10,IntPtr.Zero,ref session,out engine),"WFP open");
      foreach(int port in ports)AddFilter(engine,PolicyGuid(policy.Intent.sublayer.key),policyV4,sid,port,true,memory);dynamicApplied=true;
      if(ports.Length>0){loopbackAdded=true;Loopback(sid,true);}
      foreach(string p in reads){var grant=new Grant(pins[p],identity,false);grants.Add(grant);try{grant.Apply();}catch(Exception error){throw new IOException("readonly grant: "+p,error);}}
      foreach(string p in writes){var grant=new Grant(pins[p],identity,true);grants.Add(grant);try{grant.Apply();}catch(Exception error){throw new IOException("writable grant: "+p,error);}}
      AdmitMediatedReplacement(plan.mediatedRoots??new string[0],reads,writes,pins);
      job=PolicyCreateJob(policy);
      var limits=new Limits{Basic=new Basic{Flags=0x2000|0x8|0x200,Active=64},JobMemory=(UIntPtr)(2ul*1024*1024*1024)};
      Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)),"job limits");
      var sa=new SA{Size=Marshal.SizeOf(typeof(SA)),Inherit=1};
      Require(CreatePipe(out ri,out wi,ref sa,0)&&CreatePipe(out ro,out wo,ref sa,0)&&CreatePipe(out re,out we,ref sa,0),"pipes");
      Require(SetHandleInformation(wi,1,0)&&SetHandleInformation(ro,1,0)&&SetHandleInformation(re,1,0),"pipe inheritance");
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,4,0,ref size);attributes=Marshal.AllocHGlobal(size);
      Require(InitializeProcThreadAttributeList(attributes,4,0,ref size),"attributes");
      // Winsock reads its system catalog during Bun startup. LPAC has no ambient registry
      // access; grant this documented read capability, never ALL APPLICATION PACKAGES.
      registryRead=Capability("registryRead");
      int capSize=Marshal.SizeOf(typeof(SidAttributes));
      var capability=Marshal.AllocHGlobal(capSize*(ports.Length>0?2:1));memory.Add(capability);
      Marshal.StructureToPtr(new SidAttributes{Sid=registryRead,Attributes=4},capability,false);
      if(ports.Length>0) {
        network=Capability("internetClient");
        Marshal.StructureToPtr(new SidAttributes{Sid=network,Attributes=4},IntPtr.Add(capability,capSize),false);
      }
      var security=Struct(new Capabilities{Sid=sid,Items=capability,Count=ports.Length>0?2u:1u},memory);
      Require(UpdateProcThreadAttribute(attributes,0,(IntPtr)0x20009,security,(IntPtr)Marshal.SizeOf(typeof(Capabilities)),IntPtr.Zero,IntPtr.Zero),"AppContainer attribute");
      var leastPrivilege=Marshal.AllocHGlobal(4);memory.Add(leastPrivilege);Marshal.WriteInt32(leastPrivilege,1);
      Require(UpdateProcThreadAttribute(attributes,0,(IntPtr)0x2000f,leastPrivilege,(IntPtr)4,IntPtr.Zero,IntPtr.Zero),"LPAC ambient package opt-out");
      var handles=Marshal.AllocHGlobal(IntPtr.Size*3);memory.Add(handles);Marshal.WriteIntPtr(handles,0,ri);Marshal.WriteIntPtr(handles,IntPtr.Size,wo);Marshal.WriteIntPtr(handles,IntPtr.Size*2,we);
      Require(UpdateProcThreadAttribute(attributes,0,(IntPtr)0x20002,handles,(IntPtr)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"stdio handles");
      var jobList=Marshal.AllocHGlobal(IntPtr.Size);memory.Add(jobList);Marshal.WriteIntPtr(jobList,job);
      Require(UpdateProcThreadAttribute(attributes,0,(IntPtr)0x2000d,jobList,(IntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero),"atomic job assignment");
      var names=new List<string>(vars.Keys);names.Sort(StringComparer.OrdinalIgnoreCase);var block=new StringBuilder();foreach(string name in names)block.Append(name).Append('=').Append(vars[name]).Append('\0');block.Append('\0');
      env=Marshal.StringToHGlobalUni(block.ToString());
      var sx=new SX{Info=new SI{Size=Marshal.SizeOf(typeof(SX)),Flags=0x100,In=ri,Out=wo,Err=we},Attributes=attributes};
      var cmd=new StringBuilder(Quote(exe));foreach(string arg in argv)cmd.Append(' ').Append(Quote(arg));
      Require(CreateProcessW(exe,cmd,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|0x4|0x08000000,env,cwd,ref sx,out pi),"AppContainer CreateProcess");started=true;
      IntPtr token;Require(OpenProcessToken(pi.Process,8,out token),"child token");
      try {var flag=Marshal.AllocHGlobal(4);memory.Add(flag);int required;Require(GetTokenInformation(token,29,flag,4,out required)&&Marshal.ReadInt32(flag)==1,"child is AppContainer");}finally{CloseHandle(token);}
      CloseHandle(ri);ri=IntPtr.Zero;CloseHandle(wo);wo=IntPtr.Zero;CloseHandle(we);we=IntPtr.Zero;
      var outHandle=ro;ro=IntPtr.Zero;var errHandle=re;re=IntPtr.Zero;var inHandle=wi;wi=IntPtr.Zero;
      outThread=new Thread(()=>{stdout=Read(outHandle,outLimit,job,()=>Interlocked.Exchange(ref truncated,1));});outThread.IsBackground=true;outThread.Start();
      errThread=new Thread(()=>{stderr=Read(errHandle,errLimit,job,()=>Interlocked.Exchange(ref truncated,1));});errThread.IsBackground=true;errThread.Start();
      var payload=Convert.FromBase64String(input);inThread=new Thread(()=>{try{using(var stream=new FileStream(new SafeFileHandle(inHandle,true),FileAccess.Write,8192,false))stream.Write(payload,0,payload.Length);}catch(IOException){}});inThread.IsBackground=true;inThread.Start();
      if(Interlocked.CompareExchange(ref cancelled,0,0)!=0)exit=130;
      else {
        Require(ResumeThread(pi.Thread)!=0xffffffff,"resume");
        var elapsed=System.Diagnostics.Stopwatch.StartNew();
        for(;;) {
          if(Interlocked.CompareExchange(ref cancelled,0,0)!=0){exit=130;break;}
          uint waited=WaitForSingleObject(pi.Process,25);
          if(waited==0){Require(GetExitCodeProcess(pi.Process,out exit),"exit code");break;}
          Require(waited==0x102,"wait process");
          if(elapsed.ElapsedMilliseconds>=timeout){exit=124;Interlocked.Exchange(ref truncated,1);break;}
        }
      }
      Require(TerminateJobObject(job,exit),"end job descendants");
      var accounting=Marshal.AllocHGlobal(48);memory.Add(accounting);
      for(int i=0;i<500;i++){Require(QueryInformationJobObject(job,1,accounting,48,IntPtr.Zero),"job accounting");if(Marshal.ReadInt32(accounting,40)==0){ended=true;break;}Thread.Sleep(10);}
      if(!outThread.Join(5000)||!errThread.Join(5000)||!inThread.Join(5000)||!ended)throw new IOException("process tree or stdio did not end");
    } catch(OperationCanceledException){exit=130;} catch(Exception error){failure=error;} finally {
      var errors=new List<Exception>();
      if(job!=IntPtr.Zero)Cleanup(()=>Require(TerminateJobObject(job,125),"terminate final job"),errors);
      if(job!=IntPtr.Zero)Cleanup(()=>{
        var accounting=Marshal.AllocHGlobal(48);
        try {
          for(int i=0;i<500;i++) {
            Require(QueryInformationJobObject(job,1,accounting,48,IntPtr.Zero),"final job accounting");
            if(Marshal.ReadInt32(accounting,40)==0){ended=true;break;}
            Thread.Sleep(10);
          }
          Require(ended,"final process tree ended");
        } finally {Marshal.FreeHGlobal(accounting);}
      },errors);
      foreach(var thread in new[]{outThread,errThread,inThread})if(thread!=null)Cleanup(()=>Require(thread.Join(5000),"final stdio ended"),errors);
      foreach(var h in new[]{pi.Thread,pi.Process,ri,wi,ro,wo,re,we})if(h!=IntPtr.Zero)Cleanup(()=>Require(CloseHandle(h),"close own process handle"),errors);
      if(attributes!=IntPtr.Zero)Cleanup(()=>{DeleteProcThreadAttributeList(attributes);Marshal.FreeHGlobal(attributes);},errors);
      if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);
      for(int i=grants.Count-1;i>=0;i--){var grant=grants[i];Cleanup(()=>grant.Dispose(),errors);}
      if(metadataGrants.Count>0 && metadataGrants.TrueForAll(grant=>grant.Retired))Cleanup(()=>{File.Delete(metadataJournal);metadataRetired=true;},errors);
      if(loopbackAdded)Cleanup(()=>Loopback(sid,false),errors);
      bool permitsClosed=engine==IntPtr.Zero;
      if(engine!=IntPtr.Zero)Cleanup(()=>{Status(FwpmEngineClose0(engine),"close volatile permit WFP session");engine=IntPtr.Zero;permitsClosed=true;},errors);
      PolicyFinish(policy,ended||!started,permitsClosed,job,started,errors);
      if(job!=IntPtr.Zero)Cleanup(()=>Require(CloseHandle(job),"close own named job"),errors);
      if(profileCreated)Cleanup(()=>{
        Require(!Directory.Exists(Path.GetDirectoryName(defaultProfilePath)),"default C application-data directory stayed absent");
      },errors);
      if(profileCreated)Cleanup(()=>{
        int deleted=AppContainerUnregisterSid(sid);if(deleted<0)Marshal.ThrowExceptionForHR(deleted);
        IntPtr moniker;int lookup=AppContainerLookupMoniker(sid,out moniker);
        try{Require(lookup<0,"own AppContainer registration removed");}finally{if(moniker!=IntPtr.Zero)AppContainerFreeMemory(moniker);}
      },errors);
      foreach(var handle in pins.Values)Cleanup(()=>handle.Dispose(),errors);
      if(sid!=IntPtr.Zero)FreeSid(sid);if(registryRead!=IntPtr.Zero)LocalFree(registryRead);if(network!=IntPtr.Zero)LocalFree(network);
      foreach(var p in memory)Marshal.FreeHGlobal(p);
      if(lockHeld)Cleanup(()=>exclusive.ReleaseMutex(),errors);exclusive.Dispose();
      if(errors.Count>0){if(failure!=null)errors.Insert(0,failure);failure=new AggregateException("isolation cleanup failed; policyJournal="+(policy==null?"":policy.JournalPath),errors);}
    }
    if(failure!=null)throw failure;
    return serializer.Serialize(new {started=started,exitCode=(int)exit,stdout=Convert.ToBase64String(stdout),stderr=Convert.ToBase64String(stderr),truncated=truncated!=0,containment=new {appContainer=started,sid=sidString,processTreeEnded=ended||!started,dynamicNetworkPolicy=dynamicApplied,cleanupCompleted=true,profilePath=profilePath,persistentNetworkPolicy=policy!=null && policy.Committed,persistentPolicyRetired=policy==null || policy.Retired,policyJournal=policy==null?"":policy.JournalPath,ancestorMetadataPaths=new List<string>(metadataPaths),ancestorMetadataRetired=metadataRetired}});
  }
}
