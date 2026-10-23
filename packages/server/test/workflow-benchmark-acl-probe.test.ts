import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { BenchmarkAclProbe } from "../src/workflow/benchmark-acl-probe"
import { HostRootPolicy } from "../src/workflow/host-root-policy"
import { ProductionHostRuntime } from "../src/workflow/production-host-runtime"
import { stopOwnedProbe } from "./workflow-model-catalog-process"

const sid = "S-1-5-21-1000-1000-1000-1001"
const snapshot = {
  currentUserSid: sid,
  currentIdentitySids: [sid],
  ownerSid: sid,
  protected: true,
  reparsePoint: false,
  descriptorSddl: `O:${sid}G:${sid}D:P(A;;FA;;;${sid})(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)`,
  aces: [sid, "S-1-5-18", "S-1-5-32-544"].map((sid) => ({ sid, allow: true, inherited: false, mask: 0x001f01ff })),
}

function fixture(parent = process.env.TMPDIR!) {
  const root = fs.mkdtempSync(path.join(parent, "benchmark-acl-"))
  const identity = fs.lstatSync(root, { bigint: true })
  return {
    root,
    dispose() {
      const current = fs.lstatSync(root, { bigint: true })
      if (
        path.dirname(root) !== parent ||
        fs.realpathSync.native(root) !== root ||
        current.ino !== identity.ino ||
        current.dev !== identity.dev
      )
        throw Error("own fixture changed")
      fs.rmSync(root, { recursive: true })
    },
  }
}

async function freshProcess(pattern: string) {
  // Bun 1.3.14/Windows: a timed spawnSync followed by stopping an HTTP server
  // can make a later spawnSync report ETIMEDOUT immediately. Keep real probes
  // in fresh OS processes; neither the query nor its 5s limit is altered.
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "--no-install", "test", import.meta.filename, "--test-name-pattern", pattern],
    {
      cwd: import.meta.dirname,
      env: { ...process.env, TASK24_BENCHMARK_ACL_PROBE_CHILD: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    },
  )
  const bounded = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size > 65536) throw Error("Own ACL test output exceeded bound")
        chunks.push(next.value)
      }
      return Buffer.concat(chunks).toString("utf8")
    } finally {
      reader.releaseLock()
    }
  }
  let termination: Promise<void> | undefined
  const timer = setTimeout(() => {
    termination = stopOwnedProbe(child, child.pid)
    void termination.catch(() => {})
  }, 15000)
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, bounded(child.stdout), bounded(child.stderr)])
    if (exit !== 0) throw Error("Own ACL subprocess failed: " + stdout + stderr)
    expect(exit).toBe(0)
    expect(stdout + stderr).toContain("1 pass")
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) await stopOwnedProbe(child, child.pid)
    await termination
  }
}

test.skipIf(process.platform !== "win32")(
  "benchmark ACL transport retains the original fixed query and five-second invocation, then precisely removes results",
  () => {
    const f = fixture()
    let guarded = 0
    try {
      const probe = BenchmarkAclProbe.make({
        tempRoot: f.root,
        guard: () => {
          guarded++
        },
        run(input) {
          expect(input.executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
          expect(input.timeoutMs).toBe(5000)
          expect(input.argv.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
          expect(input.argv[4]).toContain("Get-Acl -LiteralPath $target")
          expect(input.env.OPENCODE_ACL_PROBE_TARGET).toBe(f.root)
          fs.writeFileSync(input.env.OPENCODE_ACL_PROBE_OUTPUT!, JSON.stringify(snapshot))
          return { status: 0 }
        },
      })
      expect(probe(f.root)).toEqual(snapshot)
      expect(guarded).toBe(2)
      expect(fs.readdirSync(f.root)).toEqual([])
    } finally {
      f.dispose()
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "benchmark ACL transport preserves genuine errors, malformed output and unsafe ACL rejection",
  () => {
    const f = fixture()
    try {
      for (const output of ["malformed", " ", "x".repeat(1048577)]) {
        const probe = BenchmarkAclProbe.make({
          tempRoot: f.root,
          guard() {},
          run(input) {
            fs.writeFileSync(input.env.OPENCODE_ACL_PROBE_OUTPUT!, output)
            return { status: 0 }
          },
        })
        expect(() => probe(f.root)).toThrow()
        expect(fs.readdirSync(f.root)).toEqual([])
      }
      for (const status of [0, 1]) {
        const denied = BenchmarkAclProbe.make({
          tempRoot: f.root,
          guard() {},
          run(input) {
            fs.writeFileSync(input.env.OPENCODE_ACL_PROBE_OUTPUT!, JSON.stringify(snapshot))
            fs.writeFileSync(input.env.OPENCODE_ACL_PROBE_ERROR!, "genuine own error")
            return { status }
          },
        })
        expect(() => denied(f.root)).toThrow("failed closed")
        expect(fs.readdirSync(f.root)).toEqual([])
      }
      const probe = BenchmarkAclProbe.make({
        tempRoot: f.root,
        guard() {},
        run(input) {
          fs.writeFileSync(input.env.OPENCODE_ACL_PROBE_OUTPUT!, JSON.stringify({ ...snapshot, protected: false }))
          return { status: 0 }
        },
      })
      const roots = {
        deploymentRoot: f.root,
        dataRoot: path.join(f.root, "data"),
        browserRuntimeRoot: path.join(f.root, "runtime"),
        browserCacheRoot: path.join(f.root, "cache"),
        previewCapabilityRoot: path.join(f.root, "preview"),
        dockerConfigRoot: path.join(f.root, "config"),
        dockerTempRoot: path.join(f.root, "temp"),
      }
      for (const dir of Object.values(roots)) if (dir !== f.root) fs.mkdirSync(dir)
      expect(() => HostRootPolicy.makeProduction({ ...roots, probe })).toThrow("ACL is unsupported")
    } finally {
      f.dispose()
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "benchmark ACL transport retains and reports an uncertain process instead of deleting files it may still write",
  () => {
    const f = fixture()
    try {
      const probe = BenchmarkAclProbe.make({
        tempRoot: f.root,
        guard() {},
        run() {
          return { status: null, error: Error("own timeout") }
        },
      })
      const error = (() => {
        try {
          probe(f.root)
        } catch (cause) {
          return cause
        }
      })()
      expect(error).toMatchObject({ cleanupUncertain: true })
      expect(fs.readdirSync(f.root)).toHaveLength(1)
      expect(() => probe(f.root)).toThrow("CLEANUP_UNCERTAIN")
      expect(fs.readdirSync(f.root)).toHaveLength(1)
      expect(() => BenchmarkAclProbe.make({ tempRoot: f.root, guard() {} })).toThrow("CLEANUP_UNCERTAIN")
    } finally {
      f.dispose()
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "benchmark ACL transport refuses a redirected result and preserves foreign bytes",
  () => {
    const f = fixture()
    const foreign = path.join(f.root, "foreign.json")
    fs.writeFileSync(foreign, "foreign input")
    try {
      const probe = BenchmarkAclProbe.make({
        tempRoot: f.root,
        guard() {},
        run(input) {
          fs.unlinkSync(input.env.OPENCODE_ACL_PROBE_OUTPUT!)
          fs.linkSync(foreign, input.env.OPENCODE_ACL_PROBE_OUTPUT!)
          return { status: 0 }
        },
      })
      expect(() => probe(f.root)).toThrow("CLEANUP_UNCERTAIN")
      expect(fs.readFileSync(foreign, "utf8")).toBe("foreign input")
      expect(fs.lstatSync(foreign).nlink).toBe(2)
    } finally {
      f.dispose()
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "real no-pipe ACL query returns current metadata and leaves no result directory",
  async () => {
    if (process.env.TASK24_BENCHMARK_ACL_PROBE_CHILD !== "1") return freshProcess("real no-pipe ACL query")
    const f = fixture()
    try {
      const actual = BenchmarkAclProbe.make({ tempRoot: f.root, guard() {} })(f.root)
      const original = HostRootPolicy.productionProbe({ tempRoot: f.root })(f.root)
      expect(actual).toEqual(original)
      expect(fs.readdirSync(f.root)).toEqual([])
    } finally {
      f.dispose()
    }
  },
  25000,
)

test.skipIf(process.platform !== "win32")(
  "production selection rejects incomplete, stale, fixture and cross-root benchmark authority before querying ACLs",
  async () => {
    if (process.env.TASK24_BENCHMARK_ACL_PROBE_CHILD !== "1") return freshProcess("production selection rejects")
    const f = fixture("D:\\OpenCode-Benchmark\\Task24\\runs")
    try {
      const deployment = path.join(f.root, "deployment")
      const dirs = {
        data: path.join(deployment, "data"),
        runtime: path.join(deployment, "runtime"),
        cache: path.join(deployment, "cache"),
        preview: path.join(deployment, "preview"),
        config: path.join(deployment, "config"),
        temp: path.join(deployment, "temp"),
      }
      for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })
      const profile = {
        schemaVersion: 1,
        campaignID: "acl-selection",
        runID: "acl-selection",
        brokerOrigin: "http://127.0.0.1:23456",
        providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
        evidenceMode: "production",
        expiresAt: Date.now() + 60000,
        grant: "own-fake-transport-".repeat(4),
      }
      const environment = {
        OPENCODE_WORKFLOW_HOST_ROOT: deployment,
        OPENCODE_WORKFLOW_HOST_DATA: dirs.data,
        OPENCODE_WORKFLOW_HOST_RUNTIME: dirs.runtime,
        OPENCODE_WORKFLOW_HOST_CACHE: dirs.cache,
        OPENCODE_WORKFLOW_HOST_TEMP: dirs.preview,
        OPENCODE_WORKFLOW_EVIDENCE_ROOT: dirs.data,
        PLAYWRIGHT_BROWSERS_PATH: dirs.runtime,
        OPENCODE_WORKFLOW_SANDBOX_CONFIG: dirs.config,
        OPENCODE_WORKFLOW_SANDBOX_TEMP: dirs.temp,
        OPENCODE_WORKFLOW_SANDBOX_IMAGE: "opencode/workflow-sandbox@sha256:" + "a".repeat(64),
        OPENCODE_WORKFLOW_SANDBOX_ENGINE: path.join(f.root, "engine.exe"),
        OPENCODE_BENCHMARK_HOST_FILE: path.join(f.root, "benchmark-host.json"),
        OPENCODE_BENCHMARK_TRANSPORT_FILE: path.join(f.root, "benchmark-transport.json"),
        OPENCODE_BENCHMARK_RUN_DATA_ROOT: f.root,
        OPENCODE_BENCHMARK_CAMPAIGN_ID: profile.campaignID,
        OPENCODE_BENCHMARK_RUN_ID: profile.runID,
      }
      fs.writeFileSync(environment.OPENCODE_BENCHMARK_TRANSPORT_FILE, JSON.stringify(profile))
      for (const changed of [
        { OPENCODE_BENCHMARK_RUN_ID: undefined },
        { OPENCODE_BENCHMARK_RUN_ID: "foreign" },
        { OPENCODE_BENCHMARK_HOST_FILE: path.join(f.root, "wrong.json") },
        { OPENCODE_WORKFLOW_HOST_TEMP: path.dirname(f.root) },
      ]) {
        expect(() => ProductionHostRuntime.load({ ...environment, ...changed })).toThrow()
        expect(fs.readdirSync(dirs.preview)).toEqual([])
      }
      for (const changed of [{ expiresAt: 1 }, { evidenceMode: "deterministic_offline" }]) {
        fs.writeFileSync(environment.OPENCODE_BENCHMARK_TRANSPORT_FILE, JSON.stringify({ ...profile, ...changed }))
        expect(() => ProductionHostRuntime.load(environment)).toThrow()
        expect(fs.readdirSync(dirs.preview)).toEqual([])
      }
      fs.writeFileSync(environment.OPENCODE_BENCHMARK_TRANSPORT_FILE, "not JSON")
      expect(() => ProductionHostRuntime.load({ ...environment, OPENCODE_BENCHMARK_HOST_FILE: undefined })).toThrow(
        "Workflow host ACL",
      )
      fs.writeFileSync(environment.OPENCODE_BENCHMARK_TRANSPORT_FILE, JSON.stringify(profile))
      expect(() => ProductionHostRuntime.load(environment)).toThrow("Workflow host ACL")
      expect(fs.readdirSync(dirs.preview)).toEqual([])
    } finally {
      f.dispose()
    }
  },
  25000,
)
