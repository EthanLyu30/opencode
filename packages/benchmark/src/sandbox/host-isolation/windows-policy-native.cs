public static partial class Task24NativeIsolation {
  public sealed class PersistentPolicyLayer { public string key,name; public uint flags; public ushort weight; }
  public sealed class PersistentPolicyFilter { public string key,name,layer; public uint flags,action,weight; }
  public sealed class PersistentPolicyIntent {
    public int version; public string policyJournal,nonce,kind,identity,conditionBytes,conditionKey,jobName,supervisorCreatedFileTime;
    public uint conditionType,supervisorPID; public FilePin controller,primary,owner; public DirectoryPin root;
    public PersistentPolicyLayer sublayer; public PersistentPolicyFilter[] filters;
  }
  sealed class PersistentPolicy {
    public PersistentPolicyIntent Intent; public string JournalPath; public IntPtr Engine;
    public bool CanOwn,Committed,Retired;
  }
  sealed class PersistentPolicyObjects { public bool sublayer,ipv4,ipv6; }
  [DllImport("fwpuclnt.dll",CharSet=CharSet.Unicode)] static extern uint FwpmGetAppIdFromFileName0(string path,out IntPtr appID);
  [DllImport("fwpuclnt.dll")] static extern void FwpmFreeMemory0(ref IntPtr memory);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionBegin0(IntPtr engine,uint flags);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionCommit0(IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmTransactionAbort0(IntPtr engine);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterGetByKey0(IntPtr engine,ref Guid key,out IntPtr filter);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerGetByKey0(IntPtr engine,ref Guid key,out IntPtr layer);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmFilterDeleteByKey0(IntPtr engine,ref Guid key);
  [DllImport("fwpuclnt.dll")] static extern uint FwpmSubLayerDeleteByKey0(IntPtr engine,ref Guid key);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObjectW(uint access,bool inherit,string name);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out long created,out long exited,out long kernel,out long user);
  static readonly Guid policyV4=new Guid("c38d57d1-05a7-4c33-904f-7fbceee60e82"),policyV6=new Guid("4a72393b-319f-44bc-84c3-ba54dcb3b6b4"),policyAppID=new Guid("d78e1e87-8644-4ea5-9437-d809ecefc971"),policyProtocol=new Guid("3971ef2b-623e-4f9a-8cb1-6e79b806b9a7");

  static void PolicyRequire(bool ok,string operation) {if(!ok)throw new IOException(operation);}
  static void PolicyDPath(string path) {
    PolicyRequire(path!=null && path.Length>3 && path.StartsWith(@"D:\",StringComparison.OrdinalIgnoreCase) && path.IndexOf('\0')<0 && path.IndexOf('/')<0 && path.IndexOf(':',2)<0 && String.Equals(Path.GetFullPath(path),path,StringComparison.OrdinalIgnoreCase),"canonical private D policy path");
  }
  static void PolicyFilePlan(FilePin pin) {
    PolicyRequire(pin!=null,"policy file pin");PolicyDPath(pin.path);
    PolicyRequire(pin.fileID!=null && System.Text.RegularExpressions.Regex.IsMatch(pin.fileID,@"^[0-9]+:[0-9]+:[0-9]+$") && pin.sha256!=null && System.Text.RegularExpressions.Regex.IsMatch(pin.sha256,@"^[a-f0-9]{64}$"),"exact policy file identity/SHA256");
  }
  static bool PolicyInside(string path,string root) {return path.StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase);}
  static byte[] PolicyRead(SafeFileHandle handle,int limit) {
    using(var stream=new FileStream(new SafeFileHandle(handle.DangerousGetHandle(),false),FileAccess.Read))using(var output=new MemoryStream()) {
      PolicyRequire(stream.Length<=limit,"bounded policy file");stream.Position=0;
      var buffer=new byte[8192];int count;
      while((count=stream.Read(buffer,0,buffer.Length))>0) {PolicyRequire(output.Length+count<=limit,"bounded policy read");output.Write(buffer,0,count);}
      return output.ToArray();
    }
  }
  static string PolicyHash(byte[] bytes) {using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
  static FilePin PolicyCapture(string path,SafeFileHandle handle,int limit) {
    FileInfo info;Require(GetFileInformationByHandle(handle,out info),"capture policy-owned file identity");
    return new FilePin{path=path,fileID=info.Volume+":"+(((ulong)info.IndexHi<<32)|info.IndexLo)+":0",sha256=PolicyHash(PolicyRead(handle,limit))};
  }
  static SafeFileHandle PolicyPinFile(FilePin pin,Dictionary<string,SafeFileHandle> pins,long maxLength=Int64.MaxValue) {
    PolicyFilePlan(pin);var handle=Pin(pin.path,false,pin.fileID,false,pins,new HashSet<string>(StringComparer.OrdinalIgnoreCase),false);
    using(var stream=new FileStream(new SafeFileHandle(handle.DangerousGetHandle(),false),FileAccess.Read))using(var hash=SHA256.Create()) {
      PolicyRequire(stream.Length<=maxLength,"bounded pinned policy file: "+pin.path);stream.Position=0;PolicyRequire(BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant()==pin.sha256,"policy-owned file hash changed: "+pin.path);
    }
    return handle;
  }
  static byte[] PolicySidBytes(IntPtr sid) {var identity=new SecurityIdentifier(sid);var bytes=new byte[identity.BinaryLength];identity.GetBinaryForm(bytes,0);return bytes;}
  static byte[] PolicyAppBytes(IntPtr appID) {
    PolicyRequire(appID!=IntPtr.Zero,"policy application blob");var blob=(Blob)Marshal.PtrToStructure(appID,typeof(Blob));
    PolicyRequire(blob.Size>0 && blob.Size<=65536 && blob.Data!=IntPtr.Zero,"bounded policy application bytes");var bytes=new byte[blob.Size];Marshal.Copy(blob.Data,bytes,0,bytes.Length);return bytes;
  }
  static IntPtr PolicyOpenEngine() {
    var memory=new List<IntPtr>();
    try {var session=new Session{Key=Guid.NewGuid(),Flags=0,Timeout=5000,Display=Name("Task24 exact persistent deny policy",memory)};IntPtr engine;Status(FwpmEngineOpen0(null,10,IntPtr.Zero,ref session,out engine),"open non-dynamic policy engine");PolicyRequire(engine!=IntPtr.Zero,"persistent policy engine handle");return engine;}
    finally {foreach(var pointer in memory)Marshal.FreeHGlobal(pointer);}
  }
  static void PolicyTransaction(IntPtr engine,uint flags,Action action) {
    Status(FwpmTransactionBegin0(engine,flags),"begin exact policy transaction");
    try {action();Status(FwpmTransactionCommit0(engine),"commit exact policy transaction");}
    catch(Exception error) {uint aborted=FwpmTransactionAbort0(engine);if(aborted!=0)throw new AggregateException("policy transaction failed and explicit abort was not confirmed",error,new IOException("policy abort="+aborted.ToString("x")));throw;}
  }
  static Guid PolicyGuid(string text) {Guid result=Guid.Empty;PolicyRequire(text!=null && Guid.TryParseExact(text,"D",out result) && result!=Guid.Empty,"exact journal object GUID");return result;}
  static string PolicyText(IntPtr pointer) {return pointer==IntPtr.Zero?"":Marshal.PtrToStringUni(pointer);}
  static bool PolicyLayerPresent(IntPtr engine,PersistentPolicyIntent intent) {
    var key=PolicyGuid(intent.sublayer.key);IntPtr pointer=IntPtr.Zero;uint status=FwpmSubLayerGetByKey0(engine,ref key,out pointer);
    try {
      if(status==0x80320007u){PolicyRequire(pointer==IntPtr.Zero,"not-found policy sublayer pointer");return false;}
      Status(status,"read exact policy sublayer");PolicyRequire(pointer!=IntPtr.Zero,"policy sublayer result");var actual=(SubLayer)Marshal.PtrToStructure(pointer,typeof(SubLayer));
      // BFE assigns the closest available sublayer weight; the requested weight
      // is not an exact ownership field. Own permits/denies still share this GUID.
      // https://github.com/MicrosoftDocs/win32/blob/docs/desktop-src/FWP/installing-a-provider.md
      PolicyRequire(actual.Key==key && actual.Flags==intent.sublayer.flags && actual.Flags==1 && actual.Provider==IntPtr.Zero && actual.Data.Size==0 && PolicyText(actual.Display.Name)==intent.sublayer.name && PolicyText(actual.Display.Description)=="","foreign or altered persistent policy sublayer: "+key+" actual="+new JavaScriptSerializer().Serialize(new {key=actual.Key,flags=actual.Flags,weight=actual.Weight,providerNull=actual.Provider==IntPtr.Zero,dataSize=actual.Data.Size,dataPointerNull=actual.Data.Data==IntPtr.Zero,name=PolicyText(actual.Display.Name),description=PolicyText(actual.Display.Description)}));
      return true;
    } finally {if(pointer!=IntPtr.Zero)FwpmFreeMemory0(ref pointer);}
  }
  static bool PolicyFilterPresent(IntPtr engine,PersistentPolicyIntent intent,PersistentPolicyFilter expected) {
    var key=PolicyGuid(expected.key);IntPtr pointer=IntPtr.Zero;uint status=FwpmFilterGetByKey0(engine,ref key,out pointer);
    try {
      if(status==0x80320003u){PolicyRequire(pointer==IntPtr.Zero,"not-found policy filter pointer");return false;}
      Status(status,"read exact policy filter");PolicyRequire(pointer!=IntPtr.Zero,"policy filter result");var actual=(Filter)Marshal.PtrToStructure(pointer,typeof(Filter));
      // Ignore only the operational FWPM_FILTER_FLAG_INDEXED (0x40) bit BFE adds
      // for faster lookup; it does not alter this deny's scope or action.
      // DISABLED (0x20) and every other unexpected flag remain disallowed.
      // https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_filter0
      PolicyRequire(actual.Key==key && (actual.Flags&~0x40u)==expected.flags && (actual.Flags&~0x40u)==1 && actual.Provider==IntPtr.Zero && actual.Data.Size==0 && actual.Layer==PolicyGuid(expected.layer) && actual.SubLayer==PolicyGuid(intent.sublayer.key) && actual.Weight.Type==1 && (byte)actual.Weight.Number==expected.weight && actual.Action.Type==expected.action && actual.Action.Type==0x1001 && actual.Action.Callout==Guid.Empty && actual.Context.Raw==0 && actual.Reserved==IntPtr.Zero && actual.Count==1 && actual.Conditions!=IntPtr.Zero && PolicyText(actual.Display.Name)==expected.name && PolicyText(actual.Display.Description)=="","foreign or altered persistent policy filter: "+key+" actual="+new JavaScriptSerializer().Serialize(new {key=actual.Key,flags=actual.Flags,providerNull=actual.Provider==IntPtr.Zero,dataSize=actual.Data.Size,dataPointerNull=actual.Data.Data==IntPtr.Zero,layer=actual.Layer,sublayer=actual.SubLayer,weightType=actual.Weight.Type,weightNumber=actual.Weight.Number,weightByte=(byte)actual.Weight.Number,actionType=actual.Action.Type,actionCallout=actual.Action.Callout,contextRaw=actual.Context.Raw,reservedNull=actual.Reserved==IntPtr.Zero,conditionCount=actual.Count,conditionsNull=actual.Conditions==IntPtr.Zero,name=PolicyText(actual.Display.Name),description=PolicyText(actual.Display.Description)}));
      var condition=(Condition)Marshal.PtrToStructure(actual.Conditions,typeof(Condition));
      PolicyRequire(condition.Key==PolicyGuid(intent.conditionKey) && condition.Match==0 && condition.Value.Type==intent.conditionType && condition.Value.Pointer!=IntPtr.Zero,"foreign or altered policy condition: "+key+" actual="+new JavaScriptSerializer().Serialize(new {key=condition.Key,match=condition.Match,valueType=condition.Value.Type,valuePointerNull=condition.Value.Pointer==IntPtr.Zero}));
      byte[] bytes=intent.conditionType==13?PolicySidBytes(condition.Value.Pointer):PolicyAppBytes(condition.Value.Pointer);
      PolicyRequire(Convert.ToBase64String(bytes)==intent.conditionBytes,"foreign or altered policy condition identity bytes: "+key);
      return true;
    } finally {if(pointer!=IntPtr.Zero)FwpmFreeMemory0(ref pointer);}
  }
  static PersistentPolicyObjects PolicyObjects(IntPtr engine,PersistentPolicyIntent intent) {
    var objects=new PersistentPolicyObjects{sublayer=PolicyLayerPresent(engine,intent),ipv4=PolicyFilterPresent(engine,intent,intent.filters[0]),ipv6=PolicyFilterPresent(engine,intent,intent.filters[1])};
    int count=(objects.sublayer?1:0)+(objects.ipv4?1:0)+(objects.ipv6?1:0);PolicyRequire(count==0 || count==3,"partial persistent policy is uncertain; retain journal and all remaining objects");return objects;
  }
  static void PolicyAddBlock(IntPtr engine,PersistentPolicyIntent intent,PersistentPolicyFilter expected,List<IntPtr> memory) {
    var bytes=Convert.FromBase64String(intent.conditionBytes);var data=Marshal.AllocHGlobal(bytes.Length);memory.Add(data);Marshal.Copy(bytes,0,data,bytes.Length);
    IntPtr identity=intent.conditionType==13?data:Struct(new Blob{Size=(uint)bytes.Length,Data=data},memory);
    var conditions=Struct(new Condition{Key=PolicyGuid(intent.conditionKey),Value=new Value{Type=intent.conditionType,Pointer=identity}},memory);
    var filter=new Filter{Key=PolicyGuid(expected.key),Display=Name(expected.name,memory),Flags=1,Layer=PolicyGuid(expected.layer),SubLayer=PolicyGuid(intent.sublayer.key),Weight=new Value{Type=1,Number=1},Count=1,Conditions=conditions,Action=new FilterAction{Type=0x1001}};
    ulong id;Status(FwpmFilterAdd0(engine,ref filter,IntPtr.Zero,out id),"add exact persistent deny filter");
  }
  static void PolicyValidateIntent(PersistentPolicyIntent intent,string path) {
    PolicyRequire(intent!=null && intent.version==1 && intent.nonce!=null && System.Text.RegularExpressions.Regex.IsMatch(intent.nonce,@"^[a-f0-9]{32}$"),"persistent policy journal version/nonce");
    PolicyDPath(path);PolicyRequire(intent.root!=null && intent.root.fileID!=null,"policy root pin");PolicyDPath(intent.root.path);
    PolicyRequire(System.Text.RegularExpressions.Regex.IsMatch(intent.root.fileID,@"^[0-9]+:[0-9]+:[0-9]+$"),"exact policy root identity");
    PolicyRequire(String.Equals(path,Path.Combine(intent.root.path,"network-policy.intent.json"),StringComparison.OrdinalIgnoreCase) && String.Equals(intent.policyJournal,path,StringComparison.OrdinalIgnoreCase),"policy journal exact owned root path");
    PolicyFilePlan(intent.controller);PolicyFilePlan(intent.primary);PolicyFilePlan(intent.owner);
    PolicyRequire(String.Equals(Path.GetDirectoryName(Path.GetDirectoryName(intent.controller.path)),intent.root.path,StringComparison.OrdinalIgnoreCase) && PolicyInside(intent.controller.path,intent.root.path) && PolicyInside(intent.primary.path,intent.root.path) && String.Equals(intent.owner.path,Path.Combine(intent.root.path,"owner.json"),StringComparison.OrdinalIgnoreCase),"policy controller/primary/owner root binding");
    PolicyRequire(intent.jobName=="Global\\opencode-task24-policy-"+intent.nonce && intent.supervisorPID>0 && intent.supervisorCreatedFileTime!=null,"owned policy job/supervisor identity");
    ulong created;PolicyRequire(UInt64.TryParse(intent.supervisorCreatedFileTime,System.Globalization.NumberStyles.None,System.Globalization.CultureInfo.InvariantCulture,out created) && created>0,"exact supervisor creation FILETIME");
    PolicyRequire(intent.sublayer!=null && intent.sublayer.flags==1 && intent.sublayer.weight==65535 && intent.sublayer.name=="Task24 persistent deny "+intent.nonce && intent.filters!=null && intent.filters.Length==2,"exact persistent policy object specification");
    var sub=PolicyGuid(intent.sublayer.key);var v4=PolicyGuid(intent.filters[0].key);var v6=PolicyGuid(intent.filters[1].key);PolicyRequire(sub!=v4 && sub!=v6 && v4!=v6,"distinct exact policy GUIDs");
    for(int i=0;i<2;i++)PolicyRequire(intent.filters[i].flags==1 && intent.filters[i].action==0x1001 && intent.filters[i].weight==1 && intent.filters[i].layer==(i==0?policyV4:policyV6).ToString("D") && intent.filters[i].name==intent.sublayer.name+(i==0?" IPv4":" IPv6"),"exact persistent deny filter specification");
    byte[] bytes=Convert.FromBase64String(intent.conditionBytes);PolicyRequire(bytes.Length>0 && bytes.Length<=8192,"bounded journal scope bytes");
    if(intent.kind=="sid") {
      PolicyRequire(intent.conditionType==13 && PolicyGuid(intent.conditionKey)==package && intent.identity!=null && intent.identity.StartsWith("S-1-15-2-",StringComparison.Ordinal) && String.Equals(intent.primary.path,intent.controller.path,StringComparison.OrdinalIgnoreCase),"exact worker SID policy scope");
      var sid=new SecurityIdentifier(intent.identity);var expected=new byte[sid.BinaryLength];sid.GetBinaryForm(expected,0);PolicyRequire(Convert.ToBase64String(expected)==intent.conditionBytes,"exact journal SID bytes");
    } else PolicyRequire(intent.kind=="appid" && intent.conditionType==12 && PolicyGuid(intent.conditionKey)==policyAppID && String.Equals(intent.identity,intent.primary.path,StringComparison.Ordinal),"exact private browser application policy scope");
  }
  static void PolicyCreate(string exe,string journalPath,FilePin controller,FilePin primary,DirectoryPin[] directories,Dictionary<string,SafeFileHandle> pins,string kind,string identity,byte[] scope,ref PersistentPolicy policy) {
    PolicyDPath(exe);string root=Path.GetDirectoryName(Path.GetDirectoryName(exe));PolicyDPath(root);PolicyDPath(journalPath);
    PolicyRequire(String.Equals(journalPath,Path.Combine(root,"network-policy.intent.json"),StringComparison.OrdinalIgnoreCase),"policy journal must be exact private controller-root intent path");
    DirectoryPin rootPin=null;foreach(var directory in directories)if(String.Equals(directory.path,root,StringComparison.OrdinalIgnoreCase))rootPin=directory;PolicyRequire(rootPin!=null,"policy root expected pin");
    var paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);Pin(root,true,rootPin.fileID,false,pins,paths,false);PolicyPinFile(controller,pins);PolicyPinFile(primary,pins);
    string ownerPath=Path.Combine(root,"owner.json");var ownerHandle=Pin(ownerPath,false,null,false,pins,paths,false);var owner=PolicyCapture(ownerPath,ownerHandle,65536);
    long created,exited,kernel,user;Require(GetProcessTimes(GetCurrentProcess(),out created,out exited,out kernel,out user),"capture exact supervisor creation time");
    string nonce=Guid.NewGuid().ToString("N");var intent=new PersistentPolicyIntent{version=1,policyJournal=journalPath,nonce=nonce,kind=kind,identity=identity,conditionBytes=Convert.ToBase64String(scope),conditionType=kind=="sid"?13u:12u,conditionKey=(kind=="sid"?package:policyAppID).ToString("D"),controller=controller,primary=primary,owner=owner,root=rootPin,jobName="Global\\opencode-task24-policy-"+nonce,supervisorPID=GetCurrentProcessId(),supervisorCreatedFileTime=unchecked((ulong)created).ToString(System.Globalization.CultureInfo.InvariantCulture),sublayer=new PersistentPolicyLayer{key=Guid.NewGuid().ToString("D"),name="Task24 persistent deny "+nonce,flags=1,weight=65535}};
    intent.filters=new[]{new PersistentPolicyFilter{key=Guid.NewGuid().ToString("D"),name=intent.sublayer.name+" IPv4",layer=policyV4.ToString("D"),flags=1,action=0x1001,weight=1},new PersistentPolicyFilter{key=Guid.NewGuid().ToString("D"),name=intent.sublayer.name+" IPv6",layer=policyV6.ToString("D"),flags=1,action=0x1001,weight=1}};
    PolicyValidateIntent(intent,journalPath);var serializer=new JavaScriptSerializer{MaxJsonLength=65536};byte[] journal=new UTF8Encoding(false,true).GetBytes(serializer.Serialize(intent));PolicyRequire(journal.Length<=65536,"bounded immutable policy intent");
    // The immutable intent is durable before any persistent WFP mutation or named
    // job creation. Retain it on all uncertain outcomes; no append/update journal.
    FilePin written;
    using(var stream=new FileStream(journalPath,FileMode.CreateNew,FileAccess.ReadWrite,FileShare.Read,4096,FileOptions.WriteThrough)) {
      stream.Write(journal,0,journal.Length);stream.Flush(true);FileInfo info;Require(GetFileInformationByHandle(stream.SafeFileHandle,out info),"new policy journal identity");
      PolicyRequire((info.Attributes&0x400)==0 && info.Links==1,"direct unique policy journal");written=new FilePin{path=journalPath,fileID=info.Volume+":"+(((ulong)info.IndexHi<<32)|info.IndexLo)+":0",sha256=PolicyHash(journal)};
    }
    policy=new PersistentPolicy{Intent=intent,JournalPath=journalPath};PolicyPinFile(written,pins,65536);policy.Engine=PolicyOpenEngine();
    var memory=new List<IntPtr>();var owned=policy;
    try {
      PolicyTransaction(owned.Engine,0,()=>{
        var prior=PolicyObjects(owned.Engine,intent);PolicyRequire(!prior.sublayer,"generated policy GUID already exists; not owned");
        var layer=new SubLayer{Key=PolicyGuid(intent.sublayer.key),Display=Name(intent.sublayer.name,memory),Flags=1,Weight=65535};Status(FwpmSubLayerAdd0(owned.Engine,ref layer,IntPtr.Zero),"add exact persistent policy sublayer");
        PolicyAddBlock(owned.Engine,intent,intent.filters[0],memory);PolicyAddBlock(owned.Engine,intent,intent.filters[1],memory);
        owned.CanOwn=true;
      });
      policy.Committed=true;
      var actual=PolicyObjects(policy.Engine,intent);PolicyRequire(actual.sublayer,"committed persistent deny set missing");
    } finally {foreach(var pointer in memory)Marshal.FreeHGlobal(pointer);}
  }
  static IntPtr PolicyCreateJob(PersistentPolicy policy) {
    PolicyRequire(policy!=null && policy.Committed,"persistent deny committed before job creation");var name=Marshal.StringToHGlobalUni(policy.Intent.jobName);
    try {var job=CreateJobObjectW(IntPtr.Zero,name);int error=Marshal.GetLastWin32Error();Require(job!=IntPtr.Zero,"create exact owned named job");if(error==183){Require(CloseHandle(job),"close foreign existing named-job handle");throw new IOException("policy named job already exists; refusing ownership: "+policy.Intent.jobName);}return job;}
    finally {Marshal.FreeHGlobal(name);}
  }
  static int PolicyActive(IntPtr job) {
    var accounting=Marshal.AllocHGlobal(48);
    try {Require(QueryInformationJobObject(job,1,accounting,48,IntPtr.Zero),"fresh held policy job accounting");int active=Marshal.ReadInt32(accounting,40);PolicyRequire(active>=0 && active<=64,"bounded policy job active processes");return active;}
    finally {Marshal.FreeHGlobal(accounting);}
  }
  static bool PolicyRetire(IntPtr engine,PersistentPolicyIntent intent,bool canOwn,Action proveSafe) {
    bool performed=false;
    PolicyTransaction(engine,0,()=>{
      proveSafe();var actual=PolicyObjects(engine,intent);
      if(actual.sublayer) {
        PolicyRequire(canOwn,"persistent objects not proven acquired by this invocation; retain journal");
        foreach(var expected in intent.filters){var key=PolicyGuid(expected.key);Status(FwpmFilterDeleteByKey0(engine,ref key),"delete exact owned persistent deny filter");}
        var sub=PolicyGuid(intent.sublayer.key);Status(FwpmSubLayerDeleteByKey0(engine,ref sub),"delete exact owned persistent deny sublayer");performed=true;
      }
      proveSafe();var absent=PolicyObjects(engine,intent);PolicyRequire(!absent.sublayer,"persistent objects absent within retirement transaction");
    });
    var verified=PolicyObjects(engine,intent);PolicyRequire(!verified.sublayer,"persistent objects absent after retirement commit");return performed;
  }
  static void PolicyFinish(PersistentPolicy policy,bool processSafe,bool permitsClosed,IntPtr job,bool started,List<Exception> errors) {
    if(policy==null)return;
    if(!processSafe || !permitsClosed)errors.Add(new IOException("persistent deny retained; termination/volatile-permit cleanup unproven; policyJournal="+policy.JournalPath));
    else Cleanup(()=>{
      if(policy.Engine==IntPtr.Zero)policy.Engine=PolicyOpenEngine();
      PolicyRetire(policy.Engine,policy.Intent,policy.CanOwn,()=>PolicyRequire(!started || (job!=IntPtr.Zero && PolicyActive(job)==0),"held owned job must be empty before persistent policy retirement"));policy.Retired=true;
    },errors);
    if(policy.Engine!=IntPtr.Zero)Cleanup(()=>{Status(FwpmEngineClose0(policy.Engine),"close non-dynamic persistent policy engine");policy.Engine=IntPtr.Zero;},errors);
  }
  static string PolicySupervisorState(PersistentPolicyIntent intent) {
    var process=OpenProcess(0x1000|0x100000,false,intent.supervisorPID);
    if(process==IntPtr.Zero)return Marshal.GetLastWin32Error()==87?"dead":"unknown";
    try {
      if(WaitForSingleObject(process,0)==0)return "dead";
      long created,exited,kernel,user;if(!GetProcessTimes(process,out created,out exited,out kernel,out user))return "unknown";
      if(unchecked((ulong)created).ToString(System.Globalization.CultureInfo.InvariantCulture)!=intent.supervisorCreatedFileTime)return "dead";
      uint wait=WaitForSingleObject(process,0);return wait==0?"dead":wait==0x102?"alive":"unknown";
    } finally {Require(CloseHandle(process),"close inspected supervisor handle");}
  }
  static string PolicyInspectOrRecover(string journalFilePinJSON,bool recover) {
    var serializer=new JavaScriptSerializer{MaxJsonLength=65536};PolicyRequire(journalFilePinJSON!=null && journalFilePinJSON.Length<=65536,"bounded journal FilePin request");
    var supplied=serializer.Deserialize<FilePin>(journalFilePinJSON);var pins=new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);IntPtr engine=IntPtr.Zero,job=IntPtr.Zero;Exception failure=null;string result=null;
    try {
      var journal=PolicyPinFile(supplied,pins,65536);var intent=serializer.Deserialize<PersistentPolicyIntent>(new UTF8Encoding(false,true).GetString(PolicyRead(journal,65536)));PolicyValidateIntent(intent,supplied.path);
      Pin(intent.root.path,true,intent.root.fileID,false,pins,new HashSet<string>(StringComparer.OrdinalIgnoreCase),false);PolicyPinFile(intent.owner,pins,65536);PolicyPinFile(intent.controller,pins);PolicyPinFile(intent.primary,pins);
      if(intent.kind=="appid") {IntPtr app=IntPtr.Zero;try{Status(FwpmGetAppIdFromFileName0(intent.primary.path,out app),"verify recovery private browser application identity");PolicyRequire(Convert.ToBase64String(PolicyAppBytes(app))==intent.conditionBytes,"recovery browser application identity changed");}finally{if(app!=IntPtr.Zero)FwpmFreeMemory0(ref app);}}
      string supervisor=PolicySupervisorState(intent),jobState="absent";int? active=null;
      job=OpenJobObjectW(4,false,intent.jobName);
      if(job==IntPtr.Zero){int error=Marshal.GetLastWin32Error();if(error!=2)throw new Win32Exception(error,"open exact policy journal named job");}
      else {active=PolicyActive(job);jobState=active.Value==0?"empty":"active";}
      engine=PolicyOpenEngine();PersistentPolicyObjects objects=null;PolicyTransaction(engine,1,()=>objects=PolicyObjects(engine,intent));bool retired=!objects.sublayer,performed=false;
      if(recover) {
        PolicyRequire(supervisor=="dead","policy recovery requires the exact original supervisor instance proven dead");
        PolicyRequire(job!=IntPtr.Zero && active==0,"policy recovery requires a still-named held empty job; absent is uncertain");
        performed=PolicyRetire(engine,intent,true,()=>{PolicyRequire(PolicySupervisorState(intent)=="dead","original supervisor death must remain proven");PolicyRequire(PolicyActive(job)==0,"held recovery named job must remain empty");});
        objects=PolicyObjects(engine,intent);retired=!objects.sublayer;
      }
      result=serializer.Serialize(new {policyJournal=supplied.path,kind=intent.kind,jobName=intent.jobName,jobState=jobState,jobActiveProcesses=active,supervisorPID=intent.supervisorPID,supervisorCreatedFileTime=intent.supervisorCreatedFileTime,supervisorState=supervisor,persistentNetworkPolicy=objects.sublayer,persistentPolicyRetired=retired,objects=objects,retirementPerformed=performed,recoveryScope="network-policy-only"});
    } catch(Exception error){failure=error;} finally {
      var errors=new List<Exception>();if(engine!=IntPtr.Zero)Cleanup(()=>Status(FwpmEngineClose0(engine),"close policy inspection/recovery engine"),errors);if(job!=IntPtr.Zero)Cleanup(()=>Require(CloseHandle(job),"close held recovery job"),errors);foreach(var handle in pins.Values)Cleanup(()=>handle.Dispose(),errors);
      if(errors.Count>0){if(failure!=null)errors.Insert(0,failure);failure=new AggregateException("policy inspection/recovery cleanup failed; supplied journal retained",errors);}
    }
    if(failure!=null)throw failure;return result;
  }
  public static string InspectPersistentPolicy(string journalFilePinJSON) {return PolicyInspectOrRecover(journalFilePinJSON,false);}
  public static string RecoverPersistentPolicy(string journalFilePinJSON) {return PolicyInspectOrRecover(journalFilePinJSON,true);}
}
