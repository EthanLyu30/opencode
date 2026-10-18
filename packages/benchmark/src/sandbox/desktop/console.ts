import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { sha256Text } from "../../hash"
import { desktopProbeEnvironment, readDesktopProbeRootProof, revalidateDesktopProbeEnvironment } from "./probe-root"
import { desktopProbeBootstrap } from "./probe-worker"
import { withDesktopReadLease, desktopConsoleImageIdentity } from "./publication"

const Packet = Schema.Struct({
  panel: Schema.String,
  panelSha256: Schema.String,
  requestSha256: Schema.String,
  controllerID: Schema.String,
  launchID: Schema.String,
  phase: Schema.Literals(["prepare-profile", "start-readonly"]),
  expiresAt: Schema.Number,
})
type ConsolePacket = typeof Packet.Type
export function validateDesktopConsolePacket(raw: unknown): ConsolePacket {
  const p = Schema.decodeUnknownSync(Packet)(raw, { onExcessProperty: "error" })
  if (
    !p.panel ||
    Buffer.byteLength(p.panel) > 12288 ||
    Buffer.byteLength(canonicalJson(p)) > 16384 ||
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(p.panel) ||
    p.panelSha256 !== sha256Text(p.panel) ||
    !/^[a-f0-9]{64}$/.test(p.requestSha256) ||
    !/^[a-f0-9-]{36}$/.test(p.controllerID) ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(p.launchID) ||
    !Number.isFinite(p.expiresAt) ||
    p.expiresAt <= Date.now()
  )
    throw new TypeError("TASK24_DESKTOP_CONSOLE_PACKET")
  return p
}
export function desktopConsolePhrase(phase: ConsolePacket["phase"], launchID: string, challenge: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(launchID) || !/^[a-f0-9]{24}$/.test(challenge))
    throw new TypeError("TASK24_DESKTOP_CHALLENGE")
  return `${phase === "prepare-profile" ? "PREPARE" : "START"} ${launchID} ${challenge}`
}
export function desktopConsoleInputMatches(expected: string, input: string | null, expiresAt: number) {
  return (
    input !== null &&
    input.length <= 256 &&
    /^[\x20-\x7e]+$/.test(input) &&
    input === expected &&
    Date.now() < expiresAt
  )
}

// No console allocation/attachment, pseudo terminal fallback, shared mode change, shell input or ReadLine.
export const desktopConsoleProgram = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$p=$env:OC_TASK24_PROBE_ROOT | ConvertFrom-Json
${desktopProbeBootstrap}
$p=$env:OC_TASK24_CONSOLE_PACKET | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class DesktopConsole {
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr h, out uint mode);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool WriteConsoleW(IntPtr h, string s, uint n, out uint written, IntPtr reserved);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetNumberOfConsoleInputEvents(IntPtr h, out uint n);
  [StructLayout(LayoutKind.Explicit, Size=20)] struct Input {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(4)] public int Down;
    [FieldOffset(8)] public ushort Repeat;
    [FieldOffset(10)] public ushort Key;
    [FieldOffset(14)] public char Char;
    [FieldOffset(16)] public uint Control;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool ReadConsoleInputW(IntPtr h, [Out] Input[] input, uint count, out uint read);
  static bool Write(IntPtr h, string s) { uint n; return WriteConsoleW(h,s,(uint)s.Length,out n,IntPtr.Zero) && n==s.Length; }
  public static bool Matches(string expected,string input,long expires) {
    if(input==null || input.Length>256 || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()>=expires) return false;
    foreach(char c in input) if(c<32 || c>126) return false;
    return String.Equals(expected,input,StringComparison.Ordinal);
  }
  public static bool AcceptCharacter(ushort key,char value,uint control,ushort repeat,StringBuilder input) {
    if((control & 15)!=0) return false;
    if(value==0 && (key==16 || key==160 || key==161 || key==20)) return true;
    if(value<32 || value>126 || repeat==0 || input.Length+repeat>256) return false;
    input.Append(value,(int)repeat); return true;
  }
  public static int Run(string panel,string panelHash,string requestHash,string controller,string launch,string phase,long expires) {
    IntPtr stdin=GetStdHandle(-10), stdout=GetStdHandle(-11), stderr=GetStdHandle(-12); uint mode, pending;
    if(!GetConsoleMode(stdin,out mode) || !GetConsoleMode(stdout,out mode) || !GetConsoleMode(stderr,out mode)) return 3;
    if(!GetNumberOfConsoleInputEvents(stdin,out pending) || pending!=0) return 2;
    using(var sha=SHA256.Create()) if(BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(panel))).Replace("-","").ToLowerInvariant()!=panelHash) return 3;
    if(!Write(stderr,panel+"\r\n")) return 3;
    byte[] bytes=new byte[12]; using(var rng=RandomNumberGenerator.Create()) rng.GetBytes(bytes);
    string challenge=BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant();
    string expected=(phase=="prepare-profile"?"PREPARE":"START")+" "+launch+" "+challenge;
    if(!Write(stderr,"Type exactly once to confirm: "+expected+"\r\n> ")) return 3;
    var watch=Stopwatch.StartNew(); var input=new StringBuilder(); var events=new Input[32];
    while(watch.ElapsedMilliseconds<60000 && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()<expires) {
      uint wait=WaitForSingleObject(stdin,50); if(wait==258) continue; if(wait!=0) return 3;
      uint read; if(!ReadConsoleInputW(stdin,events,32,out read)) return 3;
      for(int i=0;i<read;i++) {
        var e=events[i]; if(e.Type!=1 || e.Down==0) continue;
        if(e.Key==13) {
          for(int j=i+1;j<read;j++) if(events[j].Type==1 && events[j].Down!=0) return 2;
          if(!GetNumberOfConsoleInputEvents(stdin,out pending)) return 3;
          if(pending!=0) return 2;
          return Matches(expected,input.ToString(),expires)?0:2;
        }
        if(!AcceptCharacter(e.Key,e.Char,e.Control,e.Repeat,input)) return 2;
      }
    }
    return 2;
  }
}
'@
exit [DesktopConsole]::Run([string]$p.panel,[string]$p.panelSha256,[string]$p.requestSha256,[string]$p.controllerID,[string]$p.launchID,[string]$p.phase,[long]$p.expiresAt)
`
export async function readDesktopConsoleDecision(
  raw: ConsolePacket,
  signal: AbortSignal,
): Promise<"confirmed" | "cancelled" | "unavailable"> {
  const packet = validateDesktopConsolePacket(raw)
  if (signal.aborted) return "cancelled"
  if (process.platform !== "win32" || !process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY)
    return "unavailable"
  const exe = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  try {
    // Lease the actual helper image; never execute an unpinned replacement between validation and invocation.
    return await withDesktopReadLease(
      await desktopConsoleImageIdentity(),
      async (leaseSignal) => {
        const combined = AbortSignal.any([signal, leaseSignal])
        const base = await desktopProbeEnvironment()
        await revalidateDesktopProbeEnvironment(base)
        const proof = readDesktopProbeRootProof(base)
        const env = {
          ...base,
          OC_TASK24_CONSOLE_PACKET: canonicalJson(packet),
          OC_TASK24_PROBE_ROOT: canonicalJson({
            cwd: base.TEMP,
            tempIdentity: proof.identity,
            tempOwnerSha256: proof.ownerSha256,
          }),
        }
        if (combined.aborted) return "cancelled"
        const child = Bun.spawn(
          [
            exe,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(desktopConsoleProgram, "utf16le").toString("base64"),
          ],
          { cwd: env.TEMP, env, stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true },
        )
        const abort = () => child.kill()
        const timer = setTimeout(abort, Math.max(1, Math.min(60000, packet.expiresAt - Date.now())))
        combined.addEventListener("abort", abort, { once: true })
        try {
          const code = await child.exited
          if (combined.aborted || Date.now() >= packet.expiresAt) return "cancelled"
          return code === 0 ? "confirmed" : code === 2 ? "cancelled" : "unavailable"
        } finally {
          clearTimeout(timer)
          combined.removeEventListener("abort", abort)
          child.kill()
          await child.exited
        }
      },
      "console",
    )
  } catch {
    return signal.aborted ? "cancelled" : "unavailable"
  }
}
