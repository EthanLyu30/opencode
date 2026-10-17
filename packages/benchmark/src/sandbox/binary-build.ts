import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { Sha256 } from "../schema"
import { FileIdentity, requireDPath, type HostManifest, type EngineSession } from "./contracts"
import { fileIdentity } from "./storage"
import { directRoot } from "../corpus/evaluation-bundle"
import { readControllerJson } from "./readiness"
import { makeProcessRunner, requireOperation } from "./docker"
import { revalidateSession } from "./preflight"
import { publishImmutable } from "../offline/atomic"
const Plan = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  builds: Schema.Array(
    Schema.Struct({
      id: Schema.Literals(["modified", "upstream"]),
      sourceRoot: Schema.String,
      sourceCommit: Schema.String,
      sourceTreeSha256: Sha256,
      git: FileIdentity,
      runtime: FileIdentity,
      script: FileIdentity,
      argv: Schema.Array(Schema.String),
      cwd: Schema.String,
      outputRoot: Schema.String,
      outputFile: Schema.String,
      timeoutMs: Schema.Int,
    }),
  ),
})
type Build = (typeof Plan.Type.builds)[number]
const toolchain = "D:\\OpenCode-Benchmark\\Task24\\toolchain\\"
export function validateBinaryBuildLocation(file: string) {
  requireDPath(file)
  if (!file.toLowerCase().startsWith(toolchain.toLowerCase()) || !file.toLowerCase().endsWith(".exe"))
    throw new TypeError("TASK24_BINARY_NEW_TOOLCHAIN_REQUIRED")
}
function environment(manifest: HostManifest) {
  return {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    HOME: manifest.roots.config,
    USERPROFILE: manifest.roots.config,
    APPDATA: manifest.roots.config,
    LOCALAPPDATA: manifest.roots.temp,
    XDG_CACHE_HOME: manifest.roots.temp,
    TEMP: manifest.roots.temp,
    TMP: manifest.roots.temp,
    BUN_OPTIONS: "--no-env-file",
    NODE_DISABLE_COMPILE_CACHE: "1",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(manifest.roots.temp, "transpiler"),
    npm_config_cache: path.join(manifest.roots.temp, "npm"),
    BUN_INSTALL_CACHE_DIR: path.join(manifest.roots.temp, "bun"),
    PATH: path.dirname(process.execPath) + ";C:\\Windows\\System32",
  }
}
async function gitRead(plan: Build, manifest: HostManifest, root: string, argv: readonly string[]) {
  if (canonicalJson(await fileIdentity(plan.git.path)) !== canonicalJson(plan.git))
    throw new TypeError("TASK24_BINARY_GIT_STALE")
  const result = await makeProcessRunner({
    executable: plan.git.path,
    argvPrefix: ["-c", "core.fsmonitor=false"],
    cwd: root,
    env: { ...environment(manifest), GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" },
  }).execute({
    argv,
    timeoutMs: 15000,
    maxStdoutBytes: 16 * 1024 * 1024,
    maxStderrBytes: 65536,
    signal: new AbortController().signal,
  })
  if (!result.started || result.exitCode || result.truncated) throw new TypeError("TASK24_BINARY_SOURCE_UNOBSERVED")
  return Buffer.from(result.stdout).toString("utf8")
}
async function sourceInventory(plan: Build, manifest: HostManifest, root = plan.sourceRoot) {
  await directRoot(root)
  const list = (await gitRead(plan, manifest, root, ["ls-files", "-z"]))
    .split("\0")
    .filter(Boolean)
    .filter(
      (p) =>
        p === "package.json" ||
        p === "bun.lock" ||
        p === "tsconfig.json" ||
        p === "turbo.json" ||
        p.startsWith("packages/") ||
        p.startsWith("script/"),
    )
    .filter(
      (p) => !/(?:^|\/)(?:test|tests|__tests__|dist|node_modules)(?:\/|$)/.test(p) && !/(?:^|\/)\.env(?:\.|$)/.test(p),
    )
  if (
    !list.length ||
    list.length > 50000 ||
    new Set(list).size !== list.length ||
    list.some((p) => /(?:^|\/)\.env(?:\.|$)/.test(p))
  )
    throw new TypeError("TASK24_BINARY_SOURCE_COVERAGE")
  const files = []
  for (const relative of list.sort()) {
    const file = await fileIdentity(path.join(root, relative))
    files.push({ relative, file })
  }
  return { files, sha256: sha256Text(canonicalJson(files.map((f) => ({ path: f.relative, sha256: f.file.sha256 })))) }
}
type BuildRecord = {
  plan: Build
  sourceFiles: readonly { relative: string; file: FileIdentity }[]
  sourceTreeSha256: string
  output: FileIdentity
  startedAt: number
  completedAt: number
  exitCode: 0
  stdoutSha256: string
  stderrSha256: string
  recordSha256: string
}
function validateRecord(record: BuildRecord) {
  const { recordSha256, ...body } = record
  validateBinaryBuildLocation(record.output.path)
  if (
    record.output.path !== record.plan.outputFile ||
    record.plan.sourceTreeSha256 !== record.sourceTreeSha256 ||
    record.exitCode !== 0 ||
    record.startedAt >= record.completedAt ||
    sha256Text(canonicalJson(body)) !== recordSha256 ||
    !record.output.path.startsWith(record.plan.outputRoot + "\\")
  )
    throw new TypeError("TASK24_BINARY_BUILD_RECORD")
}
export async function prepareBinaryBuildRecords(session: EngineSession) {
  const state = await revalidateSession(session),
    manifest = state.manifest
  if (manifest.phase !== "prepare") throw new TypeError("TASK24_BINARY_PREPARE_SCOPE")
  await requireOperation(session, "binary-build", async () => {
    await revalidateSession(session)
  })
  const artifact = manifest.artifacts.find((a) => a.id === "binary-build-plan")
  if (
    !artifact ||
    !("path" in artifact) ||
    !artifact.path ||
    !("sha256" in artifact) ||
    (await fileIdentity(artifact.path)).sha256 !== artifact.sha256
  )
    throw new TypeError("TASK24_BINARY_BUILD_PLAN_REQUIRED")
  const plan = Schema.decodeUnknownSync(Plan)(await readControllerJson(artifact.path), { onExcessProperty: "error" })
  if (
    plan.builds.length !== 2 ||
    plan.builds
      .map((b) => b.id)
      .sort()
      .join(",") !== "modified,upstream"
  )
    throw new TypeError("TASK24_BINARY_BUILD_COVERAGE")
  const records: BuildRecord[] = []
  for (const build of plan.builds) {
    for (const p of [build.sourceRoot, build.outputRoot, build.cwd, build.outputFile]) requireDPath(p)
    validateBinaryBuildLocation(build.outputFile)
    if (
      ![build.sourceRoot, build.outputRoot].every((p) =>
        state.approval.storageRoots.some((r) => p === r || p.startsWith(r + "\\")),
      ) ||
      !build.sourceRoot.startsWith(toolchain) ||
      !build.outputRoot.startsWith(toolchain) ||
      build.sourceRoot === build.outputRoot ||
      !build.cwd.startsWith(build.sourceRoot + "\\") ||
      build.script.path !== path.join(build.sourceRoot, "packages", "opencode", "script", "build.ts") ||
      build.argv[0] !== build.script.path ||
      build.timeoutMs < 1 ||
      build.timeoutMs > 600000 ||
      !build.argv.includes("--skip-install") ||
      (!build.argv.includes("--outdir") &&
        build.outputRoot !== path.join(build.sourceRoot, "packages", "opencode", "dist")) ||
      build.argv.some((a, i) => a === "--outdir" && build.argv[i + 1] !== build.outputRoot) ||
      (await fs.lstat(build.outputRoot).catch(() => null))
    )
      throw new TypeError("TASK24_BINARY_FRESH_BUILD_REQUIRED")
    await directRoot(path.dirname(build.outputRoot))
    const before = await sourceInventory(build, manifest)
    if (
      before.sha256 !== build.sourceTreeSha256 ||
      (await gitRead(build, manifest, build.sourceRoot, ["rev-parse", "HEAD"])).trim() !== build.sourceCommit ||
      (await gitRead(build, manifest, build.sourceRoot, ["status", "--porcelain", "--untracked-files=normal"])).trim()
    )
      throw new TypeError("TASK24_BINARY_SOURCE_STALE")
    for (const f of [build.runtime, build.script])
      if (canonicalJson(await fileIdentity(f.path)) !== canonicalJson(f))
        throw new TypeError("TASK24_BINARY_BUILD_TOOL_STALE")
    if (
      build.id === "modified" &&
      (await sourceInventory(build, manifest, path.resolve(import.meta.dir, "../../../.."))).sha256 !== before.sha256
    )
      throw new TypeError("TASK24_BINARY_MODIFIED_SOURCE_MISMATCH")
    const startedAt = Date.now(),
      execution = await makeProcessRunner({
        executable: build.runtime.path,
        argvPrefix: ["--no-env-file", "run"],
        cwd: build.cwd,
        env: environment(manifest),
      }).execute({
        argv: build.argv,
        timeoutMs: build.timeoutMs,
        maxStdoutBytes: 65536,
        maxStderrBytes: 65536,
        signal: new AbortController().signal,
      })
    if (!execution.started || execution.exitCode || execution.truncated)
      throw new TypeError("TASK24_BINARY_BUILD_FAILED")
    const after = await sourceInventory(build, manifest),
      output = await fileIdentity(build.outputFile)
    if (after.sha256 !== before.sha256 || (await fs.stat(output.path)).size > state.approval.maxDiskBytes)
      throw new TypeError("TASK24_BINARY_BUILD_SOURCE_DRIFT")
    const body = {
        plan: build,
        sourceFiles: after.files,
        sourceTreeSha256: after.sha256,
        output,
        startedAt,
        completedAt: Date.now(),
        exitCode: 0 as const,
        stdoutSha256: sha256Text(Buffer.from(execution.stdout).toString("base64")),
        stderrSha256: sha256Text(Buffer.from(execution.stderr).toString("base64")),
      },
      record = { ...body, recordSha256: sha256Text(canonicalJson(body)) }
    validateRecord(record)
    records.push(record)
  }
  const result = { schemaVersion: 2, records },
    file = path.join(manifest.roots.evidence, `binary-build-records-${sha256Text(canonicalJson(result))}.json`)
  await publishImmutable(file, canonicalJson(result))
  return {
    file,
    sha256: sha256Text(canonicalJson(result)),
    binarySha256: records.map((r) => ({ id: r.plan.id, sha256: r.output.sha256 })),
  }
}
export async function verifyBinaryBuildRecords(input: { manifest: HostManifest }) {
  const manifest = input.manifest,
    artifact = manifest.artifacts.find((a) => a.id === "binary-build-records")
  if (
    !artifact ||
    !("path" in artifact) ||
    !artifact.path ||
    !("sha256" in artifact) ||
    (await fileIdentity(artifact.path)).sha256 !== artifact.sha256
  )
    throw new TypeError("TASK24_BINARY_BUILD_RECORDS_REQUIRED")
  const raw = Schema.decodeUnknownSync(
    Schema.Struct({ schemaVersion: Schema.Literal(2), records: Schema.Array(Schema.Unknown) }),
  )(await readControllerJson(artifact.path), { onExcessProperty: "error" })
  const records = raw.records as BuildRecord[]
  if (
    records.length !== 2 ||
    records
      .map((r) => r.plan.id)
      .sort()
      .join(",") !== "modified,upstream"
  )
    throw new TypeError("TASK24_BINARY_BUILD_COVERAGE")
  for (const r of records) {
    validateRecord(r)
    const a = manifest.artifacts.find((a) => a.id === r.plan.id)
    if (
      !a ||
      !("path" in a) ||
      a.path !== r.output.path ||
      !("sha256" in a) ||
      a.sha256 !== r.output.sha256 ||
      canonicalJson(await fileIdentity(r.output.path)) !== canonicalJson(r.output)
    )
      throw new TypeError("TASK24_BINARY_BUILD_OUTPUT_STALE")
    const source = await sourceInventory(r.plan, manifest)
    if (
      source.sha256 !== r.sourceTreeSha256 ||
      canonicalJson(source.files) !== canonicalJson(r.sourceFiles) ||
      canonicalJson(await fileIdentity(r.plan.runtime.path)) !== canonicalJson(r.plan.runtime) ||
      canonicalJson(await fileIdentity(r.plan.script.path)) !== canonicalJson(r.plan.script)
    )
      throw new TypeError("TASK24_BINARY_BUILD_SOURCE_STALE")
    if (
      r.plan.id === "modified" &&
      (await sourceInventory(r.plan, manifest, path.resolve(import.meta.dir, "../../../.."))).sha256 !==
        r.sourceTreeSha256
    )
      throw new TypeError("TASK24_BINARY_MODIFIED_SOURCE_MISMATCH")
  }
  return records
}
