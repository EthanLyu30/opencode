public static partial class Task24NativeIsolation {
  public sealed class BrowserPinPlan { public FilePin exe,helper,browser; public DirectoryPin[] directories; public string[] readonlyRoots; public string policyJournal; }
  public sealed class BrowserRenderer { public uint pid; public bool appContainer,restricted; public int integrity; }
  public sealed class BrowserMetadataRegistration { public string name,sid; public bool defaultPathAbsent,unregistered; }
  sealed class BrowserOwnedMetadata { public BrowserMetadataRegistration Observation; public IntPtr Sid; public string StateRoot; public List<string> DefaultPaths=new List<string>(); public bool Registered; }
  [StructLayout(LayoutKind.Sequential)] struct BrowserUnicodeString { public ushort Length,MaximumLength; public IntPtr Buffer; }
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int BrowserQueryProcess(IntPtr process,int kind,IntPtr value,uint size,out uint required);
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool member);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFileAttributesW(string path);
  [DllImport("shell32.dll",CharSet=CharSet.Unicode)] static extern int SHGetKnownFolderPath(ref Guid folder,uint flags,IntPtr token,out IntPtr path);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr process,uint flags,StringBuilder name,ref uint length);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr GetModuleHandleW(string name);
  [DllImport("kernel32.dll",CharSet=CharSet.Ansi,ExactSpelling=true,SetLastError=true)] static extern IntPtr GetProcAddress(IntPtr module,string name);
  [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command,out int count);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool IsTokenRestricted(IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool IsValidSid(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);

  static readonly Guid browserAppID=new Guid("d78e1e87-8644-4ea5-9437-d809ecefc971"),browserProtocol=new Guid("3971ef2b-623e-4f9a-8cb1-6e79b806b9a7");
  static Guid BrowserFilter(IntPtr engine,Guid sub,Guid layer,IntPtr appID,int port,bool allow,List<IntPtr> memory) {
    Require(allow,"volatile browser policy session is permit-only");
    // FWP_BYTE_BLOB_TYPE is 12, not FWP_SID (13). The blob is the device-path
    // identity returned by WFP for this private clone, not a manually encoded DOS path.
    var conditions=new List<Condition>();
    conditions.Add(new Condition{Key=browserAppID,Value=new Value{Type=12,Pointer=appID}});
    if(allow) {
      conditions.Add(new Condition{Key=remote,Value=new Value{Type=3,Number=0x7f000001}});
      conditions.Add(new Condition{Key=portKey,Value=new Value{Type=2,Number=(ulong)port}});
      conditions.Add(new Condition{Key=browserProtocol,Value=new Value{Type=1,Number=6}});
    }
    int size=Marshal.SizeOf(typeof(Condition));var data=Marshal.AllocHGlobal(size*conditions.Count);memory.Add(data);
    for(int i=0;i<conditions.Count;i++)Marshal.StructureToPtr(conditions[i],IntPtr.Add(data,i*size),false);
    var filter=new Filter{Key=Guid.NewGuid(),Display=Name("Task24 private Chromium network boundary",memory),Flags=allow?8u:0u,Layer=layer,SubLayer=sub,Weight=new Value{Type=1,Number=allow?15ul:1ul},Count=(uint)conditions.Count,Conditions=data,Action=new FilterAction{Type=allow?0x1002u:0x1001u}};
    ulong id;Status(FwpmFilterAdd0(engine,ref filter,IntPtr.Zero,out id),"browser WFP filter");
    return filter.Key;
  }
  static void BrowserDPath(string path) {
    Require(path!=null && path.StartsWith(@"D:\",StringComparison.OrdinalIgnoreCase) && path.IndexOf('\0')<0 && String.Equals(Path.GetFullPath(path),path,StringComparison.OrdinalIgnoreCase),"canonical D-only browser resource");
  }
  static void BrowserExpectedID(string identity) {
    Require(identity!=null && System.Text.RegularExpressions.Regex.IsMatch(identity,@"^[0-9]+:[0-9]+:[0-9]+$"),"exact browser resource identity");
  }
  static void BrowserPinFile(FilePin pin,Dictionary<string,SafeFileHandle> pins,HashSet<string> grantPaths) {
    Require(pin!=null,"browser file pin");BrowserDPath(pin.path);BrowserExpectedID(pin.fileID);
    Require(pin.sha256!=null && System.Text.RegularExpressions.Regex.IsMatch(pin.sha256,@"^[a-f0-9]{64}$"),"browser resource SHA256");
    var handle=Pin(pin.path,false,pin.fileID,false,pins,grantPaths,false);
    using(var stream=new FileStream(new SafeFileHandle(handle.DangerousGetHandle(),false),FileAccess.Read))using(var hash=SHA256.Create()) {
      Require(BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant()==pin.sha256,"browser resource hash");
    }
  }
  static void BrowserMetadataAbsentPath(string path) {
    uint attributes=GetFileAttributesW(path);
    if(attributes!=UInt32.MaxValue)throw new IOException("unexpected browser default profile path exists: "+path);
    int error=Marshal.GetLastWin32Error();
    if(error!=2 && error!=3)throw new Win32Exception(error,"browser default profile path absence is unproven: "+path);
  }
  static void BrowserMetadataProfilePath(string path,string stateRoot) {
    Require(path!=null && path.Length>3 && (path.StartsWith(@"C:\",StringComparison.OrdinalIgnoreCase) || path.StartsWith(@"D:\",StringComparison.OrdinalIgnoreCase)) && path.IndexOf('\0')<0 && path.IndexOf('/')<0 && path.IndexOf(':',2)<0 && String.Equals(Path.GetFullPath(path),path,StringComparison.OrdinalIgnoreCase),"canonical C/D browser profile path: "+path);
    if(path.StartsWith(@"D:\",StringComparison.OrdinalIgnoreCase))Require(String.Equals(path,stateRoot,StringComparison.OrdinalIgnoreCase) || path.StartsWith(stateRoot.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase),"browser profile D path stays within explicit private LOCALAPPDATA: "+path);
  }
  static void BrowserMetadataAbsentPaths(BrowserOwnedMetadata item) {
    foreach(string path in item.DefaultPaths) {BrowserMetadataProfilePath(path,item.StateRoot);BrowserMetadataAbsentPath(path);}
  }
  static void BrowserMetadataLookup(BrowserOwnedMetadata item,bool absent) {
    IntPtr moniker=IntPtr.Zero;int result=AppContainerLookupMoniker(item.Sid,out moniker);
    try {
      // Only this exact not-found HRESULT/null pair was verified on the host.
      // Access errors and other negative HRESULTs are not evidence of absence.
      if(absent) {
        if(result!=unchecked((int)0x80070002) || moniker!=IntPtr.Zero)throw new IOException("browser metadata absence is unproven: "+item.Observation.name+" sid="+item.Observation.sid+" status="+result.ToString("x"));
        return;
      }
      Require(result==0 && moniker!=IntPtr.Zero && String.Equals(Marshal.PtrToStringUni(moniker),item.Observation.name,StringComparison.Ordinal),"exact owned browser metadata moniker: "+item.Observation.name+" sid="+item.Observation.sid);
    } finally {if(moniker!=IntPtr.Zero)AppContainerFreeMemory(moniker);}
  }
  static void BrowserMetadataLock(Action action) {
    // Match Chromium 147's ProfileLock, but do not hold it while Chrome runs.
    using(var mutex=new Mutex(false,"_app_container_profile_lock_0278d671-c445-4dfa-a8b4-d5ccf66d4cc3")) {
      bool held=false;
      try {
        try {held=mutex.WaitOne(30000);}catch(AbandonedMutexException){held=true;throw new IOException("browser metadata mutex was abandoned");}
        Require(held,"browser metadata mutex timeout");action();
      } finally {if(held)mutex.ReleaseMutex();}
    }
  }
  static void BrowserMetadataPrepare(string browser,SafeFileHandle handle,string stateRoot,List<BrowserOwnedMetadata> metadata) {
    // This workaround is tied to the audited source tag. A different version must
    // not be allowed to create a default C-drive profile through a changed code path.
    Require(browser.Length<260 && browser==browser.Trim() && browser.IndexOfAny(new[]{' ','\t','\r','\n','~','/'})<0 && browser.IndexOf(':',2)<0,"exact short browser module path spelling");
    foreach(char character in browser)Require(!Char.IsWhiteSpace(character),"browser module path has no whitespace");
    var final=new StringBuilder(32768);uint count=GetFinalPathNameByHandleW(handle,final,32768,0);
    Require(count>0 && count<32768 && String.Equals(final.ToString(),@"\\?\"+browser,StringComparison.Ordinal),"exact browser module path normalization");
    var version=System.Diagnostics.FileVersionInfo.GetVersionInfo(browser);
    Require(version.FileMajorPart==147 && version.FileMinorPart==0 && version.FileBuildPart==7727 && version.FilePrivatePart==15 && version.FileVersion=="147.0.7727.15","audited browser PE FileVersion 147.0.7727.15");
    BrowserDPath(stateRoot);Require(stateRoot.Length>3,"private browser LOCALAPPDATA state boundary");
    string suffix;using(var hash=SHA1.Create())suffix=BitConverter.ToString(hash.ComputeHash(new UTF8Encoding(false,true).GetBytes(browser))).Replace("-","");
    Guid localAppData=new Guid("f1b32785-6fba-4fcf-9d55-7b8e7f157091");IntPtr folder=IntPtr.Zero;string local;
    try {
      int result=SHGetKnownFolderPath(ref localAppData,0x4000,IntPtr.Zero,out folder);
      Require(result==0 && folder!=IntPtr.Zero,"read actual local application-data KnownFolder without creating it");local=Marshal.PtrToStringUni(folder);
    } finally {if(folder!=IntPtr.Zero)Marshal.FreeCoTaskMem(folder);}
    // Fresh processes with the curated D USERPROFILE can resolve this KnownFolder
    // differently from a host process with cached C-drive KnownFolder state.
    BrowserMetadataProfilePath(local,stateRoot);
    BrowserMetadataLock(()=>{
      // Derive/check all six identities before changing any metadata. Never take
      // ownership of an existing registration, including an exact-name collision.
      foreach(string prefix in new[]{"cr.sb.xr","cr.sb.cdm","cr.sb.net","cr.sb.odm","cr.sb.prnc","cr.sb.pxy"}) {
        string name=prefix+suffix;Require(name.Length<=50,"bounded Chromium metadata name");IntPtr sid=IntPtr.Zero;
        int derived=DeriveAppContainerSidFromAppContainerName(name,out sid);
        if(derived!=0 || sid==IntPtr.Zero) {if(sid!=IntPtr.Zero)FreeSid(sid);throw new IOException("derive browser metadata SID: "+name+" status="+derived.ToString("x"));}
        var item=new BrowserOwnedMetadata{Sid=sid,StateRoot=stateRoot,Observation=new BrowserMetadataRegistration{name=name,sid=new SecurityIdentifier(sid).Value}};item.DefaultPaths.Add(Path.Combine(local,"Packages",name));metadata.Add(item);
        BrowserMetadataAbsentPaths(item);BrowserMetadataLookup(item,true);
      }
      foreach(var item in metadata) {
        BrowserMetadataAbsentPaths(item);BrowserMetadataLookup(item,true);
        int registered=AppContainerRegisterSid(item.Sid,item.Observation.name,item.Observation.name);
        if(registered!=0)throw new IOException("browser metadata registration was not acquired: "+item.Observation.name+" sid="+item.Observation.sid+" status="+registered.ToString("x"));
        item.Registered=true;
        // Query only after successful owned registration: before registration this
        // API reports not-found. It can report a different default root from shell.
        IntPtr profile=IntPtr.Zero;
        try {
          int result=GetAppContainerFolderPath(item.Observation.sid,out profile);
          Require(result==0 && profile!=IntPtr.Zero,"query owned browser default AppContainer profile path: "+item.Observation.name+" status="+result.ToString("x"));
          string actual=Marshal.PtrToStringUni(profile);string parent=actual==null?null:Path.GetDirectoryName(actual);
          bool known=false;foreach(string path in item.DefaultPaths)if(String.Equals(path,parent,StringComparison.OrdinalIgnoreCase))known=true;
          if(!known)item.DefaultPaths.Add(parent);
          BrowserMetadataProfilePath(actual,stateRoot);
          Require(String.Equals(Path.GetFileName(actual),"AC",StringComparison.OrdinalIgnoreCase),"owned browser default profile AC path: "+actual);
        } finally {if(profile!=IntPtr.Zero)Marshal.FreeCoTaskMem(profile);}
        BrowserMetadataLookup(item,false);BrowserMetadataAbsentPaths(item);
      }
    });
  }
  static void BrowserMetadataCleanup(List<BrowserOwnedMetadata> metadata,bool processTreeEnded,List<Exception> errors) {
    bool owned=false;foreach(var item in metadata)if(item.Registered)owned=true;
    if(!owned)return;
    if(!processTreeEnded) {
      foreach(var item in metadata)if(item.Registered)errors.Add(new IOException("owned browser metadata retained because process-tree termination is unproven: "+item.Observation.name+" sid="+item.Observation.sid));
      return;
    }
    Cleanup(()=>BrowserMetadataLock(()=>{
      foreach(var item in metadata)if(item.Registered)Cleanup(()=>{
        bool absent=true;
        // Unexpected data paths are evidence to report, never deletion targets.
        // Their presence must not prevent unregistering our exact owned metadata.
        foreach(string path in item.DefaultPaths)try {BrowserMetadataProfilePath(path,item.StateRoot);BrowserMetadataAbsentPath(path);}catch(Exception error){absent=false;errors.Add(error);}
        BrowserMetadataLookup(item,false);
        IntPtr derived=IntPtr.Zero;
        try {
          int result=DeriveAppContainerSidFromAppContainerName(item.Observation.name,out derived);
          Require(result==0 && derived!=IntPtr.Zero && new SecurityIdentifier(derived).Value==item.Observation.sid && new SecurityIdentifier(item.Sid).Value==item.Observation.sid,"exact owned browser metadata SID before unregister: "+item.Observation.name);
        } finally {if(derived!=IntPtr.Zero)FreeSid(derived);}
        int unregistered=AppContainerUnregisterSid(item.Sid);
        if(unregistered!=0)throw new IOException("unregister exact owned browser metadata: "+item.Observation.name+" sid="+item.Observation.sid+" status="+unregistered.ToString("x"));
        BrowserMetadataLookup(item,true);item.Observation.unregistered=true;
        foreach(string path in item.DefaultPaths)try {BrowserMetadataProfilePath(path,item.StateRoot);BrowserMetadataAbsentPath(path);}catch(Exception error){absent=false;errors.Add(error);}
        item.Observation.defaultPathAbsent=absent;
      },errors);
    }),errors);
  }
  static string[] BrowserCommandLine(IntPtr process,BrowserQueryProcess query) {
    uint required;int status=query(process,60,IntPtr.Zero,0,out required);
    if(status>=0 || (status!=unchecked((int)0xc0000004) && status!=unchecked((int)0xc0000023)))throw new IOException("browser command-line size status="+status.ToString("x"));
    Require(required>=Marshal.SizeOf(typeof(BrowserUnicodeString)) && required<=1048576,"bounded browser command line");
    var value=Marshal.AllocHGlobal((int)required);
    try {
      uint actual;status=query(process,60,value,required,out actual);
      if(status<0)throw new IOException("browser command-line query status="+status.ToString("x"));
      Require(actual<=required,"browser command-line returned size");
      var text=(BrowserUnicodeString)Marshal.PtrToStructure(value,typeof(BrowserUnicodeString));
      long offset=text.Buffer.ToInt64()-value.ToInt64();
      Require((text.Length&1)==0 && text.Length<=text.MaximumLength && offset>=Marshal.SizeOf(typeof(BrowserUnicodeString)) && offset<=required && text.Length<=required-offset,"browser command-line returned pointer");
      string command=Marshal.PtrToStringUni(text.Buffer,text.Length/2);
      Require(command.IndexOf('\0')<0,"browser command-line null");
      int count;var arguments=CommandLineToArgvW(command,out count);Require(arguments!=IntPtr.Zero,"parse actual browser command line");
      try {
        Require(count>0 && count<=4096,"bounded browser argument count");var result=new string[count];
        for(int i=0;i<count;i++)result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(arguments,i*IntPtr.Size));
        return result;
      } finally {Require(LocalFree(arguments)==IntPtr.Zero,"free browser arguments");}
    } finally {Marshal.FreeHGlobal(value);}
  }
  static BrowserRenderer BrowserToken(IntPtr process,uint pid) {
    IntPtr token;Require(OpenProcessToken(process,8,out token),"renderer primary token");
    try {
      var flag=Marshal.AllocHGlobal(4);
      try {
        int required;Require(GetTokenInformation(token,29,flag,4,out required) && required==4,"renderer AppContainer token information");
        bool appContainer=Marshal.ReadInt32(flag)!=0;
        // IsTokenRestricted only reports restricting SIDs; TokenHasRestrictions is
        // deliberately not used as a substitute for the actual restricted-token test.
        bool restricted=IsTokenRestricted(token);
        GetTokenInformation(token,25,IntPtr.Zero,0,out required);
        Require(required>=Marshal.SizeOf(typeof(SidAttributes)) && required<=65536,"bounded renderer integrity information");
        var label=Marshal.AllocHGlobal(required);
        try {
          int actual;Require(GetTokenInformation(token,25,label,required,out actual) && actual<=required,"renderer integrity information");
          var sid=((SidAttributes)Marshal.PtrToStructure(label,typeof(SidAttributes))).Sid;
          long offset=sid.ToInt64()-label.ToInt64();
          Require(offset>=Marshal.SizeOf(typeof(SidAttributes)) && offset<=actual-8,"renderer integrity SID pointer");
          byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
          Require(count>0 && offset+8+4*count<=actual && IsValidSid(sid),"renderer integrity SID");
          uint integrity=unchecked((uint)Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)count-1)));
          Require(integrity<=Int32.MaxValue && new SecurityIdentifier(sid).Value=="S-1-16-"+integrity,"renderer integrity RID");
          return new BrowserRenderer{pid=pid,appContainer=appContainer,restricted=restricted,integrity=(int)integrity};
        } finally {Marshal.FreeHGlobal(label);}
      } finally {Marshal.FreeHGlobal(flag);}
    } finally {Require(CloseHandle(token),"close renderer token");}
  }
  static void BrowserObserve(IntPtr job,string browser,BrowserQueryProcess query,Dictionary<uint,BrowserRenderer> renderers) {
    int bytes=8+64*IntPtr.Size;var list=Marshal.AllocHGlobal(bytes);
    try {
      Require(QueryInformationJobObject(job,3,list,(uint)bytes,IntPtr.Zero),"owned browser job process list");
      int assigned=Marshal.ReadInt32(list),count=Marshal.ReadInt32(list,4);
      Require(assigned>=0 && count>=0 && assigned==count && count<=64,"complete owned browser job process list");
      for(int i=0;i<count;i++) {
        ulong raw=unchecked((ulong)Marshal.ReadIntPtr(list,8+i*IntPtr.Size).ToInt64());Require(raw>0 && raw<=UInt32.MaxValue,"owned browser PID");uint pid=(uint)raw;
        var process=OpenProcess(0x1000|0x100000,false,pid);
        if(process==IntPtr.Zero) {
          int error=Marshal.GetLastWin32Error();
          // A PID can disappear between the owned job snapshot and OpenProcess.
          // Access denied is not disappearance and must never become a positive observation.
          if(error==87)continue;
          throw new Win32Exception(error,"open owned browser process");
        }
        try {
          if(WaitForSingleObject(process,0)==0)continue;
          bool policyViolation=false;
          try {
            bool member;Require(IsProcessInJob(process,job,out member),"verify owned browser process membership");
            if(!member)continue;
            var image=new StringBuilder(32768);uint length=32768;
            Require(QueryFullProcessImageNameW(process,0,image,ref length),"owned browser image path");
            if(!String.Equals(image.ToString(),browser,StringComparison.OrdinalIgnoreCase))continue;
            var arguments=BrowserCommandLine(process,query);bool renderer=false;
            foreach(string argument in arguments) {
              if(String.Equals(argument,"--no-sandbox",StringComparison.OrdinalIgnoreCase) || argument.StartsWith("--no-sandbox=",StringComparison.OrdinalIgnoreCase)) {policyViolation=true;throw new IOException("Chromium native sandbox must remain enabled");}
              if(argument=="--type=renderer")renderer=true;
            }
            if(!renderer)continue;
            var observed=BrowserToken(process,pid);BrowserRenderer prior;
            if(renderers.TryGetValue(pid,out prior)) {
              // Keep weaker observed properties instead of concealing them behind a
              // later token sample. These are observations, not universal guarantees.
              prior.appContainer=prior.appContainer && observed.appContainer;
              prior.restricted=prior.restricted && observed.restricted;
              prior.integrity=Math.Max(prior.integrity,observed.integrity);
            } else {Require(renderers.Count<4096,"bounded renderer observations");renderers.Add(pid,observed);}
          } catch(Exception error) {
            if(policyViolation)throw;
            // Teardown can race introspection before the process becomes signaled.
            // A failed query is never a renderer observation: skip only after the
            // same already-owned process handle proves completed termination.
            uint exited=WaitForSingleObject(process,1000);
            if(exited!=0)throw new IOException("owned browser process introspection failed pid="+pid+" exitWait="+exited.ToString("x"),error);
          }
        } finally {Require(CloseHandle(process),"close owned browser process");}
      }
    } finally {Marshal.FreeHGlobal(list);}
  }
  static bool BrowserJobEnded(IntPtr job) {
    var accounting=Marshal.AllocHGlobal(48);
    try {
      for(int i=0;i<500;i++) {
        Require(QueryInformationJobObject(job,1,accounting,48,IntPtr.Zero),"browser job accounting");
        if(Marshal.ReadInt32(accounting,40)==0)return true;
        Thread.Sleep(10);
      }
      return false;
    } finally {Marshal.FreeHGlobal(accounting);}
  }
  static byte[] BrowserRead(SafeFileHandle pipe,int limit,IntPtr job,Action truncate) {
    using(var stream=new FileStream(pipe,FileAccess.Read,8192,false))using(var output=new MemoryStream()) {
      var buffer=new byte[8192];int count;
      try {
        while((count=stream.Read(buffer,0,buffer.Length))>0) {
          int keep=Math.Min(count,limit-(int)output.Length);if(keep>0)output.Write(buffer,0,keep);
          if(keep<count){truncate();Require(TerminateJobObject(job,125),"terminate truncated browser job");break;}
        }
      } catch(IOException){}
      return output.ToArray();
    }
  }

  public static string RunBrowser(string exe,string[] argv,string cwd,string environment,string input,int timeout,int outLimit,int errLimit,string pinsJSON,int[] ports) {
    IntPtr engine=IntPtr.Zero,appID=IntPtr.Zero,job=IntPtr.Zero,attributes=IntPtr.Zero,env=IntPtr.Zero;
    IntPtr ri=IntPtr.Zero,wi=IntPtr.Zero,ro=IntPtr.Zero,wo=IntPtr.Zero,re=IntPtr.Zero,we=IntPtr.Zero;
    var memory=new List<IntPtr>();var pins=new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);var grantPaths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var serializer=new JavaScriptSerializer{MaxJsonLength=4194304};var plan=serializer.Deserialize<BrowserPinPlan>(pinsJSON);
    var renderers=new Dictionary<uint,BrowserRenderer>();var metadata=new List<BrowserOwnedMetadata>();var pi=new PI();PersistentPolicy policy=null;
    SafeFileHandle outPipe=null,errPipe=null,inPipe=null;
    Thread outThread=null,errThread=null,inThread=null;byte[] stdout=new byte[0],stderr=new byte[0];int truncated=0,cancelled=0;bool ended=false,started=false,networkApplied=false,attributesInitialized=false;uint exit=125;
    Exception failure=null;var streamFailures=new List<Exception>();
    var watcher=new Thread(()=>{try{Console.In.ReadLine();}finally{Interlocked.Exchange(ref cancelled,1);}});watcher.IsBackground=true;watcher.Start();
    try {
      Require(IntPtr.Size==8 && plan!=null && plan.directories!=null && plan.readonlyRoots!=null && argv!=null && ports!=null,"browser pin plan");
      Require(timeout>0 && timeout<=600000 && outLimit>0 && outLimit<=2097152 && errLimit>0 && errLimit<=65536,"browser execution bounds");
      var payload=Convert.FromBase64String(input);Require(payload.Length<=2097152,"bounded browser input");
      BrowserDPath(exe);BrowserDPath(cwd);Require(plan.exe!=null && String.Equals(exe,plan.exe.path,StringComparison.OrdinalIgnoreCase),"browser controller executable pin");
      var directories=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      foreach(var directory in plan.directories) {
        Require(directory!=null,"browser directory pin");BrowserDPath(directory.path);BrowserExpectedID(directory.fileID);
        Pin(directory.path,true,directory.fileID,false,pins,grantPaths,false);directories.Add(directory.path);
      }
      Require(directories.Contains(cwd),"browser working directory pin");
      BrowserPinFile(plan.exe,pins,grantPaths);BrowserPinFile(plan.helper,pins,grantPaths);BrowserPinFile(plan.browser,pins,grantPaths);
      bool browserResources=false;int entries=0;
      foreach(string root in plan.readonlyRoots) {
        BrowserDPath(root);Require(directories.Contains(root),"browser readonly root pin");
        PinTree(root,false,pins,grantPaths,0,ref entries);
        if(plan.browser.path.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase))browserResources=true;
      }
      Require(browserResources,"private browser resource tree is held readonly");
      // The helper is controller-owned trusted code. Only Chromium's native renderer
      // sandbox executes page code; this normal-token broker is not an AppContainer.
      bool helperArgument=false;foreach(string argument in argv)if(String.Equals(argument,plan.helper.path,StringComparison.OrdinalIgnoreCase))helperArgument=true;
      Require(helperArgument,"pinned browser helper argument");
      var uniquePorts=new HashSet<int>();foreach(int port in ports)Require(port>=1024 && port<=65535 && uniquePorts.Add(port),"browser network port");
      var module=GetModuleHandleW("ntdll.dll");Require(module!=IntPtr.Zero,"browser token inspection module");
      var entry=GetProcAddress(module,"NtQueryInformationProcess");Require(entry!=IntPtr.Zero,"browser token inspection entry point");
      var query=(BrowserQueryProcess)Marshal.GetDelegateForFunctionPointer(entry,typeof(BrowserQueryProcess));
      if(Interlocked.CompareExchange(ref cancelled,0,0)!=0)throw new OperationCanceledException("browser controller disconnected before launch");
      Status(FwpmGetAppIdFromFileName0(plan.browser.path,out appID),"private browser WFP application identity");Require(appID!=IntPtr.Zero,"private browser WFP identity blob");
      PolicyCreate(exe,plan.policyJournal,plan.exe,plan.browser,plan.directories,pins,"appid",plan.browser.path,PolicyAppBytes(appID),ref policy);
      var session=new Session{Key=Guid.NewGuid(),Flags=1,Display=Name("Task24 dynamic Chromium policy",memory)};
      Status(FwpmEngineOpen0(null,10,IntPtr.Zero,ref session,out engine),"browser WFP open");
      foreach(int port in ports)BrowserFilter(engine,PolicyGuid(policy.Intent.sublayer.key),policyV4,appID,port,true,memory);networkApplied=true;
      job=PolicyCreateJob(policy);
      var limits=new Limits{Basic=new Basic{Flags=0x2000|0x8|0x200,Active=64},JobMemory=(UIntPtr)(2ul*1024*1024*1024)};
      Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)),"browser job limits");
      var sa=new SA{Size=Marshal.SizeOf(typeof(SA)),Inherit=1};
      Require(CreatePipe(out ri,out wi,ref sa,0) && CreatePipe(out ro,out wo,ref sa,0) && CreatePipe(out re,out we,ref sa,0),"browser stdio pipes");
      Require(SetHandleInformation(wi,1,0) && SetHandleInformation(ro,1,0) && SetHandleInformation(re,1,0),"browser pipe inheritance");
      IntPtr size=IntPtr.Zero;InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);Require(size!=IntPtr.Zero,"browser attribute size");attributes=Marshal.AllocHGlobal(size);
      Require(InitializeProcThreadAttributeList(attributes,2,0,ref size),"browser attributes");attributesInitialized=true;
      var handles=Marshal.AllocHGlobal(IntPtr.Size*3);memory.Add(handles);Marshal.WriteIntPtr(handles,0,ri);Marshal.WriteIntPtr(handles,IntPtr.Size,wo);Marshal.WriteIntPtr(handles,IntPtr.Size*2,we);
      Require(UpdateProcThreadAttribute(attributes,0,(IntPtr)0x20002,handles,(IntPtr)(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero),"browser explicit stdio handles");
      var jobList=Marshal.AllocHGlobal(IntPtr.Size);memory.Add(jobList);Marshal.WriteIntPtr(jobList,job);
      Require(UpdateProcThreadAttribute(attributes,0,(IntPtr)0x2000d,jobList,(IntPtr)IntPtr.Size,IntPtr.Zero,IntPtr.Zero),"browser atomic job assignment");
      var vars=serializer.Deserialize<Dictionary<string,string>>(environment);Require(vars!=null && vars.Count<=64,"browser environment");
      var names=new List<string>(vars.Keys);names.Sort(StringComparer.OrdinalIgnoreCase);var block=new StringBuilder();
      foreach(string name in names) {Require(name.Length>0 && name.IndexOf('=')<0 && name.IndexOf('\0')<0 && vars[name]!=null && vars[name].IndexOf('\0')<0,"browser explicit environment");block.Append(name).Append('=').Append(vars[name]).Append('\0');}
      block.Append('\0');Require(block.Length<=262144,"bounded browser environment");env=Marshal.StringToHGlobalUni(block.ToString());
      var sx=new SX{Info=new SI{Size=Marshal.SizeOf(typeof(SX)),Flags=0x100,In=ri,Out=wo,Err=we},Attributes=attributes};
      var command=new StringBuilder(Quote(exe));foreach(string argument in argv)command.Append(' ').Append(Quote(argument));Require(command.Length<32767,"bounded browser controller command line");
      Require(vars.ContainsKey("LOCALAPPDATA"),"explicit private browser LOCALAPPDATA");
      BrowserMetadataPrepare(plan.browser.path,pins[plan.browser.path],vars["LOCALAPPDATA"],metadata);
      if(Interlocked.CompareExchange(ref cancelled,0,0)!=0)throw new OperationCanceledException("browser controller disconnected after metadata registration");
      Require(CreateProcessW(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x80000|0x400|0x4|0x08000000,env,cwd,ref sx,out pi),"trusted browser controller CreateProcess");started=true;
      Require(CloseHandle(ri),"close browser child stdin copy");ri=IntPtr.Zero;Require(CloseHandle(wo),"close browser child stdout copy");wo=IntPtr.Zero;Require(CloseHandle(we),"close browser child stderr copy");we=IntPtr.Zero;
      outPipe=new SafeFileHandle(ro,true);ro=IntPtr.Zero;errPipe=new SafeFileHandle(re,true);re=IntPtr.Zero;inPipe=new SafeFileHandle(wi,true);wi=IntPtr.Zero;
      Action<Exception> streamFailure=error=>{lock(streamFailures)streamFailures.Add(error);TerminateJobObject(job,125);};
      outThread=new Thread(()=>{try{stdout=BrowserRead(outPipe,outLimit,job,()=>Interlocked.Exchange(ref truncated,1));}catch(Exception error){streamFailure(error);}});outThread.IsBackground=true;outThread.Start();
      errThread=new Thread(()=>{try{stderr=BrowserRead(errPipe,errLimit,job,()=>Interlocked.Exchange(ref truncated,1));}catch(Exception error){streamFailure(error);}});errThread.IsBackground=true;errThread.Start();
      inThread=new Thread(()=>{try{using(var stream=new FileStream(inPipe,FileAccess.Write,8192,false))stream.Write(payload,0,payload.Length);}catch(IOException){}catch(Exception error){streamFailure(error);}});inThread.IsBackground=true;inThread.Start();
      if(Interlocked.CompareExchange(ref cancelled,0,0)!=0)exit=130;
      else {
        Require(ResumeThread(pi.Thread)!=0xffffffff,"resume trusted browser controller");var elapsed=System.Diagnostics.Stopwatch.StartNew();
        for(;;) {
          BrowserObserve(job,plan.browser.path,query,renderers);
          if(Interlocked.CompareExchange(ref cancelled,0,0)!=0){exit=130;break;}
          uint waited=WaitForSingleObject(pi.Process,10);
          if(waited==0){Require(GetExitCodeProcess(pi.Process,out exit),"browser controller exit code");BrowserObserve(job,plan.browser.path,query,renderers);break;}
          Require(waited==0x102,"wait trusted browser controller");
          if(elapsed.ElapsedMilliseconds>=timeout){exit=124;Interlocked.Exchange(ref truncated,1);break;}
        }
      }
    } catch(OperationCanceledException){exit=130;} catch(Exception error){failure=error;} finally {
      var errors=new List<Exception>();
      if(job!=IntPtr.Zero)Cleanup(()=>Require(TerminateJobObject(job,exit),"end browser job descendants"),errors);
      if(job!=IntPtr.Zero)Cleanup(()=>{ended=BrowserJobEnded(job);Require(ended,"all browser job children ended");},errors);
      BrowserMetadataCleanup(metadata,ended||!started,errors);
      foreach(var thread in new[]{outThread,errThread,inThread})if(thread!=null)Cleanup(()=>Require(thread.Join(5000),"bounded browser stdio join"),errors);
      foreach(var pipe in new[]{outPipe,errPipe,inPipe})if(pipe!=null)Cleanup(()=>pipe.Dispose(),errors);
      lock(streamFailures)errors.AddRange(streamFailures);
      foreach(var handle in new[]{pi.Thread,pi.Process,ri,wi,ro,wo,re,we})if(handle!=IntPtr.Zero)Cleanup(()=>Require(CloseHandle(handle),"close browser controller handle"),errors);
      if(attributes!=IntPtr.Zero)Cleanup(()=>{if(attributesInitialized)DeleteProcThreadAttributeList(attributes);Marshal.FreeHGlobal(attributes);},errors);
      if(env!=IntPtr.Zero)Cleanup(()=>Marshal.FreeHGlobal(env),errors);
      bool permitsClosed=engine==IntPtr.Zero;
      if(engine!=IntPtr.Zero)Cleanup(()=>{Status(FwpmEngineClose0(engine),"close browser volatile permit WFP session");engine=IntPtr.Zero;permitsClosed=true;},errors);
      // Abnormal cleanup closes only volatile permits. The exact persistent deny
      // survives until empty-job proof and exact transactional retirement succeed.
      PolicyFinish(policy,ended||!started,permitsClosed,job,started,errors);
      if(job!=IntPtr.Zero)Cleanup(()=>Require(CloseHandle(job),"close browser owned named job"),errors);
      if(appID!=IntPtr.Zero)Cleanup(()=>FwpmFreeMemory0(ref appID),errors);
      foreach(var item in metadata)if(item.Sid!=IntPtr.Zero)Cleanup(()=>{Require(FreeSid(item.Sid)==IntPtr.Zero,"free browser metadata SID");item.Sid=IntPtr.Zero;},errors);
      foreach(var handle in pins.Values)Cleanup(()=>handle.Dispose(),errors);
      foreach(var allocation in memory)Cleanup(()=>Marshal.FreeHGlobal(allocation),errors);
      if(errors.Count>0){if(failure!=null)errors.Insert(0,failure);var observed=new List<BrowserMetadataRegistration>();foreach(var item in metadata)if(item.Registered)observed.Add(item.Observation);failure=new AggregateException("browser isolation cleanup failed; policyJournal="+(policy==null?"":policy.JournalPath)+"; owned metadata="+serializer.Serialize(observed),errors);}
    }
    if(failure!=null)throw failure;
    var registrations=new List<BrowserMetadataRegistration>();foreach(var item in metadata)if(item.Registered)registrations.Add(item.Observation);
    return serializer.Serialize(new {started=started,exitCode=(int)exit,stdout=Convert.ToBase64String(stdout),stderr=Convert.ToBase64String(stderr),truncated=truncated!=0,containment=new {processTreeEnded=ended||!started,dynamicNetworkPolicy=networkApplied,cleanupCompleted=true,browserPath=plan.browser.path,renderers=new List<BrowserRenderer>(renderers.Values),metadataRegistrations=registrations,persistentNetworkPolicy=policy!=null && policy.Committed,persistentPolicyRetired=policy==null || policy.Retired,policyJournal=policy==null?"":policy.JournalPath}});
  }
}
