import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { evidenceReferenceForBytes, validateEvidenceReferences, type EvidenceReference } from "./evidence"

const MAX_OUTPUT_BYTES = 1024 * 1024

export interface FunctionalAssertion {
  readonly id: string
  readonly mandatory: boolean
  readonly passed: boolean
  readonly weight: number
}

export interface FunctionalResult {
  readonly points: number
  readonly mandatoryPassed: boolean
  readonly failedMandatory: readonly string[]
  readonly evidence: readonly EvidenceReference[]
}

export interface FunctionalInvocation {
  readonly executable: string
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

export interface FunctionalProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

export type FunctionalRunner = (input: FunctionalInvocation) => Promise<FunctionalProcessResult>

export function scoreFunctionalAssertions(input: {
  readonly assertions: readonly FunctionalAssertion[]
  readonly evidence: readonly EvidenceReference[]
}): FunctionalResult {
  const assertions = validateAssertions(input.assertions)
  const total = assertions.reduce((sum, item) => sum + item.weight, 0)
  const passed = assertions.reduce((sum, item) => sum + (item.passed ? item.weight : 0), 0)
  const failedMandatory = assertions.filter((item) => item.mandatory && !item.passed).map((item) => item.id)
  return Object.freeze({
    points: round((passed / total) * 45),
    mandatoryPassed: failedMandatory.length === 0,
    failedMandatory: Object.freeze(failedMandatory),
    evidence: validateEvidenceReferences(input.evidence),
  })
}

export async function runFunctionalEvaluation(input: {
  readonly evaluatorRoot: string
  readonly workspaceRoot: string
  readonly tempRoot: string
  readonly executable: string
  readonly commandRelativePath: string
  readonly commandSha256: string
  readonly timeoutMs: number
  readonly evidence: readonly EvidenceReference[]
  readonly runner?: FunctionalRunner
}): Promise<FunctionalResult> {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 120_000) {
    throw new TypeError("TASK24_FUNCTIONAL_TIMEOUT_INVALID")
  }
  if (!path.isAbsolute(input.executable)) throw new TypeError("TASK24_FUNCTIONAL_EXECUTABLE_INVALID")
  const evaluatorRoot = directDirectory(input.evaluatorRoot)
  const workspaceRoot = directDirectory(input.workspaceRoot)
  const tempRoot = directDirectory(input.tempRoot)
  if (path.parse(tempRoot).root.toUpperCase() !== "D:\\") throw new TypeError("TASK24_FUNCTIONAL_TEMP_INVALID")
  if (!/^[A-Za-z0-9._/-]{1,512}$/.test(input.commandRelativePath) || input.commandRelativePath.includes("..")) {
    throw new TypeError("TASK24_FUNCTIONAL_COMMAND_INVALID")
  }
  const command = path.resolve(evaluatorRoot, ...input.commandRelativePath.split("/"))
  if (!strictlyContains(evaluatorRoot, command)) throw new TypeError("TASK24_FUNCTIONAL_COMMAND_INVALID")
  const commandBytes = exactFile(command)
  if (!/^[a-f0-9]{64}$/.test(input.commandSha256) || sha256(commandBytes) !== input.commandSha256) {
    throw new TypeError("TASK24_FUNCTIONAL_COMMAND_IDENTITY_INVALID")
  }
  const result = await (input.runner ?? productionFunctionalRunner)({
    executable: input.executable,
    argv: Object.freeze([command]),
    cwd: workspaceRoot,
    env: Object.freeze({
      BUN_INSTALL_CACHE_DIR: tempRoot,
      HOME: tempRoot,
      LANG: "en_US.UTF-8",
      NO_COLOR: "1",
      npm_config_cache: tempRoot,
      TASK24_EVALUATOR: "1",
      TEMP: tempRoot,
      TMP: tempRoot,
      TMPDIR: tempRoot,
      TZ: "UTC",
      USERPROFILE: tempRoot,
      XDG_CACHE_HOME: tempRoot,
      XDG_CONFIG_HOME: tempRoot,
      XDG_DATA_HOME: tempRoot,
      XDG_STATE_HOME: tempRoot,
    }),
    timeoutMs: input.timeoutMs,
  })
  if (result.timedOut) throw new TypeError("TASK24_FUNCTIONAL_TIMEOUT")
  if (result.exitCode !== 0) throw new TypeError("TASK24_FUNCTIONAL_PROCESS_FAILED")
  if (Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES || Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES) {
    throw new TypeError("TASK24_FUNCTIONAL_OUTPUT_OVERSIZED")
  }
  const decoded = parseOutput(result.stdout)
  return scoreFunctionalAssertions({
    assertions: decoded.assertions,
    evidence: [
      ...input.evidence,
      evidenceReferenceForBytes("functional-command", input.commandRelativePath, commandBytes),
    ],
  })
}

export const productionFunctionalRunner: FunctionalRunner = async (input) => {
  const process = Bun.spawn([input.executable, ...input.argv], {
    cwd: input.cwd,
    env: input.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    process.kill()
  }, input.timeoutMs)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      readBounded(process.stdout, () => process.kill()),
      readBounded(process.stderr, () => process.kill()),
    ])
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, kill: () => void): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_OUTPUT_BYTES) {
        kill()
        throw new TypeError("TASK24_FUNCTIONAL_OUTPUT_OVERSIZED")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
}

function parseOutput(value: string): { readonly assertions: readonly FunctionalAssertion[] } {
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    throw new TypeError("TASK24_FUNCTIONAL_OUTPUT_INVALID")
  }
  if (!isRecord(decoded) || decoded.schemaVersion !== 1 || !Array.isArray(decoded.assertions)) {
    throw new TypeError("TASK24_FUNCTIONAL_OUTPUT_INVALID")
  }
  if (Object.keys(decoded).toSorted().join(",") !== "assertions,schemaVersion") {
    throw new TypeError("TASK24_FUNCTIONAL_OUTPUT_INVALID")
  }
  return { assertions: validateAssertions(decoded.assertions) }
}

function validateAssertions(values: readonly unknown[]): readonly FunctionalAssertion[] {
  if (values.length === 0 || values.length > 10_000) throw new TypeError("TASK24_FUNCTIONAL_ASSERTIONS_INVALID")
  const ids = new Set<string>()
  const result = values.map((value) => {
    if (
      !isRecord(value) ||
      Object.keys(value).toSorted().join(",") !== "id,mandatory,passed,weight" ||
      typeof value.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value.id) ||
      typeof value.mandatory !== "boolean" ||
      typeof value.passed !== "boolean" ||
      typeof value.weight !== "number" ||
      !Number.isFinite(value.weight) ||
      value.weight <= 0 ||
      ids.has(value.id)
    ) {
      throw new TypeError("TASK24_FUNCTIONAL_ASSERTIONS_INVALID")
    }
    ids.add(value.id)
    return Object.freeze({ id: value.id, mandatory: value.mandatory, passed: value.passed, weight: value.weight })
  })
  return Object.freeze(result)
}

function directDirectory(value: string): string {
  const absolute = path.resolve(value)
  const stat = fs.lstatSync(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(absolute) !== absolute) {
    throw new TypeError("TASK24_FUNCTIONAL_DIRECTORY_INVALID")
  }
  return absolute
}

function exactFile(value: string): Uint8Array {
  const stat = fs.lstatSync(value)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync.native(value) !== value) {
    throw new TypeError("TASK24_FUNCTIONAL_COMMAND_INVALID")
  }
  return fs.readFileSync(value)
}

function strictlyContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
