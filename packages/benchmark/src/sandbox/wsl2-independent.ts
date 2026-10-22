import path from "node:path"
import fs from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { freeze, safePath } from "../corpus/evaluation-profile"
import {
  decodeHostRequest,
  requireDPath,
  type HostRequest,
  type DockerRunner,
  type DockerExecution,
  type StorageProof,
} from "./contracts"
import { directoryIdentity, hostCliIdentity, inspectStorage } from "./storage"
import { makeProcessRunner } from "./docker"

const Text = Schema.NonEmptyString
const Registration = Schema.Struct({
  registrationID: Text,
  distribution: Text,
  version: Schema.Int,
  basePath: Text,
  running: Schema.Boolean,
})
export const Wsl2StorageSource = Schema.Struct({
  kind: Schema.Literal("wsl2-independent"),
  disk: Schema.Struct({ path: Text, fileID: Text.check(Schema.isPattern(/^wsl2:\d+:\d+:\d+$/)), volumeID: Text }),
})
const Guest = Schema.Struct({
  engineID: Text,
  kernelRelease: Text,
  cliSha256: Text,
  operatingSystem: Text,
  dockerRoot: Text,
  rootFilesystem: Text,
  rootUUID: Text,
  rootDevice: Text,
  dockerDevice: Text,
  containerdDevice: Text,
  configDevice: Text,
  swapsText: Schema.String,
  workRoot: Text,
  workRealPath: Text,
  workMount: Schema.Struct({ target: Text, source: Text, filesystem: Text }),
  windowsDrives: Schema.Array(Text),
  socket: Schema.Struct({ path: Text, type: Text, uid: Schema.Int }),
  daemon: Schema.Struct({
    pid: Schema.Int.check(Schema.isGreaterThan(0)),
    executable: Text,
    engineID: Text,
    mountNamespace: Text,
    collectorNamespace: Text,
    rootDevice: Text,
    rootInode: Text,
    collectorRootInode: Text,
  }),
  descendantWorkMounts: Schema.Array(Text),
})
export function requireWsl2GuestAccess(request: HostRequest) {
  const host = request.wsl2
  if (!host || host.guestExecution.expiresAt <= Date.now() || host.guestExecution.expiresAt > Date.now() + 3600000)
    throw new TypeError("TASK24_WSL2_GUEST_APPROVAL")
  return host
}
export function mapWsl2Workspace(request: HostRequest, file: string) {
  if (!request.wsl2) return requireDPath(file)
  requireDPath(file)
  if (file !== request.roots.work && !file.startsWith(request.roots.work + "\\"))
    throw new TypeError("TASK24_WSL2_WORKSPACE")
  safePath(file.slice(3).replaceAll("\\", "/"))
  return "/mnt/d/" + file.slice(3).replaceAll("\\", "/")
}
export function unmapWsl2Workspace(request: HostRequest, file: string) {
  if (!request.wsl2) return requireDPath(file)
  if (!file.startsWith("/mnt/d/")) throw new TypeError("TASK24_WSL2_WORKSPACE")
  const windows = "D:\\" + file.slice(7).replaceAll("/", "\\")
  if (mapWsl2Workspace(request, windows) !== file) throw new TypeError("TASK24_WSL2_WORKSPACE")
  return windows
}
export function wsl2GuestInvocation(request: HostRequest, argv: readonly string[]) {
  const host = requireWsl2GuestAccess(request)
  if (!argv.length || argv.some((s) => s.includes("\0"))) throw new TypeError("TASK24_WSL2_ARGUMENTS")
  return [
    "--distribution",
    host.distribution,
    "--user",
    "root",
    "--cd",
    "/",
    "--exec",
    "/usr/bin/env",
    "-i",
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME=/opt/opencode-task24/home",
    "TMPDIR=/opt/opencode-task24/tmp",
    "DOCKER_CONFIG=/opt/opencode-task24/config",
    "DOCKER_HOST=unix:///var/run/docker.sock",
    ...argv,
  ]
}
export function bindWsl2Registration(request: HostRequest, input: unknown) {
  const host = requireWsl2GuestAccess(request)
  const value = Schema.decodeUnknownSync(Registration)(input, { onExcessProperty: "error" })
  if (!value.running) throw new TypeError("TASK24_WSL2_NOT_RUNNING")
  if (
    value.registrationID !== host.registrationID ||
    value.distribution !== host.distribution ||
    value.version !== 2 ||
    requireDPath(value.basePath.replace(/^\\\\\?\\/, "").replace(/\\$/, "")).toLowerCase() !==
      host.installRoot.toLowerCase()
  )
    throw new TypeError("TASK24_WSL2_REGISTRATION")
  return value
}
export function decodeWsl2StorageObservation(input: {
  request: HostRequest
  source: unknown
  registration: unknown
  guest: unknown
}): StorageProof {
  const request = decodeHostRequest(input.request)
  const host = requireWsl2GuestAccess(request)
  const source = Schema.decodeUnknownSync(Wsl2StorageSource)(input.source, { onExcessProperty: "error" })
  const registration = bindWsl2Registration(request, input.registration)
  const guest = Schema.decodeUnknownSync(Guest)(input.guest, { onExcessProperty: "error" })
  if (
    source.disk.path !== path.win32.join(host.installRoot, "ext4.vhdx") ||
    !/microsoft.*wsl2/i.test(guest.kernelRelease) ||
    /docker desktop/i.test(guest.operatingSystem) ||
    guest.cliSha256 !== host.guestCliSha256 ||
    guest.dockerRoot !== "/var/lib/docker" ||
    guest.rootFilesystem !== "ext4" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(guest.rootUUID) ||
    !/^\d+:\d+$/.test(guest.rootDevice) ||
    [guest.dockerDevice, guest.containerdDevice, guest.configDevice].some((d) => d !== guest.rootDevice) ||
    !/^Filename\s+Type\s+Size\s+Used\s+Priority\s*$/.test(guest.swapsText.trim()) ||
    guest.workRoot !== mapWsl2Workspace(request, request.roots.work) ||
    guest.workRealPath !== guest.workRoot ||
    guest.workMount.target !== "/mnt/d" ||
    guest.workMount.source !== "D:\\" ||
    guest.workMount.filesystem !== "9p" ||
    canonicalJson(guest.windowsDrives) !== canonicalJson(["D:\\"]) ||
    guest.socket.path !== request.endpoint.slice(7) ||
    guest.socket.type !== "socket" ||
    guest.socket.uid !== 0 ||
    guest.daemon.executable !== "/usr/bin/dockerd" ||
    guest.daemon.engineID !== guest.engineID ||
    !/^mnt:\[\d+\]$/.test(guest.daemon.mountNamespace) ||
    guest.daemon.mountNamespace !== guest.daemon.collectorNamespace ||
    guest.daemon.rootDevice !== guest.rootDevice ||
    guest.daemon.rootInode !== guest.daemon.collectorRootInode ||
    guest.descendantWorkMounts.length !== 0
  )
    throw new TypeError("TASK24_WSL2_STORAGE_BINDING")
  return freeze({
    backend: "wsl2",
    disk: source.disk,
    dataRoot: host.installRoot,
    swap: { kind: "disabled" },
    engineID: guest.engineID,
    settingsSha256: sha256Text(canonicalJson({ registration, guest, disk: source.disk })),
    observedAt: Date.now(),
  })
}

const pinnedDocker = String.raw`import hashlib, os, stat, sys, re
p='/usr/bin/docker'
s=os.stat(p, follow_symlinks=False)
if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or os.path.realpath(p) != p or hashlib.sha256(open(p,'rb').read()).hexdigest() != sys.argv[1]:
    raise SystemExit('TASK24_WSL2_GUEST_CLI')
work=sys.argv[2]
args=sys.argv[3:]
if args[:4]==['--context','default','container','create']:
    i=4
    while i<len(args) and args[i].startswith('--'):
        flag=args[i]
        if flag in ['--interactive','--read-only']:
            i+=1
            continue
        if flag not in ['--name','--label','--pull','--network','--cap-drop','--security-opt','--user','--pids-limit','--memory','--cpus','--stop-timeout','--log-driver','--tmpfs','--env','--entrypoint','--mount','--workdir'] or i+1>=len(args):
            raise SystemExit('TASK24_WSL2_ARGUMENTS')
        if flag=='--workdir' and (not re.fullmatch(r'/(?:workspace(?:/[a-zA-Z0-9._-]+)*|)', args[i+1]) or any(v in ['.','..'] for v in args[i+1].split('/'))):
            raise SystemExit('TASK24_WSL2_ARGUMENTS')
        if flag=='--mount':
            flags=dict(v.split('=',1) for v in args[i+1].split(',') if '=' in v)
            if flags.get('type')=='bind':
                src=flags.get('src','')
                if not src.startswith(work+'/') or os.path.realpath(src,strict=True)!=src or os.stat(src).st_dev!=os.stat(work).st_dev:
                    raise SystemExit('TASK24_WSL2_WORKSPACE')
                for line in open('/proc/self/mountinfo'):
                    target=re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),line.split(' - ',1)[0].split()[4])
                    if target==work or target.startswith(work+'/'):
                        raise SystemExit('TASK24_WSL2_WORKSPACE')
        i+=2
    if i>=len(args) or not re.fullmatch(r'[a-z0-9./:_-]+@sha256:[a-f0-9]{64}',args[i]):
        raise SystemExit('TASK24_WSL2_ARGUMENTS')
if globals().get('task24_frame') is None:
    os.execv(p, [p] + args)
else:
    import subprocess, selectors, base64, json
    child=subprocess.Popen([p]+args,stdin=sys.stdin.buffer,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    streams=selectors.DefaultSelector()
    streams.register(child.stdout,selectors.EVENT_READ,'stdout')
    streams.register(child.stderr,selectors.EVENT_READ,'stderr')
    buffers={'stdout':bytearray(),'stderr':bytearray()}
    truncated=False
    while streams.get_map():
        for key,_ in streams.select():
            chunk=os.read(key.fileobj.fileno(),32768)
            if not chunk:
                streams.unregister(key.fileobj)
                continue
            limit=task24_frame[key.data]
            remaining=limit-len(buffers[key.data])
            buffers[key.data].extend(chunk[:remaining])
            if len(chunk)>remaining:
                truncated=True
                child.kill()
    exitCode=child.wait()
    print(json.dumps({'nonce':task24_frame['nonce'],'exitCode':exitCode,'stdout':base64.b64encode(buffers['stdout']).decode(),'stderr':base64.b64encode(buffers['stderr']).decode(),'truncated':truncated},separators=(',',':')))`

export function decodeWsl2CommandFrame(
  outer: DockerExecution,
  nonce: string,
  limits: { maxStdoutBytes: number; maxStderrBytes: number },
): DockerExecution {
  if (!outer.started || outer.exitCode !== 0 || outer.truncated || outer.cleanupUncertain)
    throw new TypeError("TASK24_WSL2_COMMAND_FRAME")
  const value = Schema.decodeUnknownSync(
    Schema.Struct({
      nonce: Schema.Literal(nonce),
      exitCode: Schema.Int,
      stdout: Schema.String,
      stderr: Schema.String,
      truncated: Schema.Boolean,
    }),
  )(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(outer.stdout)), { onExcessProperty: "error" })
  const stdout = Buffer.from(value.stdout, "base64"),
    stderr = Buffer.from(value.stderr, "base64")
  if (
    stdout.toString("base64") !== value.stdout ||
    stderr.toString("base64") !== value.stderr ||
    stdout.length > limits.maxStdoutBytes ||
    stderr.length > limits.maxStderrBytes
  )
    throw new TypeError("TASK24_WSL2_COMMAND_FRAME")
  // The root-owned wrapper captured Docker's actual stderr independently. Outer
  // WSL progress is NOT silently filtered from candidate output by string rules.
  return { started: true, exitCode: value.exitCode, stdout, stderr, truncated: value.truncated }
}

/** Generic transport is deliberately not a real-runner attestation (fixtures can exercise it safely). */
export function makeWsl2Transport(input: {
  request: HostRequest
  process: DockerRunner
  observeRegistration: () => Promise<unknown>
  /** Fresh full guest/storage comparison in the SAME invocation, not a TTL cache. */
  storage?: StorageProof
}): DockerRunner {
  const request = decodeHostRequest(input.request)
  requireWsl2GuestAccess(request)
  return {
    async execute(invocation) {
      if (invocation.signal.aborted)
        return { started: false, exitCode: 130, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false }
      const registration = bindWsl2Registration(request, await input.observeRegistration())
      const args = invocation.argv[0] === "--context" ? invocation.argv.slice(2) : invocation.argv
      if (invocation.argv[0] === "--context" && invocation.argv[1] !== "default")
        throw new TypeError("TASK24_WSL2_ENDPOINT")
      const nonce = input.storage ? randomBytes(32).toString("hex") : undefined
      const result = await input.process.execute({
        ...invocation,
        ...(nonce
          ? { maxStdoutBytes: Math.ceil(((invocation.maxStdoutBytes + invocation.maxStderrBytes) * 4) / 3) + 1024 }
          : {}),
        argv: wsl2GuestInvocation(request, [
          "/usr/bin/python3",
          "-I",
          "-c",
          (input.storage
            ? String.raw`import subprocess, json, hashlib
task24_frame=${JSON.stringify({ nonce, stdout: invocation.maxStdoutBytes, stderr: invocation.maxStderrBytes })}
guest=json.loads(subprocess.check_output(['/usr/bin/python3','-I','-c',${JSON.stringify(guestStorageScript(request))}]))
body={'registration':${JSON.stringify(JSON.stringify(registration))},'guest':guest,'disk':${JSON.stringify(JSON.stringify(input.storage.disk))}}
body['registration']=json.loads(body['registration'])
body['disk']=json.loads(body['disk'])
if hashlib.sha256(json.dumps(body,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()!=${JSON.stringify(input.storage.settingsSha256)}:
    raise SystemExit('TASK24_WSL2_STORAGE_BINDING')
`
            : "") + pinnedDocker,
          request.wsl2!.guestCliSha256,
          mapWsl2Workspace(request, request.roots.work),
          "--context",
          "default",
          ...args,
        ]),
      })
      bindWsl2Registration(request, await input.observeRegistration())
      return nonce ? decodeWsl2CommandFrame(result, nonce, invocation) : result
    },
  }
}

function nativeProcesses(request: HostRequest) {
  requireWsl2GuestAccess(request)
  const env = {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    TEMP: request.roots.temp,
    TMP: request.roots.temp,
    // Do not substitute a fake Windows USERPROFILE: WSL must use this account's existing global settings.
    APPDATA: request.roots.config,
    LOCALAPPDATA: request.roots.temp,
    PATH: "C:\\Windows\\System32",
    WSLENV: "",
    PSModuleAnalysisCachePath: path.join(request.roots.temp, "ModuleAnalysisCache"),
  }
  const process = makeProcessRunner({ executable: request.cli.path, argvPrefix: [], cwd: request.roots.temp, env })
  const powershell = makeProcessRunner({
    executable: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    argvPrefix: ["-NoProfile", "-NonInteractive"],
    cwd: request.roots.temp,
    env,
  })
  const invoke = async (runner: DockerRunner, argv: readonly string[]) => {
    if (canonicalJson(await hostCliIdentity(request)) !== canonicalJson(request.cli))
      throw new TypeError("TASK24_LINUX_CLI_CHANGED")
    const result = await runner.execute({
      argv,
      timeoutMs: 15000,
      maxStdoutBytes: 1048576,
      maxStderrBytes: 65536,
      signal: new AbortController().signal,
    })
    if (canonicalJson(await hostCliIdentity(request)) !== canonicalJson(request.cli))
      throw new TypeError("TASK24_LINUX_CLI_CHANGED")
    if (!result.started || result.exitCode !== 0 || result.truncated || result.cleanupUncertain)
      throw new TypeError("TASK24_WSL2_OBSERVATION")
    return result.stdout
  }
  const observeRegistration = async () => {
    const host = requireWsl2GuestAccess(request)
    const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$r=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{${host.registrationID}}';[pscustomobject]@{registrationID='${host.registrationID}';distribution=[string]$r.DistributionName;version=[int]$r.Version;basePath=[string]$r.BasePath}|ConvertTo-Json -Compress`
    const raw = await invoke(powershell, ["-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")])
    const runningBytes = Buffer.from(await invoke(process, ["--list", "--running", "--quiet"]))
    const running = runningBytes
      .toString(runningBytes.includes(0) ? "utf16le" : "utf8")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map((s) => s.trim())
    const registration = {
      ...JSON.parse(
        Buffer.from(raw)
          .toString("utf8")
          .replace(/^\uFEFF/, ""),
      ),
      running: running.includes(host.distribution),
    }
    bindWsl2Registration(request, registration)
    await directoryIdentity(host.installRoot)
    return registration
  }
  return { process, observeRegistration, invoke }
}
export function makeNativeWsl2Transport(request: HostRequest) {
  return makeWsl2Transport({ request, ...nativeProcesses(request) })
}

/** Controller-only optimized transport; every call still performs fresh storage/engine checks. */
export function makeNativeAttestedWsl2Transport(request: HostRequest, storage: StorageProof) {
  return makeWsl2Transport({ request, storage, ...nativeProcesses(request) })
}

function guestStorageScript(request: HostRequest) {
  return String.raw`import os, json, stat, hashlib, platform, subprocess, re
p='/usr/bin/docker'
s=os.stat(p,follow_symlinks=False)
if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or os.path.realpath(p) != p or hashlib.sha256(open(p,'rb').read()).hexdigest() != ${JSON.stringify(request.wsl2!.guestCliSha256)}:
    raise SystemExit('TASK24_WSL2_GUEST_CLI')
def device(p):
    d=os.stat(p).st_dev
    return str(os.major(d))+':'+str(os.minor(d))
def unescape(s):
    return re.sub(r'\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),s)
mounts=[]
for line in open('/proc/self/mountinfo'):
    left,right=line.strip().split(' - ',1)
    a,b=left.split(),right.split()
    mounts.append({'target':unescape(a[4]),'source':unescape(b[1]),'filesystem':b[0]})
def mount(p):
    return max((m for m in mounts if m['target']=='/' or p==m['target'] or p.startswith(m['target']+'/')),key=lambda m:len(m['target']))
work=${JSON.stringify(mapWsl2Workspace(request, request.roots.work))}
inodes=[]
for line in open('/proc/net/unix'):
    parts=line.split()
    if len(parts)==8 and parts[7] in ['/var/run/docker.sock','/run/docker.sock'] and parts[3]=='00010000': inodes.append(parts[6])
if len(inodes)!=1: raise SystemExit('TASK24_WSL2_SOCKET_OWNER')
owners=[]
for pid in os.listdir('/proc'):
    if not pid.isdigit(): continue
    try:
        if os.readlink('/proc/'+pid+'/exe')!='/usr/bin/dockerd': continue
        if any(os.readlink('/proc/'+pid+'/fd/'+fd)=='socket:['+inodes[0]+']' for fd in os.listdir('/proc/'+pid+'/fd')): owners.append(pid)
    except (FileNotFoundError,ProcessLookupError,PermissionError): continue
if len(owners)!=1: raise SystemExit('TASK24_WSL2_SOCKET_OWNER')
pid=owners[0]
root='/proc/'+pid+'/root'
namespace=os.readlink('/proc/'+pid+'/ns/mnt')
collectorNamespace=os.readlink('/proc/self/ns/mnt')
if namespace!=collectorNamespace or device(root)!=device('/') or os.stat(root).st_ino!=os.stat('/').st_ino: raise SystemExit('TASK24_WSL2_DAEMON_NAMESPACE')
docker=json.loads(subprocess.check_output(['/usr/bin/docker','--host','unix:///var/run/docker.sock','info','--format','{{json .}}'],env=os.environ))
s=os.stat('/var/run/docker.sock')
config=[device(p) for p in ['/opt/opencode-task24/home','/opt/opencode-task24/config','/opt/opencode-task24/tmp']]
if len(set(config))!=1: raise SystemExit('TASK24_WSL2_CONFIG_DEVICE')
print(json.dumps({'engineID':docker['ID'],'kernelRelease':platform.release(),'cliSha256':hashlib.sha256(open('/usr/bin/docker','rb').read()).hexdigest(),'operatingSystem':docker['OperatingSystem'],
'dockerRoot':docker['DockerRootDir'],'rootFilesystem':mount('/')['filesystem'],'rootUUID':subprocess.check_output(['/usr/bin/findmnt','-n','-o','UUID','--target','/'],text=True).strip(),
'rootDevice':device('/'),'dockerDevice':device('/var/lib/docker'),'containerdDevice':device('/var/lib/containerd'),'configDevice':config[0],
'swapsText':open('/proc/swaps').read(),'workRoot':work,'workRealPath':os.path.realpath(work,strict=True),'workMount':mount(work),
'windowsDrives':sorted(set(m['source'] for m in mounts if re.match(r'^[A-Za-z]:',m['source']))),
'socket':{'path':'/var/run/docker.sock','type':'socket' if stat.S_ISSOCK(s.st_mode) else 'other','uid':s.st_uid},
'daemon':{'pid':int(pid),'executable':'/usr/bin/dockerd','engineID':open(root+'/var/lib/docker/engine-id').read().strip(),'mountNamespace':namespace,'collectorNamespace':collectorNamespace,'rootDevice':device(root),'rootInode':str(os.stat(root).st_ino),'collectorRootInode':str(os.stat('/').st_ino)},
'descendantWorkMounts':[m['target'] for m in mounts if m['target']==work or m['target'].startswith(work+'/')]}))`
}
export function wsl2StorageInvocation(request: HostRequest) {
  return wsl2GuestInvocation(request, ["/usr/bin/python3", "-I", "-c", guestStorageScript(request)])
}
export async function readIndependentWslStorage(inputRequest: HostRequest, rawSource: unknown): Promise<StorageProof> {
  // Supported standard single-root WSL2 layout: native Lxss BasePath + ext4.vhdx is the named distro's disk.
  // Trust WSL's registration/mount implementation; this is not a Desktop dual-disk or hostile-root attestation.
  const request = decodeHostRequest(inputRequest)
  const host = requireWsl2GuestAccess(request)
  const source = Schema.decodeUnknownSync(Wsl2StorageSource)(rawSource, { onExcessProperty: "error" })
  if (source.disk.path !== path.join(host.installRoot, "ext4.vhdx")) throw new TypeError("TASK24_WSL2_STORAGE_BINDING")
  const native = nativeProcesses(request)
  const registration = await native.observeRegistration()
  const stat = await fs.lstat(source.disk.path, { bigint: true })
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    `wsl2:${stat.dev}:${stat.ino}:${stat.birthtimeNs}` !== source.disk.fileID ||
    String(stat.dev) !== source.disk.volumeID
  )
    throw new TypeError("TASK24_WSL2_DISK_IDENTITY")
  const guest = JSON.parse(
    Buffer.from(await native.invoke(native.process, wsl2StorageInvocation(request))).toString("utf8"),
  )
  const after = await native.observeRegistration()
  if (canonicalJson(registration) !== canonicalJson(after)) throw new TypeError("TASK24_WSL2_REGISTRATION")
  const proof = decodeWsl2StorageObservation({ request, source, registration, guest })
  if ((await inspectStorage(proof)).kind !== "ready") throw new TypeError("TASK24_WSL2_DISK_IDENTITY")
  return proof
}
