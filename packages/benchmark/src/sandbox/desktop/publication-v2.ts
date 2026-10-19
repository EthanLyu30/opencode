import path from "node:path"
import { canonicalJson } from "../../campaign/canonical"
import { sha256Bytes } from "../../hash"
import type { FileIdentity } from "../contracts"
import { canonicalDesktopPath } from "./compatibility"
import { readDesktopDirectoryV2 } from "./identity-v2"
import { desktopProbeEnvironment, readDesktopProbeRootProof, revalidateDesktopProbeEnvironment } from "./probe-root"
import { desktopProbeBootstrap } from "./probe-worker"

export const desktopProfileLayoutV2 = Object.freeze([
  "",
  "state",
  "state\\grants",
  "home-oc-task24-dd479",
  "home-oc-task24-dd479\\AppData",
  "home-oc-task24-dd479\\AppData\\Local",
  "home-oc-task24-dd479\\AppData\\Local\\Docker",
  "home-oc-task24-dd479\\AppData\\Roaming",
  "home-oc-task24-dd479\\AppData\\Roaming\\Docker",
  "home-oc-task24-dd479\\.docker",
  "frontend",
  "cli",
  "temp",
])
export type DesktopPublicationV2 = {
  directories(): Promise<Readonly<Record<string, string>>>
  pin(file: FileIdentity): Promise<void>
  write(relative: string, text: string): Promise<FileIdentity>
  remove(file: FileIdentity): Promise<void>
  acquire(relative: readonly string[]): Promise<void>
  release(): Promise<void>
  read(relative: string): Promise<{ identity: FileIdentity; bytes: Uint8Array }>
}

// Separate helper and protocol: v1 rights, identity strings and helper deadlines do not change.
const source = String.raw`
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DesktopV2 {
 [StructLayout(LayoutKind.Sequential)] struct US { public ushort Length,MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)] struct OA { public uint Length; public IntPtr Root,Name; public uint Attributes; public IntPtr Security,Quality; }
 [StructLayout(LayoutKind.Sequential)] struct IOS { public IntPtr Status; public UIntPtr Information; }
 [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes,CLo,CHi,ALo,AHi,WLo,WHi,Volume,SizeHi,SizeLo,Links,IndexHi,IndexLo; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr sec,uint disposition,uint flags,IntPtr template);
 [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr h,uint a,ref OA o,out IOS io,IntPtr size,uint attrs,uint share,uint disposition,uint options,IntPtr ea,uint eaSize);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info info);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h,StringBuilder b,uint size,uint flags);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(SafeFileHandle h,byte[] b,uint size,out uint read,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(SafeFileHandle h,byte[] b,uint size,out uint written,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(SafeFileHandle h,long distance,out long next,uint method);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int info,byte[] data,uint size);
 static readonly Dictionary<string,SafeFileHandle> dirs=new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
 static readonly Dictionary<string,SafeFileHandle> files=new Dictionary<string,SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
 static readonly List<string> group=new List<string>();
 static string root; static bool writable;
 static Info Check(SafeFileHandle h,string expected,bool directory) {
  Info i;
  if(h.IsInvalid||!GetFileInformationByHandle(h,out i)||(i.Attributes&0x400)!=0||((i.Attributes&0x10)!=0)!=directory||(!directory&&i.Links!=1))throw new IOException("file_kind");
  var b=new StringBuilder(32768);uint n=GetFinalPathNameByHandleW(h,b,(uint)b.Capacity,0);
  if(n==0||n>=b.Capacity||!String.Equals(b.ToString(),@"\\?\"+expected,StringComparison.OrdinalIgnoreCase))throw new IOException("path_binding");
  return i;
 }
 static string ID(Info i) {
  ulong ino=((ulong)i.IndexHi<<32)|i.IndexLo, born=((ulong)i.CHi<<32)|i.CLo;
  decimal ns=(decimal)born*100m-11644473600000000000m;
  return "v2:"+i.Volume.ToString(CultureInfo.InvariantCulture)+":"+ino.ToString(CultureInfo.InvariantCulture)+":"+ns.ToString("0",CultureInfo.InvariantCulture);
 }
 static SafeFileHandle Relative(SafeFileHandle parent,string name,bool directory,bool create,string expected,bool deleting) {
  if(name.Length==0||name=="."||name==".."||name.IndexOfAny(new char[]{'\\','/',':','\0'})>=0)throw new IOException("relative_name");
  var u=new US();u.Length=(ushort)(name.Length*2);u.MaximumLength=(ushort)(u.Length+2);u.Buffer=Marshal.StringToHGlobalUni(name);
  var m=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US)));
  try {
   Marshal.StructureToPtr(u,m,false);var o=new OA();o.Length=(uint)Marshal.SizeOf(typeof(OA));o.Root=parent.DangerousGetHandle();o.Name=m;o.Attributes=0x40;
   IntPtr raw;IOS io;uint access=directory?0x1000A0u:create?0x110083u:deleting?0x110081u:0x100081u;
   // Parents allow child saves but never DELETE sharing; leased files allow READ sharing only.
   int status=NtCreateFile(out raw,access,ref o,out io,IntPtr.Zero,directory?0x10u:0x80u,directory?3u:1u,create?2u:1u,directory?0x200021u:0x200060u,IntPtr.Zero,0);
   if(status<0)throw new IOException("open_"+status.ToString("X8"));
   var h=new SafeFileHandle(raw,true);try{Check(h,expected,directory);return h;}catch{h.Dispose();throw;}
  }finally{Marshal.FreeHGlobal(m);Marshal.FreeHGlobal(u.Buffer);}
 }
 public static void Parents(string value,bool write) {
  root=value;writable=write;string current=Path.GetPathRoot(root);
  var h=CreateFileW(current,0x1000A0u,3,IntPtr.Zero,3,0x02200000u,IntPtr.Zero);try{Check(h,current,true);dirs.Add(current,h);}catch{h.Dispose();throw;}
  foreach(string part in Path.GetDirectoryName(root).Substring(current.Length).Split('\\')){string next=Path.Combine(current,part);dirs.Add(next,Relative(dirs[current],part,true,false,next,false));current=next;}
 }
 static string Target(string relative) {
  if(String.IsNullOrEmpty(relative)||Path.IsPathRooted(relative)||relative.IndexOf('/')>=0)throw new IOException("relative_scope");
  foreach(string part in relative.Split('\\'))if(part.Length==0||part=="."||part==".."||part.IndexOf(':')>=0)throw new IOException("relative_scope");
  string p=Path.GetFullPath(Path.Combine(root,relative));if(!p.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase))throw new IOException("relative_scope");return p;
 }
 static void Directory(string target,bool create) {
  if(dirs.ContainsKey(target))return;
  string parent=Path.GetDirectoryName(target);
  if(!parent.StartsWith(root,StringComparison.OrdinalIgnoreCase)&&!String.Equals(target,root,StringComparison.OrdinalIgnoreCase))throw new IOException("directory_scope");
  if(!dirs.ContainsKey(parent))Directory(parent,create);
  dirs.Add(target,Relative(dirs[parent],Path.GetFileName(target),true,create,target,false));
 }
 public static void Tree(bool create,string[] layout) {
  Directory(root,create);
  foreach(string p in layout)if(!String.IsNullOrEmpty(p))Directory(Target(p),create);
 }
 public static Dictionary<string,string> Identities(){var result=new Dictionary<string,string>();foreach(var pair in dirs)result.Add(pair.Key,ID(Check(pair.Value,pair.Key,true)));return result;}
 public static void Pin(string relative,bool deleting) {
  string target=Target(relative);Directory(Path.GetDirectoryName(target),false);
  if(!files.ContainsKey(relative))files.Add(relative,Relative(dirs[Path.GetDirectoryName(target)],Path.GetFileName(target),false,false,target,deleting));
 }
 static void WriteName(string relative) {
  if(!writable||!(relative=="owner.json"||relative=="intent.json"||relative=="manifest.json"||relative==@"home-oc-task24-dd479\AppData\Roaming\Docker\settings-store.json"||relative==@"state\active.json"||(relative.StartsWith(@"state\grants\",StringComparison.Ordinal)&&relative.EndsWith(".json",StringComparison.Ordinal)&&relative.Length==82)))throw new IOException("write_scope");
 }
 public static void Write(string relative,string data) {
  WriteName(relative);string target=Target(relative);Directory(Path.GetDirectoryName(target),false);
  byte[] bytes=Convert.FromBase64String(data);if(bytes.Length>1048576)throw new IOException("size_limit");
  var h=Relative(dirs[Path.GetDirectoryName(target)],Path.GetFileName(target),false,true,target,true);files.Add(relative,h);uint n;
  if(!WriteFile(h,bytes,(uint)bytes.Length,out n,IntPtr.Zero)||n!=bytes.Length||!FlushFileBuffers(h))throw new IOException("write_failed");
 }
 public static string[] Read(string relative) {
  string target=Target(relative);SafeFileHandle h;if(!files.TryGetValue(relative,out h))throw new IOException("not_pinned");
  Info i=Check(h,target,false);ulong size=((ulong)i.SizeHi<<32)|i.SizeLo;if(size>1048576)throw new IOException("size_limit");
  long next;if(!SetFilePointerEx(h,0,out next,0))throw new IOException("seek_failed");
  var bytes=new byte[(int)size];uint n;if(size>0&&(!ReadFile(h,bytes,(uint)size,out n,IntPtr.Zero)||n!=size))throw new IOException("read_failed");
  Info after=Check(h,target,false);if(ID(i)!=ID(after)||i.SizeHi!=after.SizeHi||i.SizeLo!=after.SizeLo||i.WHi!=after.WHi||i.WLo!=after.WLo)throw new IOException("read_drift");
  return new string[]{ID(after),Convert.ToBase64String(bytes)};
 }
 public static void Acquire(string[] names) {
  if(group.Count!=0||names.Length<1||names.Length>12)throw new IOException("group_scope");
  try{foreach(string name in names){if(files.ContainsKey(name))throw new IOException("already_pinned");Pin(name,false);group.Add(name);}}catch{Release();throw;}
 }
 public static void Release(){foreach(string name in group){files[name].Dispose();files.Remove(name);}group.Clear();}
 public static void Remove(string relative){if(!writable||relative!=@"state\active.json")throw new IOException("remove_scope");Pin(relative,true);var h=files[relative];if(!SetFileInformationByHandle(h,4,new byte[]{1},1))throw new IOException("remove_failed");h.Dispose();files.Remove(relative);}
 public static void Close(){foreach(var h in files.Values)h.Dispose();files.Clear();var values=new List<SafeFileHandle>(dirs.Values);values.Reverse();foreach(var h in values)h.Dispose();dirs.Clear();}
}
`
const script = String.raw`
$ErrorActionPreference='Stop'
$first=[Console]::ReadLine()|ConvertFrom-Json
$p=@{cwd=$env:TEMP;tempIdentity=$first.tempIdentity;tempOwnerSha256=$first.tempOwnerSha256}
${desktopProbeBootstrap}
$sha=[Security.Cryptography.SHA256]::Create()
try{$digest=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$first.source))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}
if($digest -cne '${sha256Bytes(Buffer.from(source))}'){exit 249}
Add-Type -TypeDefinition ([string]$first.source)
try{
 [DesktopV2]::Parents([string]$first.root,[bool]$first.writable)
 [Console]::WriteLine((ConvertTo-Json -InputObject @{value=[DesktopV2]::Identities()} -Depth 8 -Compress));[Console]::Out.Flush()
 while($null -ne ($line=[Console]::ReadLine())){
  try{
   $r=$line|ConvertFrom-Json;$value=$null
   switch($r.op){
    'tree'{[DesktopV2]::Tree([bool]$r.create,[string[]]$r.layout);$value=[DesktopV2]::Identities()}
    'pin'{[DesktopV2]::Pin([string]$r.relative,[bool]$r.deleting)}
    'write'{[DesktopV2]::Write([string]$r.relative,[string]$r.data)}
    'read'{$value=[DesktopV2]::Read([string]$r.relative)}
    'acquire'{[DesktopV2]::Acquire([string[]]$r.names)}
    'release'{[DesktopV2]::Release()}
    'remove'{[DesktopV2]::Remove([string]$r.relative)}
    'identities'{$value=[DesktopV2]::Identities()}
    default{throw 'operation_scope'}
   }
   [Console]::WriteLine((ConvertTo-Json -InputObject @{value=$value} -Depth 8 -Compress))
  }catch{[Console]::WriteLine('{"error":"TASK24_DESKTOP_V2_HANDLE_OPERATION"}')}
  [Console]::Out.Flush()
 }
}finally{[DesktopV2]::Close()}
`

export async function withDesktopPublicationV2<T>(
  input: {
    root: string
    mode: "read" | "create-profile" | "profile"
    parents: Readonly<Record<string, string>>
    signal: AbortSignal
  },
  use: (io: DesktopPublicationV2) => Promise<T>,
): Promise<T> {
  if (process.platform !== "win32" || input.signal.aborted) throw new TypeError("TASK24_DESKTOP_V2_HANDLE_UNAVAILABLE")
  const root = canonicalDesktopPath(input.root),
    temp = canonicalDesktopPath(process.env.TMPDIR ?? "")
  // Only synthetic D roots have an enabled v2 catalog. This is not a native prepare entry point.
  if (!/^D:\\OpenCode-Benchmark\\Task24\\tmp\\bprep1-[^\\]+$/i.test(temp) || !root.startsWith(temp + path.sep))
    throw new TypeError("TASK24_DESKTOP_V2_HANDLE_SCOPE")
  const env = await desktopProbeEnvironment(),
    proof = readDesktopProbeRootProof(env)
  const child = Bun.spawn(
    [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { cwd: env.TEMP, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const reader = child.stdout.getReader()
  let pending = "",
    live = true,
    busy = false
  const abort = () => child.kill()
  input.signal.addEventListener("abort", abort, { once: true })
  const errorOutput = new Response(child.stderr).arrayBuffer()
  const next = async () => {
    while (!pending.includes("\n")) {
      const piece = await reader.read()
      if (piece.done) throw new TypeError("TASK24_DESKTOP_V2_HANDLE_EXIT")
      pending += Buffer.from(piece.value).toString("utf8")
      if (pending.length > 10485760) throw new TypeError("TASK24_DESKTOP_V2_HANDLE_OUTPUT")
    }
    const at = pending.indexOf("\n"),
      line = pending.slice(0, at)
    pending = pending.slice(at + 1)
    const reply: unknown = JSON.parse(line)
    if (!reply || typeof reply !== "object" || !("value" in reply) || "error" in reply)
      throw new TypeError("TASK24_DESKTOP_V2_HANDLE_OPERATION")
    return reply.value
  }
  const request = async (value: object) => {
    if (!live || input.signal.aborted || busy) throw new TypeError("TASK24_DESKTOP_V2_HANDLE_CLOSED")
    const line = JSON.stringify(value) + "\n"
    if (Buffer.byteLength(line) > 2097152) throw new TypeError("TASK24_DESKTOP_V2_HANDLE_INPUT")
    busy = true
    try {
      child.stdin.write(line)
      await child.stdin.flush()
      return await next()
    } finally {
      busy = false
    }
  }
  const relative = (value: string) => {
    const target = canonicalDesktopPath(path.join(root, value))
    if (
      !value ||
      path.isAbsolute(value) ||
      value.includes("/") ||
      path.relative(root, target) !== value ||
      !target.startsWith(root + path.sep)
    )
      throw new TypeError("TASK24_DESKTOP_V2_HANDLE_SCOPE")
    return target
  }
  const identities = (raw: unknown) => {
    if (
      !raw ||
      typeof raw !== "object" ||
      Object.values(raw).some((v) => typeof v !== "string" || !/^v2:[0-9]+:[0-9]+:[0-9]+$/.test(v))
    )
      throw new TypeError("TASK24_DESKTOP_V2_HANDLE_IDENTITY")
    return raw as Readonly<Record<string, string>>
  }
  try {
    const parents = identities(
      await request({
        root,
        source,
        writable: input.mode !== "read",
        tempIdentity: proof.identity,
        tempOwnerSha256: proof.ownerSha256,
      }),
    )
    for (const [name, id] of Object.entries(input.parents)) {
      if (name === root || name.startsWith(root + path.sep)) continue
      if (parents[name] !== id) throw new TypeError("TASK24_DESKTOP_V2_PARENT_DRIFT")
    }
    const dirs = identities(
      await request({
        op: "tree",
        create: input.mode === "create-profile",
        layout: input.mode === "read" ? [] : desktopProfileLayoutV2,
      }),
    )
    for (const [name, id] of Object.entries(input.parents))
      if (dirs[name] !== id) throw new TypeError("TASK24_DESKTOP_V2_DIRECTORY_DRIFT")
    if (input.parents[root] && dirs[root] !== input.parents[root]) throw new TypeError("TASK24_DESKTOP_V2_ROOT_DRIFT")
    await revalidateDesktopProbeEnvironment(env)
    const read = async (name: string) => {
      const target = relative(name),
        raw = await request({ op: "read", relative: name })
      if (!Array.isArray(raw) || raw.length !== 2 || raw.some((v) => typeof v !== "string"))
        throw new TypeError("TASK24_DESKTOP_V2_HANDLE_READ")
      const bytes = Buffer.from(raw[1], "base64")
      if (bytes.length > 1048576 || bytes.toString("base64") !== raw[1] || !/^v2:[0-9]+:[0-9]+:[0-9]+$/.test(raw[0]))
        throw new TypeError("TASK24_DESKTOP_V2_HANDLE_READ")
      return { identity: { path: target, fileID: raw[0] as string, sha256: sha256Bytes(bytes) }, bytes }
    }
    const io: DesktopPublicationV2 = {
      async directories() {
        return identities(await request({ op: "identities" }))
      },
      async pin(file) {
        const name = path.relative(root, file.path)
        relative(name)
        await request({ op: "pin", relative: name })
        if (canonicalJson((await read(name)).identity) !== canonicalJson(file))
          throw new TypeError("TASK24_DESKTOP_V2_FILE_DRIFT")
      },
      async write(name, text) {
        relative(name)
        if (input.mode === "read") throw new TypeError("TASK24_DESKTOP_V2_READ_ONLY")
        await request({ op: "write", relative: name, data: Buffer.from(text).toString("base64") })
        return (await read(name)).identity
      },
      async remove(file) {
        const name = path.relative(root, file.path)
        relative(name)
        if (input.mode === "read" || name !== "state\\active.json")
          throw new TypeError("TASK24_DESKTOP_V2_REMOVE_SCOPE")
        await request({ op: "pin", relative: name, deleting: true })
        if (canonicalJson((await read(name)).identity) !== canonicalJson(file))
          throw new TypeError("TASK24_DESKTOP_V2_FILE_DRIFT")
        await request({ op: "remove", relative: name })
      },
      async acquire(names) {
        names.forEach(relative)
        await request({ op: "acquire", names })
      },
      async release() {
        await request({ op: "release" })
      },
      read,
    }
    return await use(io)
  } finally {
    live = false
    input.signal.removeEventListener("abort", abort)
    child.stdin.end()
    child.kill()
    await child.exited
    await errorOutput
    reader.releaseLock()
  }
}
