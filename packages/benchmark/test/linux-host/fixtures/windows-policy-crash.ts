import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../../src/campaign/canonical"
import { sha256Text } from "../../../src/hash"
import { fileIdentity } from "../../../src/sandbox/storage"
import { desktopProbeBootstrap } from "../../../src/sandbox/desktop/probe-worker"
import {
  inspectWindowsNetworkPolicy,
  recoverWindowsNetworkPolicy,
  readWindowsIsolationSource,
  readWindowsSupervisorStream,
} from "../../../src/sandbox/host-isolation/windows"

async function deadline<T>(until: number, label: string, operation: () => T | PromiseLike<T>, stop: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            const error = Error(label + " timeout")
            try {
              stop()
            } catch (failure) {
              reject(new AggregateError([error, failure], label + " interruption failed"))
              return
            }
            reject(error)
          },
          Math.max(0, until - Date.now()),
        )
      }),
      Promise.resolve().then(operation),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function command(
  child: Pick<Bun.Subprocess<"pipe", "pipe", "pipe">, "stdout" | "stderr" | "exited" | "exitCode" | "kill">,
  until: number,
  label: string,
) {
  const output = readWindowsSupervisorStream(child.stdout, 65536),
    error = readWindowsSupervisorStream(child.stderr, 65536)
  const complete = Promise.all([output, error, child.exited])
  const joined = Promise.allSettled([output, error, child.exited])
  void complete.catch(() => {})
  try {
    return await deadline(
      until,
      label,
      () => complete,
      () => child.kill(),
    )
  } catch (failure) {
    const errors: unknown[] = [failure]
    try {
      if (child.exitCode === null) child.kill()
    } catch (error) {
      errors.push(error)
    }
    try {
      await deadline(
        Date.now() + 5000,
        label + " join",
        () => joined,
        () => child.kill(),
      )
    } catch (error) {
      errors.push(error)
    }
    throw new AggregateError(errors, label + " failed")
  }
}

export async function runWindowsPolicyCrash(input: { root: string }) {
  if (
    !/^D:\\OpenCode-Benchmark\\Task24\\tmp\\[^\\]+$/i.test(input.root) ||
    (await fs.realpath(input.root)) !== input.root
  )
    throw Error("owned D-only policy test parent")
  const root = await fs.mkdtemp(path.join(input.root, "windows-policy-live-"))
  try {
    return await execute()
  } catch (failure) {
    const retained = await fs.lstat(root).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        return true
      },
    )
    if (!retained) throw failure
    throw Object.assign(new AggregateError([failure], "policy crash fixture retains its owned root: " + root), {
      root,
      policyJournal: path.join(root, "network-policy.intent.json"),
      cleanupUncertain: true,
    })
  }
  async function execute() {
    if ((await fs.realpath(root)) !== root || (await fs.lstat(root)).isSymbolicLink())
      throw Error("own policy private root alias")
    const protect = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$root=[Console]::ReadLine();$acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetAccessRuleProtection($true,$false);$user=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl.SetOwner($user);foreach($sid in @($user,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};[IO.Directory]::SetAccessControl($root,$acl);[Console]::Write('PRIVATE_ROOT_OK')`
    const protectUntil = Date.now() + 10000
    const protectedRoot = Bun.spawn(
      [
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(protect, "utf16le").toString("base64"),
      ],
      {
        cwd: root,
        env: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", TEMP: root, TMP: root },
        stdin: Buffer.from(root + "\n"),
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    )
    const [protectedOutput, protectedError, protectedExit] = await command(
      protectedRoot,
      protectUntil,
      "own policy private ACL",
    )
    if (
      protectedExit !== 0 ||
      protectedError.length ||
      Buffer.from(protectedOutput).toString("utf8") !== "PRIVATE_ROOT_OK"
    )
      throw Error("own policy private ACL failed")
    const exact = async (file: string) => {
      const stat = await fs.lstat(file, { bigint: true })
      return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
    }
    const original = await exact(root)
    const owner = canonicalJson({
      purpose: "task24-windows-network-policy-crash-only",
      nonce: path.basename(root),
      modelApiCallsAllowed: false,
    })
    await fs.writeFile(path.join(root, "owner.json"), owner, { flag: "wx" })
    const runtime = path.join(root, "runtime"),
      state = path.join(root, "state"),
      compiler = path.join(root, "compiler")
    for (const directory of [runtime, state, compiler]) await fs.mkdir(directory)
    const exe = path.join(runtime, "bun.exe")
    await fs.copyFile(process.execPath, exe, fs.constants.COPYFILE_EXCL)
    const executable = { ...(await fileIdentity(exe)), fileID: await exact(exe) }
    const journal = path.join(root, "network-policy.intent.json")
    const source =
      (await readWindowsIsolationSource()) +
      "\n" +
      (await fs.readFile(new URL("./windows-policy-probe.cs", import.meta.url), "utf8"))
    const environment = (actor: string) => ({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      HOME: state,
      USERPROFILE: state,
      APPDATA: state,
      LOCALAPPDATA: state,
      TEMP: path.join(actor, "compiler"),
      TMP: path.join(actor, "compiler"),
      TMPDIR: path.join(actor, "compiler"),
      BUN_OPTIONS: "--no-env-file",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      BUN_INSTALL_CACHE_DIR: state,
      NODE_DISABLE_COMPILE_CACHE: "1",
      PSModuleAnalysisCachePath: path.join(state, "ModuleAnalysisCache"),
    })
    const script = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=[Console]::ReadLine()|ConvertFrom-Json
${desktopProbeBootstrap}
try {
 Add-Type -TypeDefinition $p.source -ReferencedAssemblies @('System.Web.Extensions','System.Core')
 if($p.mode -eq 'probe'){[Console]::WriteLine([Task24NativeIsolation]::FixturePolicyProbe([string]$p.plan))}
 elseif($p.mode -eq 'guardian'){
  $job=[Task24NativeIsolation]::FixtureHoldJob([string]$p.jobName)
  try {
   [Console]::WriteLine('{"stage":"held"}');[Console]::Out.Flush()
   while($null -ne ($line=[Console]::ReadLine())){
    if($line -eq 'finish'){break}
    if($line -ne 'state'){throw 'unknown guardian operation'}
    $state=@{active=[Task24NativeIsolation]::FixtureJobActive($job);permitPresent=[Task24NativeIsolation]::FixturePermitPresent([string]$p.permitKey)}
    [Console]::WriteLine(($state|ConvertTo-Json -Compress));[Console]::Out.Flush()
   }
  } finally {[Task24NativeIsolation]::FixtureReleaseJob($job)}
 }
 else {throw 'unknown fixture operation'}
} catch {
 [Console]::Error.WriteLine($_.Exception.ToString());throw
} finally {
 $acl=[IO.Directory]::GetAccessControl([string]$p.compiler,[Security.AccessControl.AccessControlSections]::Access).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
 foreach($dir in [IO.Directory]::GetDirectories([string]$p.compiler)){
  if(([IO.File]::GetAttributes($dir) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'compiler reparse point'}
  $restore=[Security.AccessControl.DirectorySecurity]::new();$restore.SetSecurityDescriptorSddlForm($acl,[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($dir,$restore)
 }
}`
    const actors: Awaited<ReturnType<typeof start>>[] = []
    async function start(mode: "probe" | "guardian", extra: Record<string, unknown>) {
      const readyUntil = Date.now() + 30000
      const directory = path.join(root, mode)
      await fs.mkdir(directory)
      await fs.mkdir(path.join(directory, "compiler"))
      const actorOwner = canonicalJson({ purpose: "task24-network-policy-crash-actor", mode, root })
      await fs.writeFile(path.join(directory, "owner.json"), actorOwner, { flag: "wx" })
      const child = Bun.spawn(
        [
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        {
          cwd: directory,
          env: environment(directory),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
        },
      )
      const error = readWindowsSupervisorStream(child.stderr, 65536)
      void error.catch(() => {})
      const reader = child.stdout.getReader()
      let buffered = ""
      let firstLine = true
      const decoder = new TextDecoder("utf-8", { fatal: true })
      async function line(until = firstLine ? readyUntil : Date.now() + 10000) {
        firstLine = false
        const consume = async () => {
          for (;;) {
            const end = buffered.indexOf("\n")
            if (end >= 0) {
              const value = buffered.slice(0, end).trim()
              buffered = buffered.slice(end + 1)
              return JSON.parse(value) as Record<string, unknown>
            }
            const item = await reader.read()
            if (item.done) throw Error("native fixture ended: " + Buffer.from(await error).toString("utf8"))
            buffered += decoder.decode(item.value, { stream: true })
            if (buffered.length > 65536) throw Error("native fixture line limit")
          }
        }
        return deadline(until, "native fixture line", consume, () => child.kill())
      }
      const send = (value: string, until: number) =>
        deadline(
          until,
          "native fixture stdin",
          async () => {
            child.stdin.write(value)
            await child.stdin.flush()
          },
          () => child.kill(),
        )
      let finishing: Promise<void> | undefined
      let expectedCrash = false
      const actor = {
        child,
        line,
        directory,
        error,
        send,
        crash() {
          expectedCrash = true
          child.kill()
        },
        finish() {
          return (finishing ??= (async () => {
            const errors: unknown[] = []
            const until = Date.now() + 10000
            try {
              await deadline(
                until,
                "native fixture finish",
                async () => {
                  if (child.exitCode === null) await send("finish\n", until)
                  await child.exited
                },
                () => child.kill(),
              )
            } catch (error) {
              errors.push(error)
              try {
                if (child.exitCode === null) child.kill()
              } catch (failure) {
                errors.push(failure)
              }
            }
            try {
              await deadline(
                Date.now() + 5000,
                "native fixture stream/process join",
                async () => {
                  const [exit, , stderr] = await Promise.all([child.exited, reader.cancel(), error])
                  reader.releaseLock()
                  if (exit !== 0 && !expectedCrash)
                    throw Error("native fixture failed: " + exit + ": " + Buffer.from(stderr).toString("utf8"))
                },
                () => child.kill(),
              )
            } catch (error) {
              errors.push(error)
            }
            if (errors.length) throw new AggregateError(errors, "native fixture finish uncertain")
          })())
        },
      }
      actors.push(actor)
      // Register ownership before sending a request: even a broken stdin must not
      // leave the already spawned native actor outside the fixture's finalizer.
      await deadline(
        readyUntil,
        "native fixture start",
        async () =>
          actor.send(
            canonicalJson({
              cwd: directory,
              tempIdentity: await exact(directory),
              tempOwnerSha256: sha256Text(actorOwner),
              compiler: path.join(directory, "compiler"),
              source,
              mode,
              ...extra,
            }) + "\n",
            readyUntil,
          ),
        () => child.kill(),
      )
      return actor
    }
    let hits = 0
    const canary = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        hits++
        return new Response("healthy")
      },
    })
    const clients: { child: Bun.Subprocess<"ignore", "pipe", "pipe">; joined: Promise<unknown> }[] = []
    async function fetchCanary() {
      const until = Date.now() + 5000
      const probe = Bun.spawn(
        [
          exe,
          "--no-env-file",
          "-e",
          `try{console.log(await(await fetch('http://127.0.0.1:${canary.port}/',{signal:AbortSignal.timeout(1000)})).text())}catch{console.log('blocked')}`,
        ],
        { cwd: state, env: environment(root), stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true },
      )
      const output = readWindowsSupervisorStream(probe.stdout, 1024),
        error = readWindowsSupervisorStream(probe.stderr, 1024)
      const complete = Promise.all([output, error, probe.exited])
      void complete.catch(() => {})
      clients.push({ child: probe, joined: Promise.allSettled([output, error, probe.exited]) })
      const [stdout, stderr, exit] = await deadline(
        until,
        "own canary client",
        () => complete,
        () => probe.kill(),
      )
      if (exit !== 0 || stderr.length) throw Error("own canary client failed")
      return Buffer.from(stdout).toString("utf8").trim()
    }
    let retired = false
    let failure: unknown
    try {
      const before = await fetchCanary()
      const probe = await start("probe", {
        plan: canonicalJson({
          exe: executable,
          policyJournal: journal,
          port: canary.port,
          directories: await Promise.all(
            [root, runtime, state, compiler].map(async (directory) => ({
              path: directory,
              fileID: await exact(directory),
            })),
          ),
        }),
      })
      const ready = await probe.line()
      if (
        ready.stage !== "ready" ||
        ready.journal !== journal ||
        typeof ready.jobName !== "string" ||
        typeof ready.permitKey !== "string"
      )
        throw Error("native policy ready protocol")
      const guardian = await start("guardian", { jobName: ready.jobName, permitKey: ready.permitKey })
      if ((await guardian.line()).stage !== "held") throw Error("native job guardian not held")
      const operation = () =>
        fileIdentity(journal).then((journal) => ({ journal, root: input.root, signal: new AbortController().signal }))
      const during = await fetchCanary()
      const installed = await inspectWindowsNetworkPolicy(await operation())
      let aliveRecoveryRejected = false
      try {
        await recoverWindowsNetworkPolicy(await operation())
      } catch {
        aliveRecoveryRejected = true
      }
      if (!aliveRecoveryRejected) throw Error("live original supervisor must block retirement")
      probe.crash()
      await deadline(
        Date.now() + 5000,
        "crashed native fixture exit",
        () => probe.child.exited,
        () => probe.child.kill(),
      )
      let ended: Record<string, unknown> | undefined
      const until = Date.now() + 10000
      while (Date.now() < until) {
        await guardian.send("state\n", until)
        ended = await guardian.line(until)
        if (ended.active === 0 && ended.permitPresent === false) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      if (ended?.active !== 0 || ended.permitPresent !== false) throw Error("job/volatile rule rundown did not finish")
      const afterCrash = await inspectWindowsNetworkPolicy(await operation())
      const previousHits = hits
      const after = await fetchCanary()
      const postCrashHits = hits - previousHits
      const recovery = await recoverWindowsNetworkPolicy(await operation())
      retired = recovery.persistentPolicyRetired
      const gone = await inspectWindowsNetworkPolicy(await operation())
      const restored = await fetchCanary()
      return {
        scope: "network-policy-only",
        before,
        during,
        after,
        restored,
        installed,
        afterCrash,
        recovery,
        gone,
        postCrashHits,
        aliveRecoveryRejected,
        modelApiCalls: 0,
      }
    } catch (error) {
      failure = error
      throw error
    } finally {
      const errors: unknown[] = []
      const attempt = async (stage: string, operation: () => unknown | PromiseLike<unknown>) => {
        try {
          await operation()
        } catch (error) {
          errors.push(Object.assign(new Error(stage, { cause: error }), { stage }))
        }
      }
      // Preserve the job guardian until recovery has had a chance to prove active=0.
      const probe = actors[0]
      if (probe) await attempt("probe finish", () => probe.finish())
      for (const client of clients) {
        await attempt("canary client stop", () => {
          if (client.child.exitCode === null) client.child.kill()
        })
        await attempt("canary client join", () =>
          deadline(
            Date.now() + 5000,
            "own canary client cleanup",
            () => client.joined,
            () => client.child.kill(),
          ),
        )
      }
      if (!actors.length) retired = true // No native policy creator was spawned.
      if (!retired)
        await attempt("policy absence inspection", async () => {
          // A normal finish can already have retired the deny and closed its named
          // job. Inspection may prove absence; recovery still requires its own job proof.
          retired = (
            await inspectWindowsNetworkPolicy({
              journal: await fileIdentity(journal),
              root: input.root,
              signal: new AbortController().signal,
            })
          ).persistentPolicyRetired
        })
      if (!retired && actors.length > 1 && probe?.child.exitCode !== null) {
        await attempt("network policy recovery", async () => {
          retired = (
            await recoverWindowsNetworkPolicy({
              journal: await fileIdentity(journal),
              root: input.root,
              signal: new AbortController().signal,
            })
          ).persistentPolicyRetired
        })
      }
      for (const actor of actors.slice(1).toReversed()) await attempt("remaining actor finish", () => actor.finish())
      await attempt("canary server stop", () =>
        deadline(
          Date.now() + 5000,
          "canary server stop",
          () => canary.stop(true),
          () => {},
        ),
      )
      if (retired && errors.length === 0)
        await attempt("owned root cleanup", async () => {
          const restore = String.raw`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$p=[Console]::ReadLine()|ConvertFrom-Json;foreach($compiler in $p.compilers){$acl=[IO.Directory]::GetAccessControl($compiler,[Security.AccessControl.AccessControlSections]::Access).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);foreach($dir in [IO.Directory]::GetDirectories($compiler)){if(([IO.File]::GetAttributes($dir)-band[IO.FileAttributes]::ReparsePoint)-ne 0){throw 'compiler reparse point'};$s=[Security.AccessControl.DirectorySecurity]::new();$s.SetSecurityDescriptorSddlForm($acl,[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($dir,$s)}}`
          const cleanupUntil = Date.now() + 10000
          const cleanup = Bun.spawn(
            [
              "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(restore, "utf16le").toString("base64"),
            ],
            {
              cwd: root,
              env: environment(root),
              stdin: Buffer.from(
                canonicalJson({ compilers: actors.map((actor) => path.join(actor.directory, "compiler")) }) + "\n",
              ),
              stdout: "pipe",
              stderr: "pipe",
              windowsHide: true,
            },
          )
          const [, cleanupError, cleanupExit] = await command(cleanup, cleanupUntil, "own compiler ACL recovery")
          if (cleanupExit !== 0 || cleanupError.length)
            throw Error(
              "own compiler ACL recovery failed: exit=" +
                cleanupExit +
                " stderr=" +
                Buffer.from(cleanupError).toString("utf8"),
            )
          if (
            (await exact(root)) !== original ||
            (await fs.readFile(path.join(root, "owner.json"), "utf8")) !== owner ||
            (await fs.realpath(root)) !== root
          )
            throw Error("own policy cleanup root changed")
          let entries = 0
          const inspect = async (directory: string, depth = 0): Promise<void> => {
            if (depth > 32) throw Error("own policy cleanup depth limit")
            for await (const entry of await fs.opendir(directory)) {
              if (++entries > 4096) throw Error("own policy cleanup entry limit")
              const file = path.join(directory, entry.name),
                stat = await fs.lstat(file)
              if (
                stat.isSymbolicLink() ||
                (await fs.realpath(file)) !== file ||
                (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))
              )
                throw Error("own policy cleanup alias")
              if (stat.isDirectory()) await inspect(file, depth + 1)
            }
          }
          await inspect(root)
          await fs.rm(root, { recursive: true, force: true })
        })
      if (!retired || errors.length) {
        if (!retired) errors.push(Error("persistent policy retirement remains unproven"))
        throw Object.assign(
          new AggregateError(
            failure ? [failure, ...errors] : errors,
            "policy crash fixture retains exact journal for unresolved cleanup: " + journal,
          ),
          {
            root,
            policyJournal: journal,
            cleanupUncertain: true,
          },
        )
      }
    }
  }
}
