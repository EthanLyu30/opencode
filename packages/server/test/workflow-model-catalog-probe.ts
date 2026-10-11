import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { Hash } from "@opencode-ai/core/util/hash"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { stopOwnedProbe } from "./workflow-model-catalog-process"

const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const ProbeResult = Schema.Struct({
  generationCallsDuringDiscovery: count,
  generationCallsDuringActivation: count,
  settledCallsReplayed: count,
  originalModelID: Schema.NonEmptyString,
  recoveredModelID: Schema.NonEmptyString,
  selectedSuccessorID: Schema.NonEmptyString,
  newAdmissionModelID: Schema.NonEmptyString,
}).annotate({ parseOptions: { onExcessProperty: "error" } })
export type ProbeResult = typeof ProbeResult.Type
const message = Schema.Struct({
  phase: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  data: Schema.Record(Schema.String, Schema.Unknown),
})
const source = path.resolve(import.meta.dirname, "../../opencode/src/index.ts")
const models = path.resolve(import.meta.dirname, "../../opencode/test/tool/fixtures/models-api.json")

function invariant(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`Catalogue probe failed: ${label}`)
}

async function ownedTree(root: string) {
  invariant(path.basename(root).startsWith("opencode-catalogue-probe-"), "temporary ownership")
  invariant((await fs.realpath(root)).toLowerCase() === path.resolve(root).toLowerCase(), "temporary root")
  const inspect = async (directory: string): Promise<void> => {
    for (const child of await fs.readdir(directory, { withFileTypes: true })) {
      invariant(!child.isSymbolicLink(), "temporary reparse point")
      const target = path.join(directory, child.name)
      const stat = await fs.lstat(target)
      invariant(!stat.isSymbolicLink(), "temporary symlink")
      if (stat.isDirectory()) await inspect(target)
    }
  }
  await inspect(root)
}

// Retained acceptance fixture, not a public provider URL/credential override.
export async function runCatalogueProbe(executable: string): Promise<ProbeResult> {
  invariant(path.isAbsolute(executable), "exact executable path")
  invariant(!/["\r\n]/.test(executable), "executable quoting")
  const temporary = os.tmpdir()
  invariant(process.platform !== "win32" || path.parse(temporary).root.toLowerCase() === "d:\\", "D temporary root")
  invariant(
    (await fs.realpath(temporary)).toLowerCase() === path.resolve(temporary).toLowerCase(),
    "temporary ancestry",
  )
  const root = await fs.mkdtemp(path.join(temporary, "opencode-catalogue-probe-"))
  const nonce = randomUUID()
  await fs.writeFile(path.join(root, "probe-owner.json"), JSON.stringify({ nonce }), { flag: "wx" })
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    RECORD: "false",
    DEEPSEEK_API_KEY: "",
    MOONSHOT_API_KEY: "",
    OPENAI_API_KEY: "",
    OPENCODE_DISABLE_WORKFLOW_MODEL_DISCOVERY: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_PURE: "1",
    OPENCODE_CONFIG_CONTENT: "{}",
    OPENCODE_TEST_HOME: path.join(root, "home"),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
    OPENCODE_MODELS_PATH: models,
    OPENCODE_PRIVATE_CATALOGUE_PROBE: nonce,
    OPENCODE_BENCHMARK_TRANSPORT_FILE: undefined,
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
  await fs.mkdir(environment.TEMP)
  let processCleanupComplete = true
  const phase = async (name: string, kill = false, head?: string) => {
    const args = ["--internal-catalogue-probe", root, nonce, name, ...(head ? [head] : [])]
    const command = /(?:^|[\\/])bun(?:\.exe)?$/i.test(executable)
      ? [executable, "--no-env-file", source, ...args]
      : executable.endsWith(".cmd")
        ? ["cmd.exe", "/d", "/c", executable, ...args]
        : [executable, ...args]
    const child = Bun.spawn(command, { cwd: root, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    let workerPID: number | undefined
    const stderrReader = child.stderr.getReader()
    const stdoutReader = child.stdout.getReader()
    // Retain only the fixture's body-free failure label; drain all other diagnostics.
    const stderr = (async () => {
      const reader = stderrReader
      const decoder = new TextDecoder()
      let buffered = ""
      let failure: string | undefined
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) return failure
          buffered += decoder.decode(next.value, { stream: true })
          if (buffered.length > 64 * 1024) buffered = ""
          const lines = buffered.split("\n")
          buffered = lines.pop() ?? ""
          for (const line of lines) {
            if (/^Private catalogue fixture: [a-zA-Z0-9_: -]{1,160}$/.test(line.trim())) failure = line.trim()
            if (!failure && /^Private catalogue probe (?:failed|unavailable)$/.test(line.trim())) failure = line.trim()
          }
        }
      } finally {
        reader.releaseLock()
      }
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Catalogue probe deadline: ${name}`)), 45_000)
    })
    try {
      const read = async () => {
        const reader = stdoutReader
        const decoder = new TextDecoder()
        let text = ""
        try {
          while (true) {
            const next = await reader.read()
            if (next.done)
              throw new Error(
                `Catalogue probe exited before readiness: ${name}; ${(await stderr) ?? "no safe diagnostic"}`,
              )
            text += decoder.decode(next.value, { stream: true })
            invariant(text.length <= 64 * 1024, "bounded process output")
            const end = text.indexOf("\n")
            if (end < 0) continue
            const value = Schema.decodeUnknownSync(message)(JSON.parse(text.slice(0, end)))
            invariant(value.phase === name, "readiness phase")
            workerPID = value.pid
            return value.data
          }
        } finally {
          /* Finalization cancels the reader even when readiness hits its deadline. */
        }
      }
      const value = await Promise.race([read(), deadline])
      if (kill) await stopOwnedProbe(child, workerPID)
      else invariant((await Promise.race([child.exited, deadline])) === 0, `${name} exit`)
      await child.exited
      if (kill && (name === "publish-before" || name === "publish-after")) {
        // Advance only this dead worker's owned heartbeat, as in the Core crash tests.
        const scope = Schema.decodeUnknownSync(WorkflowModelCatalog.Sha256)(value.scopeSha256)
        await ownedTree(root)
        const heartbeat = path.join(
          root,
          "catalogue",
          "scopes",
          scope,
          "locks",
          `${Hash.fast(`workflow-model-catalog:${scope}`)}.lock`,
          "heartbeat",
        )
        const expired = new Date(Date.now() - 120_000)
        await fs.utimes(heartbeat, expired, expired)
      }
      return value
    } finally {
      try {
        await stopOwnedProbe(child, workerPID)
      } catch (error) {
        processCleanupComplete = false
        throw error
      } finally {
        // Bounded pipe draining: inherited pipes cannot keep the finalizer alive after the deadline.
        await stdoutReader.cancel().catch(() => undefined)
        stdoutReader.releaseLock()
        await stderrReader.cancel().catch(() => undefined)
        await stderr
        clearTimeout(timer)
      }
    }
  }
  try {
    const seed = await phase("seed", true)
    const before = await phase("read")
    await phase("publish-before", true)
    invariant((await phase("read")).head === before.head, "pre-head death preserves head")
    await phase("publish-after", true)
    const published = await phase("read")
    invariant(published.head !== before.head, "post-head death commits head")
    const results = await Promise.all([
      phase("activate", false, String(published.head)),
      phase("activate", false, String(published.head)),
    ])
    invariant(results.filter((item) => item.activated === true).length === 1, "cross-process activation CAS")
    const activated = await phase("read")
    invariant(activated.current === "kimi-successor-fixture", "confirmed successor")
    invariant(activated.predecessorLifecycle === "superseded", "predecessor retirement")
    await phase("pending", true)
    await phase("ambiguous")
    await phase("settled", true)
    const replayed = await phase("replay")
    const admitted = await phase("admit", true)
    await phase("gate", true)
    await phase("gate-restart")
    await phase("fences")
    const result = Schema.decodeUnknownSync(ProbeResult)({
      generationCallsDuringDiscovery: seed.generation,
      generationCallsDuringActivation: results.reduce((sum, item) => sum + Number(item.generation), 0),
      settledCallsReplayed: replayed.generation,
      originalModelID: seed.originalModelID,
      recoveredModelID: replayed.recoveredModelID,
      selectedSuccessorID: activated.current,
      newAdmissionModelID: admitted.newAdmissionModelID,
    })
    const scan = async (directory: string): Promise<void> => {
      for (const child of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, child.name)
        if (child.isDirectory()) await scan(target)
        else
          invariant(!(await fs.readFile(target)).includes(Buffer.from("offline-private-probe-credential")), "redaction")
      }
    }
    await scan(root)
    return result
  } finally {
    invariant(processCleanupComplete, "cleanup withheld because worker termination is unverified")
    await ownedTree(root)
    await fs.rm(root, { recursive: true })
  }
}
