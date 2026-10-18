import path from "node:path"
import { canonicalJson } from "../../campaign/canonical"
import { sha256Text } from "../../hash"
import { directoryIdentity, fileIdentity } from "../storage"
import { type FileIdentity } from "../contracts"
import { canonicalDesktopPath } from "./compatibility"

/** The helper holds non-delete-sharing handles, including every ancestor, until the callback returns.
 * Directory/file creation is FILE_CREATE relative to those handles, never a checked pathname reopened later.
 * There is deliberately no path-based fallback on an unsupported host. */
const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DesktopPublication {
  [StructLayout(LayoutKind.Sequential)] struct US { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OA { public uint Length; public IntPtr Root, Name; public uint Attributes; public IntPtr Security, Quality; }
  [StructLayout(LayoutKind.Sequential)] struct IOS { public IntPtr Status; public UIntPtr Information; }
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes, CLo, CHi, ALo, AHi, WLo, WHi, Volume, SizeHi, SizeLo, Links, IndexHi, IndexLo; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string p, uint a, uint s, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr h, uint a, ref OA o, out IOS io, IntPtr size, uint attrs, uint share, uint disposition, uint options, IntPtr ea, uint eaSize);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder b, uint size, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(SafeFileHandle h, byte[] b, uint size, out uint written, IntPtr overlapped);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(SafeFileHandle h);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h, int info, byte[] data, uint size);
  static readonly Dictionary<string, SafeFileHandle> dirs = new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
  static readonly Dictionary<string, SafeFileHandle> files = new Dictionary<string, SafeFileHandle>(StringComparer.OrdinalIgnoreCase);
  static string root;
  static bool creating;
  static bool reading;
  static Exception Error() { return new Win32Exception(Marshal.GetLastWin32Error()); }
  static void Check(SafeFileHandle h, string expected, bool directory) {
    Info info;
    if (h.IsInvalid || !GetFileInformationByHandle(h, out info)) throw Error();
    if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory || (!directory && info.Links != 1)) throw new IOException("Unsafe file kind");
    var b = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, 0);
    if (length == 0 || length >= b.Capacity || !String.Equals(b.ToString(), @"\\?\" + expected, StringComparison.OrdinalIgnoreCase)) throw new IOException("Path binding");
  }
  static SafeFileHandle Relative(SafeFileHandle parent, string name, bool directory, bool create, string expected) {
    if (name.Length == 0 || name.IndexOfAny(new char[] {'\\', '/', ':', '\0'}) >= 0 || name == "." || name == "..") throw new IOException("Relative name");
    var u = new US(); u.Length = (ushort)(name.Length * 2); u.MaximumLength = (ushort)(u.Length + 2); u.Buffer = Marshal.StringToHGlobalUni(name);
    var memory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US)));
    try {
      Marshal.StructureToPtr(u, memory, false);
      var o = new OA(); o.Length = (uint)Marshal.SizeOf(typeof(OA)); o.Root = parent.DangerousGetHandle(); o.Name = memory; o.Attributes = 0x40;
      IntPtr raw; IOS io;
      uint access = directory ? 0x1000A0u : create ? 0x110082u : 0x110080u;
      int status = NtCreateFile(out raw, access, ref o, out io, IntPtr.Zero, directory ? 0x10u : 0x80u, 1, create ? 2u : 1u, directory ? 0x200021u : 0x200060u, IntPtr.Zero, 0);
      if (status < 0) throw new IOException("NT create " + status.ToString("X8"));
      var h = new SafeFileHandle(raw, true);
      try { Check(h, expected, directory); return h; } catch { h.Dispose(); throw; }
    } finally { Marshal.FreeHGlobal(memory); Marshal.FreeHGlobal(u.Buffer); }
  }
  public static void OpenParent(string value) {
    root = value;
    string current = Path.GetPathRoot(root);
    var drive = CreateFileW(current, 0x1000A0, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    try { Check(drive, current, true); dirs.Add(current, drive); } catch { drive.Dispose(); throw; }
    string parent = Path.GetDirectoryName(root);
    foreach (string part in parent.Substring(current.Length).Split('\\')) {
      string next = Path.Combine(current, part);
      dirs.Add(next, Relative(dirs[current], part, true, false, next)); current = next;
    }
  }
  static void Directory(string relative, bool create) {
    string target = Path.Combine(root, relative);
    if (dirs.ContainsKey(target)) return;
    string parent = Path.GetDirectoryName(target);
    dirs.Add(target, Relative(dirs[parent], Path.GetFileName(target), true, create, target));
  }
  public static void Tree(bool create, bool profile) {
    creating = create;
    reading = !create && !profile;
    dirs.Add(root, Relative(dirs[Path.GetDirectoryName(root)], Path.GetFileName(root), true, create, root));
    if(profile) { Directory("state", create); Directory(@"state\grants", create); }
  }
  public static void Directories() {
    if(reading) throw new IOException("Read only");
    foreach (string relative in new string[] {"home-oc-task24-dd479", @"home-oc-task24-dd479\AppData", @"home-oc-task24-dd479\AppData\Local", @"home-oc-task24-dd479\AppData\Local\Docker", @"home-oc-task24-dd479\AppData\Roaming", @"home-oc-task24-dd479\AppData\Roaming\Docker", "frontend", "cli", "temp"}) Directory(relative, creating);
  }
  public static void Write(string relative, string encoded) {
    if(reading) throw new IOException("Read only");
    string target = Path.Combine(root, relative);
    var h = Relative(dirs[Path.GetDirectoryName(target)], Path.GetFileName(target), false, true, target);
    files.Add(relative, h);
    byte[] data = Convert.FromBase64String(encoded); uint written;
    if (!WriteFile(h, data, (uint)data.Length, out written, IntPtr.Zero) || written != data.Length || !FlushFileBuffers(h)) throw Error();
  }
  public static void Pin(string relative) {
    if (files.ContainsKey(relative)) return;
    string target = Path.Combine(root, relative);
    files.Add(relative, Relative(dirs[Path.GetDirectoryName(target)], Path.GetFileName(target), false, false, target));
  }
  public static void Remove(string relative) {
    if(reading) throw new IOException("Read only");
    var h = files[relative];
    if (!SetFileInformationByHandle(h, 4, new byte[] {1}, 1)) throw Error();
    h.Dispose(); files.Remove(relative);
  }
  public static void Close() {
    foreach (var h in files.Values) h.Dispose();
    var values = new List<SafeFileHandle>(dirs.Values); values.Reverse(); foreach (var h in values) h.Dispose();
  }
}
'@
try {
  $first = [Console]::ReadLine() | ConvertFrom-Json
  [DesktopPublication]::OpenParent([string]$first.root)
  [Console]::WriteLine('pinned')
  while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $line | ConvertFrom-Json
    switch ($request.op) {
      'tree' { [DesktopPublication]::Tree([bool]$request.create, [bool]$request.profile) }
      'directories' { [DesktopPublication]::Directories() }
      'write' { [DesktopPublication]::Write([string]$request.relative, [string]$request.data) }
      'pin' { [DesktopPublication]::Pin([string]$request.relative) }
      'remove' { [DesktopPublication]::Remove([string]$request.relative) }
      'close' { [Console]::WriteLine('ok'); exit 0 }
      default { throw 'Invalid operation' }
    }
    [Console]::WriteLine('ok')
    [Console]::Out.Flush()
  }
} catch { [Console]::WriteLine('failed'); exit 1 }
finally { [DesktopPublication]::Close() }
`

export type DesktopPublication = {
  directories(): Promise<void>
  pin(file: FileIdentity): Promise<void>
  write(relative: string, text: string): Promise<FileIdentity>
  remove(file: FileIdentity): Promise<void>
}

export async function withDesktopPublication<T>(
  root: string,
  mode: "create" | "existing",
  callback: (publication: DesktopPublication) => Promise<T>,
  expected: { parentIdentity?: string; rootIdentity?: string; layout?: "profile" | "read" } = {},
): Promise<T> {
  if (process.platform !== "win32") throw new TypeError("TASK24_DESKTOP_PUBLICATION_UNAVAILABLE")
  canonicalDesktopPath(root)
  const parent = path.dirname(root)
  const parentID = expected.parentIdentity ?? (await directoryIdentity(parent))
  const temp = canonicalDesktopPath(process.env.TEMP ?? "")
  await directoryIdentity(temp)
  const child = Bun.spawn(
    [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      cwd: temp,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
      env: {
        SystemRoot: "C:\\Windows",
        WINDIR: "C:\\Windows",
        PATH: "C:\\Windows\\System32",
        TEMP: temp,
        TMP: temp,
        HOME: temp,
        USERPROFILE: temp,
        APPDATA: temp,
        LOCALAPPDATA: temp,
        PSModuleAnalysisCachePath: "NUL",
      },
    },
  )
  const timer = setTimeout(() => child.kill(), 30000)
  const reader = child.stdout.getReader()
  let pending = ""
  const next = async () => {
    while (!pending.includes("\n")) {
      const part = await reader.read()
      if (part.done) throw new TypeError("TASK24_DESKTOP_PUBLICATION_HELPER")
      pending += Buffer.from(part.value).toString("utf8")
      if (pending.length > 1024) throw new TypeError("TASK24_DESKTOP_PUBLICATION_PROTOCOL")
    }
    const index = pending.indexOf("\n")
    const line = pending.slice(0, index).trim()
    pending = pending.slice(index + 1)
    return line
  }
  const request = async (input: object, reply = "ok") => {
    const line = JSON.stringify(input) + "\n"
    if (Buffer.byteLength(line) > 1048576) throw new TypeError("TASK24_DESKTOP_PUBLICATION_SIZE")
    child.stdin.write(line)
    await child.stdin.flush()
    if ((await next()) !== reply) throw new TypeError("TASK24_DESKTOP_PUBLICATION_HELPER")
  }
  const relativePath = (relative: string) => {
    const target = canonicalDesktopPath(path.join(root, relative))
    if (
      !relative ||
      path.isAbsolute(relative) ||
      path.relative(root, target) !== relative ||
      !target.startsWith(root + path.sep)
    )
      throw new TypeError("TASK24_DESKTOP_PUBLICATION_SCOPE")
    return target
  }
  try {
    await request({ root }, "pinned")
    if ((await directoryIdentity(parent)) !== parentID) throw new TypeError("TASK24_DESKTOP_PARENT_DRIFT")
    if (expected.layout === "read" && mode !== "existing") throw new TypeError("TASK24_DESKTOP_READ_ONLY")
    await request({ op: "tree", create: mode === "create", profile: expected.layout !== "read" })
    if (expected.rootIdentity && (await directoryIdentity(root)) !== expected.rootIdentity)
      throw new TypeError("TASK24_DESKTOP_PROFILE_DRIFT")
    if (mode === "existing" && expected.layout !== "read") await request({ op: "directories" })
    return await callback({
      async directories() {
        if (expected.layout === "read") throw new TypeError("TASK24_DESKTOP_READ_ONLY")
        await request({ op: "directories" })
      },
      async pin(file) {
        const relative = path.relative(root, file.path)
        relativePath(relative)
        await request({ op: "pin", relative })
        if (canonicalJson(await fileIdentity(file.path)) !== canonicalJson(file))
          throw new TypeError("TASK24_DESKTOP_FILE_DRIFT")
      },
      async write(relative, text) {
        if (expected.layout === "read") throw new TypeError("TASK24_DESKTOP_READ_ONLY")
        const target = relativePath(relative)
        await request({ op: "write", relative, data: Buffer.from(text).toString("base64") })
        const file = await fileIdentity(target)
        if (file.sha256 !== sha256Text(text)) throw new TypeError("TASK24_DESKTOP_PUBLICATION_CONTENT")
        return file
      },
      async remove(file) {
        if (expected.layout === "read") throw new TypeError("TASK24_DESKTOP_READ_ONLY")
        const relative = path.relative(root, file.path)
        relativePath(relative)
        await request({ op: "pin", relative })
        if (canonicalJson(await fileIdentity(file.path)) !== canonicalJson(file))
          throw new TypeError("TASK24_DESKTOP_PUBLICATION_FILE_DRIFT")
        await request({ op: "remove", relative })
      },
    })
  } finally {
    // Only this child is stopped. OS handle closure releases the lease even on failed operations or parent crash.
    child.stdin.end()
    child.kill()
    await child.exited
    reader.releaseLock()
    clearTimeout(timer)
  }
}

/** The callback deadline ends before the helper's fixed 30s handle lifetime. */
export async function withDesktopReadLease<T>(file: FileIdentity, callback: (signal: AbortSignal) => Promise<T>) {
  const began = Date.now(),
    root = path.dirname(file.path)
  return withDesktopPublication(
    root,
    "existing",
    async (publication) => {
      await publication.pin(file)
      const remaining = Math.min(15000, 25000 - (Date.now() - began))
      if (remaining <= 0) throw new TypeError("TASK24_DESKTOP_DEADLINE")
      const signal = AbortSignal.timeout(remaining)
      const operation = callback(signal)
      const timeout = new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(new TypeError("TASK24_DESKTOP_DEADLINE")), { once: true }),
      )
      return Promise.race([operation, timeout])
    },
    { layout: "read", rootIdentity: await directoryIdentity(root) },
  )
}
