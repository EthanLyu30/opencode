import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { decodeHostRequest } from "../../src/sandbox/contracts"
import { sha256Text } from "../../src/hash"
import { hostFixture, sessionFixture } from "./fixture"
import { makeDockerRunner, makeProcessRunner, isRealDockerRunner } from "../../src/sandbox/docker"
import { makeStorageProbe } from "../../src/sandbox/storage-source"
import { inspectLinuxHost } from "../../src/sandbox/preflight"
import { inspectStorage } from "../../src/sandbox/storage"
import { createOwnedContainer, inspectOwnedContainer, cleanupOwnedContainer } from "../../src/sandbox/ownership"

async function fixture() {
  const f = await hostFixture()
  const installRoot = path.join(f.root, "fresh")
  await fs.mkdir(installRoot)
  const disk = path.join(installRoot, "ext4.vhdx")
  await fs.writeFile(disk, "synthetic fresh disk, never mounted")
  const stat = await fs.stat(disk, { bigint: true })
  const request = {
    ...f.request,
    cli: { ...f.cli, path: "C:\\Windows\\System32\\wsl.exe" },
    endpoint: "unix:///var/run/docker.sock",
    wsl2: {
      distribution: "opencode-task24-isolated",
      registrationID: "11111111-2222-4333-8444-555555555555",
      installRoot,
      guestCliSha256: "a".repeat(64),
      guestExecution: { approved: true as const, expiresAt: Date.now() + 60000 },
    },
  }
  const source = {
    kind: "wsl2-independent" as const,
    disk: { path: disk, fileID: `wsl2:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`, volumeID: String(stat.dev) },
  }
  const registration = {
    registrationID: request.wsl2.registrationID,
    distribution: request.wsl2.distribution,
    version: 2,
    basePath: installRoot,
    running: true,
  }
  const guest = {
    engineID: "independent-engine",
    kernelRelease: "6.18.33.1-microsoft-standard-WSL2",
    cliSha256: "a".repeat(64),
    dockerRoot: "/var/lib/docker",
    operatingSystem: "Ubuntu 24.04.4 LTS",
    rootFilesystem: "ext4",
    rootDevice: "8:16",
    dockerDevice: "8:16",
    containerdDevice: "8:16",
    configDevice: "8:16",
    rootUUID: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    swapsText: "Filename\tType\tSize\tUsed\tPriority\n",
    workRoot: "/mnt/d/" + request.roots.work.slice(3).replaceAll("\\", "/"),
    workRealPath: "/mnt/d/" + request.roots.work.slice(3).replaceAll("\\", "/"),
    workMount: { target: "/mnt/d", source: "D:\\", filesystem: "9p" },
    windowsDrives: ["D:\\"],
    socket: { path: "/var/run/docker.sock", type: "socket", uid: 0 },
    daemon: {
      pid: 42,
      executable: "/usr/bin/dockerd",
      engineID: "independent-engine",
      mountNamespace: "mnt:[1234]",
      collectorNamespace: "mnt:[1234]",
      rootDevice: "8:16",
      rootInode: "2",
      collectorRootInode: "2",
    },
    descendantWorkMounts: [],
  }
  return { ...f, request, source, registration, guest }
}

test("independent WSL2 is opt-in and cannot select Desktop, remote sockets or an unrelated install directory", async () => {
  const f = await fixture()
  try {
    expect(decodeHostRequest(f.request).endpoint).toBe("unix:///var/run/docker.sock")
    for (const change of [
      { wsl2: undefined },
      { cli: { ...f.request.cli, path: "C:\\Windows\\System32\\cmd.exe" } },
      { endpoint: "tcp://localhost:2375" },
      { endpoint: "unix:///mnt/c/docker.sock" },
      { wsl2: { ...f.request.wsl2, distribution: "docker-desktop" } },
      { wsl2: { ...f.request.wsl2, distribution: "Ubuntu-24.04" } },
      { wsl2: { ...f.request.wsl2, installRoot: "D:\\Applications\\DockerWSL" } },
      { wsl2: { ...f.request.wsl2, installRoot: f.request.roots.work } },
      { wsl2: { ...f.request.wsl2, guestExecution: undefined } },
    ])
      expect(() => decodeHostRequest({ ...f.request, ...change })).toThrow()
  } finally {
    await f.dispose()
  }
})

test("workspace mapping retains exact D workspace boundaries and rejects traversal, aliases and other drives", async () => {
  const { mapWsl2Workspace } = await import("../../src/sandbox/wsl2-independent")
  const f = await fixture()
  try {
    const request = decodeHostRequest(f.request)
    expect(mapWsl2Workspace(request, path.join(request.roots.work, "candidate-1", "src", "x.ts"))).toBe(
      f.guest.workRoot + "/candidate-1/src/x.ts",
    )
    for (const file of [
      "C:\\secret",
      request.roots.work + "-other\\file",
      request.roots.work + "\\..\\secret",
      "\\\\?\\D:\\secret",
      request.roots.work + "\\file:stream",
    ])
      expect(() => mapWsl2Workspace(request, file)).toThrow()
    expect(mapWsl2Workspace(request, request.roots.work)).toBe(f.guest.workRoot)
  } finally {
    await f.dispose()
  }
})

test("guest invocations select only the approved distro and isolated environment without a shell or Windows PATH", async () => {
  const { wsl2GuestInvocation } = await import("../../src/sandbox/wsl2-independent")
  const f = await fixture()
  try {
    const argv = wsl2GuestInvocation(decodeHostRequest(f.request), ["/usr/bin/docker", "info"])
    expect(argv.slice(0, 8)).toEqual([
      "--distribution",
      "opencode-task24-isolated",
      "--user",
      "root",
      "--cd",
      "/",
      "--exec",
      "/usr/bin/env",
    ])
    expect(argv).toContain("-i")
    expect(argv).toContain("DOCKER_CONFIG=/opt/opencode-task24/config")
    expect(argv).toContain("DOCKER_HOST=unix:///var/run/docker.sock")
    expect(argv.slice(-2)).toEqual(["/usr/bin/docker", "info"])
    for (const forbidden of ["--install", "--import", "--shutdown", "--set-default", "sh", "-c", "cmd.exe"])
      expect(argv).not.toContain(forbidden)
    expect(() =>
      wsl2GuestInvocation(
        decodeHostRequest({
          ...f.request,
          wsl2: { ...f.request.wsl2, guestExecution: { approved: true, expiresAt: 1 } },
        }),
        ["/usr/bin/docker"],
      ),
    ).toThrow("TASK24_WSL2_GUEST_APPROVAL")
  } finally {
    await f.dispose()
  }
})

test("storage observation binds the new registration, disk, guest CLI, root filesystem and disabled runtime swap", async () => {
  const { decodeWsl2StorageObservation } = await import("../../src/sandbox/wsl2-independent")
  const f = await fixture()
  try {
    const request = decodeHostRequest(f.request)
    const proof = decodeWsl2StorageObservation({
      request,
      source: f.source,
      registration: f.registration,
      guest: f.guest,
    })
    expect(proof.disk).toEqual(f.source.disk)
    expect(proof.dataRoot).toBe(f.request.wsl2.installRoot)
    expect(proof.swap).toEqual({ kind: "disabled" })
    expect((await inspectStorage(proof)).kind).toBe("ready")
    const exact = await fs.stat(f.source.disk.path, { bigint: true })
    expect(
      (
        await inspectStorage({
          ...proof,
          disk: { ...proof.disk, fileID: `wsl2:${exact.dev}:${exact.ino + 1n}:${exact.birthtimeNs}` },
        })
      ).kind,
    ).toBe("blocked")
    for (const change of [
      { swapsText: f.guest.swapsText + "/swapfile file 4096 0 -2\n" },
      { cliSha256: "b".repeat(64) },
      { operatingSystem: "Docker Desktop" },
      { dockerDevice: "8:32" },
      { containerdDevice: "8:32" },
      { configDevice: "8:32" },
      { rootFilesystem: "overlay" },
      { dockerRoot: "/mnt/c/docker" },
      { workRealPath: "/mnt/d/other" },
      { windowsDrives: ["D:\\", "C:\\"] },
      { workMount: { ...f.guest.workMount, source: "C:\\" } },
      { socket: { ...f.guest.socket, type: "file" } },
      { socket: { ...f.guest.socket, uid: 1000 } },
      { daemon: { ...f.guest.daemon, executable: "/usr/bin/socket-proxy" } },
      { daemon: { ...f.guest.daemon, engineID: "foreign" } },
      { daemon: { ...f.guest.daemon, mountNamespace: "mnt:[5678]" } },
      { daemon: { ...f.guest.daemon, rootDevice: "8:32" } },
      { daemon: { ...f.guest.daemon, rootInode: "888" } },
      { descendantWorkMounts: [f.guest.workRoot + "/candidate"] },
    ])
      expect(() =>
        decodeWsl2StorageObservation({
          request,
          source: f.source,
          registration: f.registration,
          guest: { ...f.guest, ...change },
        }),
      ).toThrow()
    for (const change of [
      { version: 1 },
      { running: false },
      { registrationID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      { basePath: "D:\\Applications\\DockerWSL" },
    ])
      expect(() =>
        decodeWsl2StorageObservation({
          request,
          source: f.source,
          registration: { ...f.registration, ...change },
          guest: f.guest,
        }),
      ).toThrow()
    expect(() =>
      decodeWsl2StorageObservation({
        request,
        source: {
          ...f.source,
          disk: { ...f.source.disk, path: "D:\\Applications\\DockerWSL\\disk\\docker_data.vhdx" },
        },
        registration: f.registration,
        guest: f.guest,
      }),
    ).toThrow()
  } finally {
    await f.dispose()
  }
})

test("transport never enters a stopped or mismatched distribution and preserves binary process results", async () => {
  const { makeWsl2Transport } = await import("../../src/sandbox/wsl2-independent")
  const f = await fixture()
  try {
    const calls: readonly string[][] = []
    let registration = f.registration
    const transport = makeWsl2Transport({
      request: decodeHostRequest(f.request),
      observeRegistration: async () => registration,
      process: {
        async execute(input) {
          ;(calls as string[][]).push([...input.argv])
          return {
            started: true,
            exitCode: 0,
            stdout: input.stdin ?? new Uint8Array(),
            stderr: new Uint8Array(),
            truncated: false,
          }
        },
      },
    })
    const input = {
      argv: ["info"],
      stdin: new Uint8Array([0, 255]),
      timeoutMs: 1000,
      maxStdoutBytes: 100,
      maxStderrBytes: 100,
      signal: new AbortController().signal,
    }
    registration = { ...f.registration, running: false }
    await expect(transport.execute(input)).rejects.toThrow("TASK24_WSL2_NOT_RUNNING")
    expect(calls).toHaveLength(0)
    registration = { ...f.registration, basePath: "D:\\Applications\\DockerWSL" }
    await expect(transport.execute(input)).rejects.toThrow()
    expect(calls).toHaveLength(0)
    registration = f.registration
    const response = await transport.execute(input)
    expect([...response.stdout]).toEqual([0, 255])
    expect(calls[0]!.slice(-3)).toEqual(["/usr/bin/docker", "--context", "default", "info"].slice(-3))
    expect(isRealDockerRunner(transport)).toBe(false)
  } finally {
    await f.dispose()
  }
})

test("missing guest authorization blocks the real runner and storage collector before any native command", async () => {
  const f = await fixture()
  try {
    const request = {
      ...f.request,
      wsl2: { ...f.request.wsl2, guestExecution: { approved: true as const, expiresAt: 1 } },
    }
    expect(() => makeDockerRunner({ request })).toThrow("TASK24_WSL2_GUEST_APPROVAL")
    await expect(makeStorageProbe({ request, source: f.source })()).rejects.toThrow("TASK24_WSL2_GUEST_APPROVAL")
    await expect(
      makeStorageProbe({
        request: f.request,
        source: {
          kind: "desktop-wsl-legacy",
          desktop: f.cli,
          backend: f.cli,
          wslConfig: "C:\\must-not-read\\.wslconfig",
          allowEffectiveSwapProbe: true,
        },
      })(),
    ).rejects.toThrow("TASK24_WSL2_STORAGE_SOURCE")
    await expect(makeStorageProbe({ request: { ...f.request, wsl2: undefined }, source: f.source })()).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})

test("the real Linux-host CLI composition denies an expired WSL grant without querying or starting a distribution", async () => {
  const { runLinuxHostCommand } = await import("../../src/sandbox/command")
  const f = await fixture()
  try {
    const requestFile = path.join(f.root, "request.json")
    const sourceFile = path.join(f.root, "source.json")
    await fs.writeFile(
      requestFile,
      JSON.stringify({ ...f.request, wsl2: { ...f.request.wsl2, guestExecution: { approved: true, expiresAt: 1 } } }),
    )
    await fs.writeFile(sourceFile, JSON.stringify(f.source))
    expect(await runLinuxHostCommand(["inspect", "--request", requestFile, "--storage-source", sourceFile])).toEqual({
      exitCode: 2,
      output: {
        software_verified: true,
        engine_verified: false,
        tool_capability_verified: false,
        corpus_engine_ready: false,
        code: "TASK24_WSL2_GUEST_APPROVAL",
      },
    })
  } finally {
    await f.dispose()
  }
})

test("the independent preflight refuses missing or different guest-engine identity before opening a session", async () => {
  const f = await sessionFixture(true)
  try {
    const missing = await inspectLinuxHost({
      request: f.request,
      runner: f.inventoryRunner,
      storageProbe: async () => ({ ...f.storage, engineID: undefined }),
    })
    expect(missing.missing).toContain("engine_storage_not_verified")
    const absent = { ...f.storage }
    delete absent.engineID
    const noBinding = await inspectLinuxHost({
      request: f.request,
      runner: f.inventoryRunner,
      storageProbe: async () => absent,
    })
    expect(noBinding.missing).toContain("engine_identity_not_verified")
    const changed = await inspectLinuxHost({
      request: f.request,
      runner: f.inventoryRunner,
      storageProbe: async () => ({ ...f.storage, engineID: "other-engine" }),
    })
    expect(changed.missing).toContain("engine_identity_not_verified")
  } finally {
    await f.dispose()
  }
})

test("owned creation and inspection round-trip mapped mounts without weakening protected-file or ownership checks", async () => {
  const f = await sessionFixture(true)
  try {
    const work = path.join(f.request.roots.work, "candidate")
    await fs.mkdir(work)
    await fs.writeFile(path.join(work, "driver.mjs"), "protected")
    const input = {
      session: f.session,
      runner: f.runner,
      owner: f.owner,
      guard: async () => {},
      signal: new AbortController().signal,
      spec: {
        image: f.image,
        argv: ["/opt/task24/worker"],
        workspace: { source: work, readonly: false },
        protectedFiles: [{ source: path.join(work, "driver.mjs"), target: "/workspace/driver.mjs" }],
      },
    }
    const owned = await createOwnedContainer(input)
    const mounts = f.inspect().Mounts
    expect(mounts.map((m) => ({ Source: m.Source, Destination: m.Destination, RW: m.RW }))).toEqual([
      { Source: "/mnt/d/" + work.slice(3).replaceAll("\\", "/"), Destination: "/workspace", RW: true },
      {
        Source: "/mnt/d/" + work.slice(3).replaceAll("\\", "/") + "/driver.mjs",
        Destination: "/workspace/driver.mjs",
        RW: false,
      },
    ])
    await expect(inspectOwnedContainer({ ...input, owner: owned })).resolves.toBeDefined()
    const source = mounts[0]!.Source
    mounts[0]!.Source = "/mnt/c/secret"
    await expect(inspectOwnedContainer({ ...input, owner: owned })).rejects.toThrow()
    mounts[0]!.Source = source
    mounts[1]!.RW = true
    await expect(inspectOwnedContainer({ ...input, owner: owned })).rejects.toThrow()
    mounts[1]!.RW = false
    expect(await cleanupOwnedContainer({ ...input, owner: owned })).toEqual({ ended: true, removed: true })
  } finally {
    await f.dispose()
  }
})

const python = process.env.TASK24_TEST_PYTHON ?? Bun.which("python3") ?? Bun.which("python")
test.skipIf(!python)("actual Docker wrapper checks each bind and preserves application --mount arguments", async () => {
  const { makeWsl2Transport } = await import("../../src/sandbox/wsl2-independent")
  const f = await fixture()
  try {
    const request = decodeHostRequest({
      ...f.request,
      roots: { ...f.request.roots, work: f.request.roots.work + " with space" },
      wsl2: { ...f.request.wsl2, guestCliSha256: sha256Text("docker fixture") },
    })
    const work = "/mnt/d/" + request.roots.work.slice(3).replaceAll("\\", "/")
    let guestArgv: readonly string[] = []
    const transport = makeWsl2Transport({
      request,
      observeRegistration: async () => f.registration,
      process: {
        async execute(input) {
          guestArgv = input.argv
          return { started: true, exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false }
        },
      },
    })
    const common = {
      timeoutMs: 5000,
      maxStdoutBytes: 65536,
      maxStderrBytes: 65536,
      signal: new AbortController().signal,
    }
    await transport.execute({
      ...common,
      argv: [
        "container",
        "create",
        "--mount",
        `type=bind,src=${work}/candidate,dst=/workspace`,
        "--read-only",
        "example.invalid/runtime@sha256:" + "a".repeat(64),
        "--mount",
      ],
    })
    const wrapper = String.raw`import sys,io,json,os,stat,types
from unittest.mock import patch
p=json.loads(sys.stdin.read())
calls=[]
def read(name,*args,**kwargs):
    if name=='/usr/bin/docker': return io.BytesIO(b'docker fixture')
    target=(p['work']+'/candidate').replace(' ',chr(92)+'040')
    return io.StringIO('10 0 0:60 / /mnt/d rw - 9p D:'+chr(92)+'134 rw\n'+('11 10 8:16 / '+target+' rw - ext4 /dev/other rw\n' if p['mode']=='nested' else ''))
def info(name,**kwargs):
    return types.SimpleNamespace(st_dev=2 if p['mode']=='device' and name.endswith('/candidate') else 1,st_uid=0,st_mode=stat.S_IFREG)
def realpath(name,**kwargs): return '/etc' if p['mode']=='symlink' and name.endswith('/candidate') else name
def execute(exe,args): calls.append([exe,args])
out=io.StringIO()
error=None
with patch('builtins.open',read),patch('os.stat',info),patch('os.path.realpath',realpath),patch('os.execv',execute),patch('sys.argv',['pinned']+p['argv']),patch('sys.stdout',out):
    try: exec(compile(p['script'],'pinned-docker','exec'),{})
    except SystemExit as e: error=str(e)
print(json.dumps({'error':error,'calls':calls}))`
    const runner = makeProcessRunner({
      executable: python!,
      argvPrefix: ["-I", "-B", "-c", wrapper],
      cwd: f.root,
      env: { SystemRoot: "C:\\Windows", TEMP: f.root, TMP: f.root },
    })
    const script = guestArgv[guestArgv.indexOf("-c") + 1]!
    const args = guestArgv.slice(guestArgv.indexOf("-c") + 2)
    for (const mode of ["nested", "device", "symlink", "good"]) {
      const result = await runner.execute({
        ...common,
        argv: [],
        stdin: Buffer.from(JSON.stringify({ script, argv: args, mode, work })),
      })
      expect(Buffer.from(result.stderr).toString()).toBe("")
      expect(result.exitCode).toBe(0)
      const value = JSON.parse(Buffer.from(result.stdout).toString())
      if (mode === "good") {
        expect(value.error).toBeNull()
        expect(value.calls[0][0]).toBe("/usr/bin/docker")
        expect(value.calls[0][1].slice(-1)).toEqual(["--mount"])
      } else {
        expect(value.calls).toEqual([])
        expect(value.error).toBe("TASK24_WSL2_WORKSPACE")
      }
    }
  } finally {
    await f.dispose()
  }
})

test.skipIf(!python)(
  "actual guest collector runs against controlled syscall fixtures and refuses an unpinned CLI before executing it",
  async () => {
    const { wsl2StorageInvocation, decodeWsl2StorageObservation } = await import("../../src/sandbox/wsl2-independent")
    const f = await fixture()
    try {
      const request = decodeHostRequest({
        ...f.request,
        wsl2: { ...f.request.wsl2, guestCliSha256: sha256Text("docker fixture") },
      })
      const argv = wsl2StorageInvocation(request)
      const script = argv[argv.indexOf("-c") + 1]!
      const wrapper = `import sys, io, json, stat, types, os
from unittest.mock import patch
p=json.loads(sys.stdin.read())
calls=[]
resources={'/proc/self/mountinfo':'10 0 8:16 / / rw - ext4 /dev/sdc rw\\n11 10 0:60 / /mnt/d rw - 9p D:'+chr(92)+'134 rw,aname=drvfs\\n','/proc/swaps':'Filename Type Size Used Priority\\n','/usr/bin/docker':'docker fixture' if p['good'] else 'changed','/proc/net/unix':'Num RefCount Protocol Flags Type St Inode Path\\n000: 0002 0000 00010000 0001 01 987 /var/run/docker.sock\\n','/proc/42/root/var/lib/docker/engine-id':'independent-engine'}
if p['mode']=='nested': resources['/proc/self/mountinfo']+='12 11 0:61 / '+p['work']+'/candidate rw - ext4 /dev/other rw\\n'
def read(name,*args,**kwargs):
    value=resources[name]
    return io.BytesIO(value.encode()) if 'b' in (args[0] if args else '') else io.StringIO(value)
def info(name,*args,**kwargs):
    return types.SimpleNamespace(st_dev=816,st_ino=2,st_uid=0,st_mode=stat.S_IFSOCK if name.endswith('docker.sock') else stat.S_IFREG)
def listdir(name):
    return ['42'] if name=='/proc' else ['7']
def readlink(name):
    if name.endswith('/exe'): return '/usr/bin/socket-proxy' if p['mode']=='proxy' else '/usr/bin/dockerd'
    if '/fd/' in name: return 'socket:[987]'
    if name.endswith('/ns/mnt'): return 'mnt:[5678]' if p['mode']=='namespace' and '/42/' in name else 'mnt:[1234]'
    raise AssertionError(name)
def execute(args,**kwargs):
    calls.append(args)
    if args[0]=='/usr/bin/docker': return json.dumps({'ID':'independent-engine','OperatingSystem':'Ubuntu 24.04.4 LTS','DockerRootDir':'/var/lib/docker'}).encode()
    if args==['/usr/bin/findmnt','-n','-o','UUID','--target','/']: return '66666666-7777-4888-8999-aaaaaaaaaaaa\\n'
    raise AssertionError(args)
out=io.StringIO()
error=None
with patch('builtins.open',read),patch('os.stat',info),patch('os.listdir',listdir),patch('os.readlink',readlink),patch('os.major',lambda x:8,create=True),patch('os.minor',lambda x:16,create=True),patch('os.path.realpath',lambda x,**k:x),patch('platform.release',lambda:'6.18.33.1-microsoft-standard-WSL2'),patch('subprocess.check_output',execute),patch('sys.stdout',out):
    try: exec(compile(p['script'],'guest-collector','exec'),{})
    except SystemExit as e: error=str(e)
print(json.dumps({'error':error,'calls':calls,'guest':json.loads(out.getvalue()) if out.getvalue() else None}))`
      const runner = makeProcessRunner({
        executable: python!,
        argvPrefix: ["-I", "-B", "-c", wrapper],
        cwd: f.root,
        env: { SystemRoot: "C:\\Windows", TEMP: f.root, TMP: f.root },
      })
      for (const mode of ["hash", "proxy", "namespace", "nested", "good"]) {
        const result = await runner.execute({
          argv: [],
          stdin: Buffer.from(JSON.stringify({ script, good: mode !== "hash", mode, work: f.guest.workRoot })),
          timeoutMs: 5000,
          maxStdoutBytes: 65536,
          maxStderrBytes: 65536,
          signal: new AbortController().signal,
        })
        expect(Buffer.from(result.stderr).toString()).toBe("")
        expect(result.exitCode).toBe(0)
        const value = JSON.parse(Buffer.from(result.stdout).toString())
        if (["hash", "proxy", "namespace"].includes(mode)) {
          expect(value.calls).toEqual([])
          expect(value.error).toBe(
            mode === "hash"
              ? "TASK24_WSL2_GUEST_CLI"
              : mode === "proxy"
                ? "TASK24_WSL2_SOCKET_OWNER"
                : "TASK24_WSL2_DAEMON_NAMESPACE",
          )
        } else if (mode === "nested") {
          expect(() =>
            decodeWsl2StorageObservation({
              request,
              source: f.source,
              registration: f.registration,
              guest: value.guest,
            }),
          ).toThrow("TASK24_WSL2_STORAGE_BINDING")
        } else {
          expect(value.error).toBeNull()
          expect(
            decodeWsl2StorageObservation({
              request,
              source: f.source,
              registration: f.registration,
              guest: value.guest,
            }).engineID,
          ).toBe("independent-engine")
        }
      }
    } finally {
      await f.dispose()
    }
  },
)
