import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

// Exercise the real native grant on owned fixtures, never on old ancestors.
// Clearing AUTO_INHERITED or propagating an existing ACE must fail this test.
test.skipIf(process.platform !== "win32")(
  "native metadata grants preserve ancestor controls, owner, ACEs and existing children",
  async () => {
    const parent = process.env.TMPDIR!
    if (!/^D:\\OpenCode-Benchmark\\Task24\\tmp\\[^\\]+/.test(parent)) throw Error("owned D fixture required")
    const root = await fs.mkdtemp(path.join(parent, "metadata-controls-"))
    let safe = false
    try {
      const source = await Promise.all(
        ["windows-native.cs", "windows-policy-native.cs", "windows-browser-native.cs"].map((name) =>
          Bun.file(path.join(import.meta.dir, "../../src/sandbox/host-isolation", name)).text(),
        ),
      )
      await fs.writeFile(path.join(root, "native.cs"), source.join("\r\n"))
      await fs.writeFile(
        path.join(root, "probe.ps1"),
        `param([string]$Root)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $Root 'native.cs'))) -ReferencedAssemblies @('System.Web.Extensions','System.Core')
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;
public static class MetadataFixture {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr sec,uint c,uint f,IntPtr t);
  [DllImport("ntdll.dll")]static extern int NtSetSecurityObject(SafeFileHandle h,uint flags,IntPtr sd);
  static string Snapshot(string p){return Directory.GetAccessControl(p,AccessControlSections.Access|AccessControlSections.Owner|AccessControlSections.Group).GetSecurityDescriptorSddlForm(AccessControlSections.Access|AccessControlSections.Owner|AccessControlSections.Group);}
  public static string Run(string root,Type native,string mode){
    string target=Path.Combine(root,mode);Directory.CreateDirectory(target);string child=Path.Combine(target,"existing");Directory.CreateDirectory(child);
    using(var handle=CreateFileW(target,0x60080,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero)){
      if(handle.IsInvalid)throw new IOException("fixture handle");
      if(mode!="auto"){
        var initial=new RawSecurityDescriptor(Snapshot(target));var flags=initial.ControlFlags&~(ControlFlags.DiscretionaryAclAutoInherited|ControlFlags.DiscretionaryAclAutoInheritRequired);if(mode=="protected")flags|=ControlFlags.DiscretionaryAclProtected;initial.SetFlags(flags);
        var bytes=new byte[initial.BinaryLength];initial.GetBinaryForm(bytes,0);var pin=GCHandle.Alloc(bytes,GCHandleType.Pinned);try{if(NtSetSecurityObject(handle,4,pin.AddrOfPinnedObject())!=0)throw new IOException("own fixture control");}finally{pin.Free();}
      }
      var before=Snapshot(target);var childBefore=Snapshot(child);var type=native.GetNestedType("MetadataGrant",BindingFlags.NonPublic);var sid=new SecurityIdentifier("S-1-15-2-10001-10002-10003-10004-10005-10006-10007");
      var grant=Activator.CreateInstance(type,BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic,null,new object[]{handle,sid,target},null);bool applied=false;bool childDuring=false;bool exact=false;
      try{
        type.GetMethod("Apply").Invoke(grant,null);applied=true;childDuring=Snapshot(child)==childBefore;
        var acl=new RawSecurityDescriptor(Snapshot(target)).DiscretionaryAcl;int count=0;foreach(GenericAce item in acl){var ace=item as CommonAce;if(ace==null||!ace.SecurityIdentifier.Equals(sid))continue;count++;exact=ace.AccessMask==160&&ace.AceFlags==AceFlags.None&&ace.AceQualifier==AceQualifier.AccessAllowed;}exact=exact&&count==1;
      }finally{if(applied)((IDisposable)grant).Dispose();}
      bool unchanged=Snapshot(target)==before;bool children=childDuring&&Snapshot(child)==childBefore;bool retired=(bool)type.GetProperty("Retired").GetValue(grant,null);
      string fresh=Path.Combine(target,"fresh");Directory.CreateDirectory(fresh);bool freshCanonical=mode!="auto"||Directory.GetAccessControl(fresh).AreAccessRulesCanonical;
      return "{\\"mode\\":\\""+mode+"\\",\\"unchanged\\":"+unchanged.ToString().ToLowerInvariant()+",\\"children\\":"+children.ToString().ToLowerInvariant()+",\\"exact\\":"+exact.ToString().ToLowerInvariant()+",\\"retired\\":"+retired.ToString().ToLowerInvariant()+",\\"freshCanonical\\":"+freshCanonical.ToString().ToLowerInvariant()+"}";
    }
  }
}
'@
@('auto','legacy','protected') | ForEach-Object { [MetadataFixture]::Run($Root,[Task24NativeIsolation],$_) }
`,
      )
      const child = Bun.spawn(
        [
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          path.join(root, "probe.ps1"),
          "-Root",
          root,
        ],
        {
          env: { SystemRoot: "C:\\Windows", TEMP: root, TMP: root },
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        },
      )
      const timer = setTimeout(() => child.kill(), 15000)
      const [output, error, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => clearTimeout(timer))
      expect({ exit, error }).toEqual({ exit: 0, error: "" })
      const results = output
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
      safe = results.length === 3 && results.every((item) => item.retired === true)
      expect(results).toEqual(
        ["auto", "legacy", "protected"].map((mode) => ({
          mode,
          unchanged: true,
          children: true,
          exact: true,
          retired: true,
          freshCanonical: true,
        })),
      )
    } finally {
      if (safe && (await fs.realpath(root)) === root && root.startsWith(parent + path.sep))
        await fs.rm(root, { recursive: true })
    }
  },
  30000,
)
