import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { stopOwnedProbe } from "./workflow-model-catalog-process"

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const CodingProbeResult = Schema.Struct({
  workflowType: Schema.Literal("coding-build"),
  workflowStatus: Schema.String,
  responseStatus: Schema.String,
  roleModels: Schema.Record(Schema.String, Schema.String),
  checks: Schema.Array(
    Schema.Struct({ revision: count, observedTests: count, failedTests: count, exitCode: Schema.Int }),
  ),
  writes: count,
  reviewReads: count,
  previewCalls: count,
  browserCalls: count,
  outboundCalls: count,
  deliveryValid: Schema.Boolean,
  sourceCorrect: Schema.Boolean,
  sseReplayExclusive: Schema.Boolean,
  settledCallsReplayed: count,
  errorCode: Schema.String,
  workerDeathProven: Schema.Boolean,
  forgedAdmissionRejected: Schema.Boolean,
  cancellationVerified: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: "error" } })
export type CodingProbeResult = typeof CodingProbeResult.Type
export type CodingScenario =
  | "repair"
  | "review"
  | "review-budget"
  | "exhaust"
  | "forged-pass"
  | "config-drift"
  | "ignored-config"
  | "source-drift"
  | "crash-settled"
  | "crash-write"

/** Retained offline acceptance driver; never accepts a provider, credential or arbitrary workspace. */
export async function runCodingProbe(executable: string, scenario: CodingScenario): Promise<CodingProbeResult> {
  if (!path.isAbsolute(executable)) throw new Error("Coding probe requires an exact executable")
  // Git for Windows limits GIT_DIR itself even with core.longpaths; keep owned fixtures shallow.
  const parent = await fs.mkdtemp(
    path.join(await fs.realpath(path.resolve(import.meta.dirname, "../../../.superpowers")), "coding-"),
  )
  if (process.platform === "win32" && path.parse(parent).root.toLowerCase() !== "d:\\")
    throw new Error("Coding probe requires D temporary state")
  const root = await fs.mkdtemp(path.join(parent, "opencode-catalogue-probe-coding-"))
  const nonce = randomUUID()
  await fs.writeFile(path.join(root, "probe-owner.json"), JSON.stringify({ nonce }), { flag: "wx" })
  const environment: Record<string, string> = Object.fromEntries(
    ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]!]],
    ),
  )
  Object.assign(environment, {
    NODE_ENV: "test",
    RECORD: "false",
    OPENCODE_PRIVATE_CATALOGUE_PROBE: nonce,
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_WORKFLOW_MODEL_DISCOVERY: "true",
    OPENCODE_PURE: "1",
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_TEST_HOME: path.join(root, "home"),
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
    OPENCODE_MODELS_PATH: path.resolve(import.meta.dirname, "../../opencode/test/tool/fixtures/models-api.json"),
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    TMPDIR: path.join(root, "tmp"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    BUN_INSTALL_CACHE_DIR: path.join(root, "cache", "bun"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "cache", "transpiler"),
    npm_config_cache: path.join(root, "cache", "npm"),
  })
  await fs.mkdir(environment.TEMP)
  const bounded = async (stream: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = []
    let size = 0
    const reader = stream.getReader()
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.length
        if (size <= 65536) chunks.push(next.value)
      }
    } finally {
      reader.releaseLock()
    }
    if (size > 65536) throw new Error("Coding probe output exceeds its bound")
    return Buffer.concat(chunks).toString("utf8")
  }
  let cleanupSafe = true
  const phase = async (resume: boolean) => {
    const args = ["--internal-catalogue-probe", root, nonce, "coding", scenario + (resume ? "/resume" : "")]
    const command = /(?:^|[\\/])bun(?:\.exe)?$/i.test(executable)
      ? [executable, "--no-env-file", path.resolve(import.meta.dirname, "../../opencode/src/index.ts"), ...args]
      : [executable, ...args]
    const child = Bun.spawn(command, { cwd: root, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    cleanupSafe = false
    const diagnostics = bounded(child.stderr)
    const reader = child.stdout.getReader()
    let expired = false
    let termination: Promise<void> | undefined
    const timer = setTimeout(() => {
      expired = true
      // Retain the live launcher handle while terminating its entire owned tree.
      termination = stopOwnedProbe(child, child.pid)
      void termination.catch(() => undefined)
    }, 150000)
    try {
      let output = ""
      while (!output.includes("\n")) {
        const next = await reader.read()
        if (next.done) {
          const safe = (await diagnostics)
            .split(/\r?\n/)
            .find((line) => /^Private catalogue fixture: [A-Za-z0-9_: -]{1,160}$/.test(line))
          throw new Error(safe ?? "Coding probe exited before its result")
        }
        output += new TextDecoder().decode(next.value)
        if (output.length > 65536 || expired) throw new Error("Coding probe output/deadline bound")
      }
      const envelope = JSON.parse(output.trim()) as { phase: string; pid: number; data: unknown }
      if (envelope.pid !== child.pid) throw new Error("Coding probe result owner mismatch")
      if (!resume && scenario.startsWith("crash-")) {
        const barrier = Schema.decodeUnknownSync(Schema.Struct({ leaseExpiresAt: Schema.Number }))(envelope.data)
        if (
          envelope.phase !== "coding-barrier" ||
          barrier.leaseExpiresAt < Date.now() - 1000 ||
          barrier.leaseExpiresAt > Date.now() + 30000
        )
          throw new Error("Coding crash barrier invalid")
        await stopOwnedProbe(child, envelope.pid)
        cleanupSafe = true
        await diagnostics
        return { barrier }
      }
      if (envelope.phase !== "coding") throw new Error("Coding probe result phase mismatch")
      const result = Schema.decodeUnknownSync(CodingProbeResult)(envelope.data)
      while (!(await reader.read()).done) throw new Error("Coding probe unexpected trailing output")
      if ((await child.exited) !== 0 || expired || (await diagnostics).trim())
        throw new Error("Coding probe did not exit cleanly")
      cleanupSafe = true
      return { result }
    } finally {
      clearTimeout(timer)
      reader.releaseLock()
      if (termination) await termination
      if (!cleanupSafe) {
        await stopOwnedProbe(child, child.pid)
        cleanupSafe = true
      }
      await diagnostics
    }
  }
  try {
    const initial = await phase(false)
    if (initial.result) return initial.result
    if (!initial.barrier) throw new Error("Coding crash barrier missing")
    // Wait for the actual killed worker's last durable lease, not a guessed synchronization delay.
    await Bun.sleep(Math.max(0, initial.barrier.leaseExpiresAt - Date.now() + 5))
    const resumed = await phase(true)
    if (!resumed.result) throw new Error("Coding restart result missing")
    return { ...resumed.result, workerDeathProven: true }
  } finally {
    if (cleanupSafe) {
      await removeOwnedCodingRoot(root, parent, nonce)
      await fs.rmdir(parent)
    }
  }
}

async function removeOwnedCodingRoot(root: string, parent: string, nonce: string) {
  if (
    path.dirname(root) !== parent ||
    JSON.parse(await fs.readFile(path.join(root, "probe-owner.json"), "utf8")).nonce !== nonce
  )
    throw new Error("Coding cleanup lost ownership")
  const remove = async (target: string): Promise<void> => {
    if (
      path.relative(root, target).startsWith("..") ||
      (await fs.realpath(target)).toLowerCase() !== path.resolve(target).toLowerCase()
    )
      throw new Error("Coding cleanup target escaped")
    const stat = await fs.lstat(target)
    if (stat.isSymbolicLink()) throw new Error("Coding cleanup refuses links")
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(target)) await remove(path.join(target, entry))
      await fs.rmdir(target)
      return
    }
    if (stat.nlink !== 1) throw new Error("Coding cleanup refuses shared files")
    await fs.unlink(target)
  }
  await remove(root)
}
