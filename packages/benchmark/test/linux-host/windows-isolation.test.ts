import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { fileIdentity } from "../../src/sandbox/storage"
import { runWindowsSandbox } from "../../src/sandbox/host-isolation/windows"

const invoke = runWindowsSandbox
const baseline = () => ({
  executable: { path: "D:\\OpenCode-Benchmark\\Task24\\tmp\\case\\bin.exe", sha256: "0".repeat(64), fileID: "own" },
  argv: ["--no-env-file", "--version"],
  cwd: "D:\\OpenCode-Benchmark\\Task24\\tmp\\case\\work",
  readonly: [] as string[],
  writable: ["D:\\OpenCode-Benchmark\\Task24\\tmp\\case\\work"],
  ports: [] as number[],
  root: "D:\\OpenCode-Benchmark\\Task24\\tmp\\case\\control",
  timeoutMs: 1000,
  maxStdoutBytes: 1024,
  maxStderrBytes: 1024,
  signal: new AbortController().signal,
})

test("Windows isolation refuses a C-drive writable grant before spawning", async () => {
  await expect(invoke({ ...baseline(), writable: ["C:\\Users\\Administrator"] })).rejects.toThrow(
    "TASK24_ISOLATION_INPUT",
  )
})

test("Windows isolation refuses unrestricted network and overlapping grants before spawning", async () => {
  for (const input of [
    { ...baseline(), ports: [0] },
    { ...baseline(), writable: ["D:\\OpenCode-Benchmark\\Task24"] },
    { ...baseline(), readonly: ["D:\\OpenCode-Audit"] },
    { ...baseline(), writable: ["D:\\OpenCode-Benchmark\\Task24\\tmp\\CASE"] },
    { ...baseline(), readonly: ["D:\\OpenCode-Benchmark\\Task24\\tmp\\CASE"] },
    { ...baseline(), readonly: ["D:\\OpenCode-Benchmark\\Task24\\tmp\\CASE\\WORK\\private"] },
    { ...baseline(), environment: { temp: "C:\\bad" } },
    { ...baseline(), environment: { Path: "C:\\bad" } },
    { ...baseline(), environment: { TASK24_PUBLIC_TOOL_CAPABILITY: "not-a-capability" } },
    { ...baseline(), mediated: ["C:\\not-allowed"] },
    { ...baseline(), mediated: [baseline().cwd] },
    { ...baseline(), writable: [], readonly: [baseline().cwd], mediated: [baseline().cwd] },
    { ...baseline(), mediated: ["D:\\OpenCode-Audit"] },
  ])
    await expect(invoke(input)).rejects.toThrow("TASK24_ISOLATION_INPUT")
})

test.skipIf(process.platform !== "win32" || process.env.TASK24_WINDOWS_ISOLATION_LIVE !== "1")(
  "real AppContainer denies an ungranted own canary and non-admitted loopback, permits its workspace, and ends its job",
  async () => {
    const parent = process.env.TMPDIR!
    const root = await fs.mkdtemp(path.join(parent, "isolation-live-"))
    const work = path.join(root, "work")
    const control = path.join(root, "control")
    const readonly = path.join(root, "readonly")
    await fs.mkdir(work)
    await fs.mkdir(control)
    await fs.mkdir(readonly)
    const nested = path.join(work, "nested")
    await fs.mkdir(nested)
    await fs.writeFile(path.join(readonly, "source.txt"), "original")
    const secret = path.join(root, "outside-canary")
    await fs.writeFile(secret, "own-noncredential-canary")
    const ambient = path.join(root, "ambient-canary")
    await fs.writeFile(ambient, "own-aap-only-canary")
    const grant = Bun.spawn(["C:\\Windows\\System32\\icacls.exe", ambient, "/grant", "*S-1-15-2-1:R"], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    if ((await grant.exited) !== 0) throw new Error(await new Response(grant.stderr).text())
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("healthy") })
    let deniedHits = 0
    const denied = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        deniedHits++
        return new Response("must-not-reach")
      },
    })
    let failure: unknown
    try {
      const binary = path.join(root, "bun.exe")
      await fs.copyFile(process.execPath, binary, fs.constants.COPYFILE_EXCL)
      const executable = await fileIdentity(binary)
      const code = `const fs=require('fs'),path=require('path');const check=p=>{try{fs.readFileSync(p);return false}catch(e){return e.code==='EACCES'||e.code==='EPERM'}};const write=p=>{try{fs.writeFileSync(p,'changed');return false}catch(e){return e.code==='EACCES'||e.code==='EPERM'}};fs.writeFileSync('own-write','ok');const profile=process.env.TEMP.match(/opencode\\.task24\\.[a-f0-9]{32}/)[0];let cDenied=false;try{fs.mkdirSync(path.join(${JSON.stringify(process.env.LOCALAPPDATA)},'Packages',profile,'AC','must-not-create'),{recursive:true})}catch(e){cDenied=e.code==='EACCES'||e.code==='EPERM'};const get=async port=>{try{return await(await fetch('http://127.0.0.1:'+port,{signal:AbortSignal.timeout(2000)})).text()}catch{return 'blocked'}};console.log(JSON.stringify({denied:check(${JSON.stringify(secret)}),ambientDenied:check(${JSON.stringify(ambient)}),readonly:fs.readFileSync(${JSON.stringify(path.join(readonly, "source.txt"))},'utf8'),readonlyDenied:write(${JSON.stringify(path.join(readonly, "source.txt"))}),cDenied,allowed:await get(${server.port}),blocked:await get(${denied.port}),home:process.env.HOME,temp:process.env.TEMP}));`
      const result = await invoke({
        executable,
        argv: ["--no-env-file", "-e", code],
        cwd: nested,
        readonly: [readonly],
        writable: [work],
        ports: [server.port],
        root: control,
        timeoutMs: 15000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        signal: new AbortController().signal,
      })
      expect({
        exit: result.execution.exitCode,
        stderr: Buffer.from(result.execution.stderr).toString("utf8"),
      }).toEqual({ exit: 0, stderr: "" })
      expect(JSON.parse(Buffer.from(result.execution.stdout).toString("utf8"))).toMatchObject({
        denied: true,
        ambientDenied: true,
        readonly: "original",
        readonlyDenied: true,
        cDenied: true,
        allowed: "healthy",
        blocked: "blocked",
      })
      const observation = JSON.parse(Buffer.from(result.execution.stdout).toString("utf8"))
      expect(observation.home.toLowerCase().startsWith(control.toLowerCase() + path.sep)).toBe(true)
      expect(observation.temp.toLowerCase().startsWith(control.toLowerCase() + path.sep)).toBe(true)
      expect(await fs.readFile(path.join(readonly, "source.txt"), "utf8")).toBe("original")
      expect(await fs.readFile(path.join(nested, "own-write"), "utf8")).toBe("ok")
      expect(result.containment).toMatchObject({
        appContainer: true,
        processTreeEnded: true,
        dynamicNetworkPolicy: true,
      })
      expect(deniedHits).toBe(0)
      // Native cancellation must unwind the job and persistent registration, not just kill
      // PowerShell and leave a stale directory ACL or AppContainer profile behind.
      const cancellation = new AbortController()
      const started = Promise.withResolvers<void>()
      const ready = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => {
          started.resolve()
          return new Response("ready")
        },
      })
      try {
        const running = invoke({
          executable,
          argv: ["--no-env-file", "-e", `await fetch('http://127.0.0.1:${ready.port}');setInterval(()=>{},1000)`],
          cwd: work,
          readonly: [],
          writable: [work],
          ports: [ready.port],
          root: control,
          timeoutMs: 15000,
          maxStdoutBytes: 1024,
          maxStderrBytes: 1024,
          signal: cancellation.signal,
        })
        await Promise.race([
          started.promise,
          running.then(() => {
            throw Error("candidate ended before ready")
          }),
          Bun.sleep(12000).then(() => {
            throw Error("candidate not ready")
          }),
        ])
        cancellation.abort()
        const cancelled = await running
        expect(cancelled.execution.exitCode).toBe(130)
        expect(cancelled.execution.cleanupUncertain).not.toBe(true)
        expect(cancelled.containment).toMatchObject({ processTreeEnded: true, cleanupCompleted: true })
      } finally {
        cancellation.abort()
        await ready.stop(true)
      }
      const timed = await invoke({
        executable,
        argv: ["--no-env-file", "-e", "setInterval(()=>{},1000)"],
        cwd: work,
        readonly: [],
        writable: [work],
        ports: [],
        root: control,
        timeoutMs: 250,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        signal: new AbortController().signal,
      })
      expect(timed.execution).toMatchObject({ started: true, exitCode: 124, truncated: true })
      expect(timed.containment).toMatchObject({ processTreeEnded: true, cleanupCompleted: true })
      const overflow = await invoke({
        executable,
        argv: ["--no-env-file", "-e", "process.stdout.write('x'.repeat(4096));setInterval(()=>{},1000)"],
        cwd: work,
        readonly: [],
        writable: [work],
        ports: [],
        root: control,
        timeoutMs: 10000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        signal: new AbortController().signal,
      })
      expect(overflow.execution.truncated).toBe(true)
      expect(overflow.execution.stdout.length).toBe(1024)
      expect(overflow.containment).toMatchObject({ processTreeEnded: true, cleanupCompleted: true })
      const descendant = await invoke({
        executable,
        argv: [
          "--no-env-file",
          "-e",
          `const fs=require('fs');const child=Bun.spawn([process.execPath,'--no-env-file','-e',\"const fs=require('fs');fs.writeFileSync('descendant-started','1');setInterval(()=>fs.appendFileSync('descendant-started','x'),20)\"],{stdout:'ignore',stderr:'ignore'});for(let i=0;!fs.existsSync('descendant-started')&&i<100;i++)await Bun.sleep(20);if(!fs.existsSync('descendant-started'))throw Error('descendant never started');child.unref();console.log('spawned');`,
        ],
        cwd: work,
        readonly: [],
        writable: [work],
        ports: [],
        root: control,
        timeoutMs: 10000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        signal: new AbortController().signal,
      })
      expect(descendant.execution.exitCode).toBe(0)
      expect(Buffer.from(descendant.execution.stdout).toString().trim()).toBe("spawned")
      expect(descendant.containment).toMatchObject({ processTreeEnded: true, cleanupCompleted: true })
      const stoppedBytes = await fs.readFile(path.join(work, "descendant-started"), "utf8")
      await Bun.sleep(150)
      expect(await fs.readFile(path.join(work, "descendant-started"), "utf8")).toBe(stoppedBytes)
      expect(await fs.readdir(control)).toEqual([])
    } catch (error) {
      failure = error
      throw error
    } finally {
      await server.stop(true)
      await denied.stop(true)
      // The fixture belongs to this test. Preserve on uncertain ownership or a platform cleanup refusal.
      if (
        !(failure && typeof failure === "object" && Reflect.get(failure, "cleanupUncertain")) &&
        (await fs.realpath(root)) === root &&
        root.startsWith(parent + path.sep)
      )
        await fs.rm(root, { recursive: true, force: true }).catch((error) => {
          throw failure ? new AggregateError([failure, error], "fixture and cleanup failed") : error
        })
    }
  },
  process.platform === "win32" ? 120000 : 45000,
)
