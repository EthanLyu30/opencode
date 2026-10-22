// TEST ONLY. Concatenated with the production partial sources by the opt-in
// Windows policy regression. Never included in the production native source.
public static partial class Task24NativeIsolation {
  public sealed class FixturePolicyPlan { public FilePin exe; public DirectoryPin[] directories; public string policyJournal; public int port; }

  public static string FixturePolicyProbe(string planJSON) {
    var serializer=new JavaScriptSerializer{MaxJsonLength=65536};
    PolicyRequire(planJSON!=null && planJSON.Length<=65536,"bounded policy fixture plan");
    var plan=serializer.Deserialize<FixturePolicyPlan>(planJSON);
    var pins=new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);var memory=new List<IntPtr>();
    PersistentPolicy policy=null;IntPtr appID=IntPtr.Zero,job=IntPtr.Zero,engine=IntPtr.Zero;Guid permit=Guid.Empty;
    bool permitsClosed=true;Exception failure=null;string result=null;
    try {
      PolicyRequire(plan!=null && plan.exe!=null && plan.directories!=null && plan.directories.Length==4 && plan.port>=1024 && plan.port<=65535,"policy fixture plan");
      PolicyFilePlan(plan.exe);string root=Path.GetDirectoryName(Path.GetDirectoryName(plan.exe.path));PolicyDPath(root);
      string rootName=Path.GetFileName(root);PolicyRequire(rootName.StartsWith("windows-policy-live-",StringComparison.Ordinal) && rootName.Length>"windows-policy-live-".Length,"owned policy fixture root prefix");
      PolicyRequire(String.Equals(plan.exe.path,Path.Combine(root,"runtime","bun.exe"),StringComparison.OrdinalIgnoreCase),"owned policy fixture private Bun executable");
      PolicyRequire(String.Equals(plan.policyJournal,Path.Combine(root,"network-policy.intent.json"),StringComparison.OrdinalIgnoreCase),"owned policy fixture journal path");
      var expected=new HashSet<string>(StringComparer.OrdinalIgnoreCase){root,Path.Combine(root,"runtime"),Path.Combine(root,"state"),Path.Combine(root,"compiler")};
      var admitted=new HashSet<string>(StringComparer.OrdinalIgnoreCase);var grants=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      foreach(var directory in plan.directories) {
        PolicyRequire(directory!=null && expected.Contains(directory.path) && admitted.Add(directory.path),"exact policy fixture directory set");
        PolicyDPath(directory.path);BrowserExpectedID(directory.fileID);Pin(directory.path,true,directory.fileID,false,pins,grants,false);
      }
      PolicyRequire(admitted.SetEquals(expected),"complete policy fixture directory pins");PolicyPinFile(plan.exe,pins);
      Status(FwpmGetAppIdFromFileName0(plan.exe.path,out appID),"fixture private executable application identity");
      PolicyCreate(plan.exe.path,plan.policyJournal,plan.exe,plan.exe,plan.directories,pins,"appid",plan.exe.path,PolicyAppBytes(appID),ref policy);
      job=PolicyCreateJob(policy);
      var limits=new Limits{Basic=new Basic{Flags=0x2000|0x8|0x200,Active=64},JobMemory=(UIntPtr)(2ul*1024*1024*1024)};
      Require(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(limits)),"fixture owned empty job limits");
      PolicyRequire(PolicyActive(job)==0,"fixture job is empty before readiness");
      var session=new Session{Key=Guid.NewGuid(),Flags=1,Display=Name("Task24 test-only volatile permit probe",memory)};
      Status(FwpmEngineOpen0(null,10,IntPtr.Zero,ref session,out engine),"fixture volatile permit engine");permitsClosed=false;
      permit=BrowserFilter(engine,PolicyGuid(policy.Intent.sublayer.key),policyV4,appID,plan.port,true,memory);
      Console.WriteLine(serializer.Serialize(new {stage="ready",jobName=policy.Intent.jobName,journal=policy.JournalPath,permitKey=permit.ToString("D")}));Console.Out.Flush();
      string command=Console.ReadLine();PolicyRequire(command==null || command=="finish","policy fixture expects finish or EOF");
    } catch(Exception error){failure=error;} finally {
      var errors=new List<Exception>();
      if(engine!=IntPtr.Zero)Cleanup(()=>{Status(FwpmEngineClose0(engine),"fixture close volatile permit engine");engine=IntPtr.Zero;permitsClosed=true;},errors);
      bool empty=job==IntPtr.Zero;
      if(job!=IntPtr.Zero)Cleanup(()=>{empty=PolicyActive(job)==0;PolicyRequire(empty,"fixture owned job unexpectedly active; persistent deny retained");},errors);
      // This fixture never starts or assigns a process. Even failure before ready
      // has an in-process no-child proof; never delete foreign rules or C data.
      PolicyFinish(policy,empty,permitsClosed,job,false,errors);
      if(job!=IntPtr.Zero)Cleanup(()=>Require(CloseHandle(job),"fixture close owned named job"),errors);
      if(appID!=IntPtr.Zero)Cleanup(()=>FwpmFreeMemory0(ref appID),errors);
      foreach(var handle in pins.Values)Cleanup(()=>handle.Dispose(),errors);
      foreach(var pointer in memory)Cleanup(()=>Marshal.FreeHGlobal(pointer),errors);
      if(errors.Count>0){if(failure!=null)errors.Insert(0,failure);failure=new AggregateException("policy fixture cleanup failed; journal="+(policy==null?"":policy.JournalPath),errors);}
    }
    if(failure!=null)throw failure;
    PolicyRequire(policy!=null && policy.Retired && permitsClosed,"policy fixture normal cleanup verified");
    result=serializer.Serialize(new {stage="finished",jobName=policy.Intent.jobName,journal=policy.JournalPath,permitKey=permit.ToString("D"),persistentPolicyRetired=policy.Retired,volatilePermitClosed=permitsClosed});
    return result;
  }

  public static bool FixturePermitPresent(string guid) {
    var key=PolicyGuid(guid);IntPtr engine=IntPtr.Zero,pointer=IntPtr.Zero;Exception failure=null;bool present=false;
    try {
      engine=PolicyOpenEngine();uint status=FwpmFilterGetByKey0(engine,ref key,out pointer);
      if(status==0x80320003u)PolicyRequire(pointer==IntPtr.Zero,"fixture exact permit not-found pointer");
      else {
        Status(status,"fixture read exact volatile permit key");PolicyRequire(pointer!=IntPtr.Zero,"fixture exact permit result");
        var actual=(Filter)Marshal.PtrToStructure(pointer,typeof(Filter));
        PolicyRequire(actual.Key==key && actual.Action.Type==0x1002 && (actual.Flags&1)==0,"fixture key is not the expected nonpersistent PERMIT");present=true;
      }
    } catch(Exception error){failure=error;} finally {
      var errors=new List<Exception>();if(pointer!=IntPtr.Zero)Cleanup(()=>FwpmFreeMemory0(ref pointer),errors);if(engine!=IntPtr.Zero)Cleanup(()=>Status(FwpmEngineClose0(engine),"fixture close exact permit query engine"),errors);
      if(errors.Count>0){if(failure!=null)errors.Insert(0,failure);failure=new AggregateException("fixture permit query cleanup failed",errors);}
    }
    if(failure!=null)throw failure;return present;
  }
  public static IntPtr FixtureHoldJob(string name) {
    PolicyRequire(name!=null && System.Text.RegularExpressions.Regex.IsMatch(name,@"^Global\\opencode-task24-policy-[a-f0-9]{32}$"),"exact fixture guardian job name");
    var job=OpenJobObjectW(4,false,name);Require(job!=IntPtr.Zero,"fixture guardian holds exact named job");return job;
  }
  public static int FixtureJobActive(IntPtr handle) {PolicyRequire(handle!=IntPtr.Zero && handle!=(IntPtr)(-1),"fixture guardian job handle");return PolicyActive(handle);}
  public static void FixtureReleaseJob(IntPtr handle) {PolicyRequire(handle!=IntPtr.Zero && handle!=(IntPtr)(-1),"fixture guardian release handle");Require(CloseHandle(handle),"fixture guardian releases job handle");}
}
