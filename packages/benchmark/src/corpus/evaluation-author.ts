import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { sha256Bytes, sha256Text } from "../hash"
import { directRoot, ordinaryFiles } from "./evaluation-bundle"
import { freeze, safePath } from "./evaluation-profile"
import { evaluationCatalogue, type TaskAdapterDefinition } from "./evaluation-catalogue"
import { validateTaskBundle } from "./validate"
import { privateFixture } from "./evaluation-fixtures/private"
import { guardrailFixture } from "./evaluation-fixtures/guardrail"
import { design2codeFixture } from "./evaluation-fixtures/design2code"
import { chartjsFixture } from "./evaluation-fixtures/chartjs"
import { reactPdfFixture } from "./evaluation-fixtures/react-pdf"
import { markedFixture } from "./evaluation-fixtures/marked"
import { disjoint } from "../evaluator/independent/snapshot"

export type CorpusPreparationItem = Readonly<{
  taskID: string
  profileSha256: string
  oracleSha256: string | null
  missing: readonly string[]
  status: "prepared" | "blocked"
}>
export type CorpusPreparationReport = Readonly<{
  schemaVersion: 2
  corpusEngineReady: false
  items: readonly CorpusPreparationItem[]
  sourceSha256: string
  publicMaterialOnly: false
}>
export function publicFixture(t: TaskAdapterDefinition): Readonly<Record<string, string>> {
  switch (t.publicFixtureTemplate) {
    case "private":
      return privateFixture(t.probeModules)
    case "guardrail":
      return guardrailFixture(t.probeModules)
    case "design2code":
      return design2codeFixture()
    case "chartjs":
      return chartjsFixture(t.taskID.endsWith("10301"))
    case "react-pdf":
      return reactPdfFixture()
    case "marked":
      return markedFixture()
  }
}
const source = "D:\\OpenCode-Benchmark\\Task24\\assets\\tasks"
export async function validatePreparationRoots(input: { sourceRoot: string; outputRoot: string }): Promise<void> {
  if (path.resolve(input.sourceRoot).toLowerCase() !== source.toLowerCase())
    throw new TypeError("TASK24_AUTHOR_SOURCE_ROOT")
  await directRoot(input.sourceRoot)
  const output = path.resolve(input.outputRoot)
  const assets = "D:\\OpenCode-Benchmark\\Task24\\assets\\evaluation-v2"
  const temporary = "D:\\OpenCode-Benchmark\\Task24\\tmp\\bprep1-20261017-19ae30d14"
  if (
    output.toLowerCase() !== assets.toLowerCase() &&
    !output.toLowerCase().startsWith(temporary.toLowerCase() + path.sep)
  )
    throw new TypeError("TASK24_AUTHOR_OUTPUT_ROOT")
  if (!disjoint(input.sourceRoot, output)) throw new TypeError("TASK24_AUTHOR_OVERLAP")
  await directRoot(path.dirname(output))
  try {
    await fs.lstat(output)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return
    throw e
  }
  throw new TypeError("TASK24_AUTHOR_OUTPUT_EXISTS")
}
/** Preparation is intentionally not a decoder for executable legacy test scripts. */
export async function prepareTaskMaterials(input: {
  task: TaskAdapterDefinition
  outputRoot: string
  sourceFiles: Readonly<Record<string, Uint8Array>>
  sourceRevision: string
  sourceSha256: string
}): Promise<CorpusPreparationItem> {
  const { task, sourceFiles } = input
  await directRoot(path.dirname(input.outputRoot))
  await fs.mkdir(input.outputRoot)
  const publicFiles: Record<string, Uint8Array> = {},
    privateFiles: Record<string, Uint8Array> = {}
  for (const [file, bytes] of Object.entries(sourceFiles)) {
    safePath(file)
    if (file.startsWith("starter/")) publicFiles[file.slice(8)] = bytes
    else if (file.startsWith("assets/")) publicFiles[file] = bytes
    else if (file.startsWith("gold/")) privateFiles[`legacy/${file.slice(5)}`] = bytes
    else if (file === "LICENSES.json") publicFiles[file] = bytes
  }
  for (const [file, text] of Object.entries(publicFixture(task))) {
    if (publicFiles[file]) throw new TypeError("TASK24_AUTHOR_FIXTURE_COLLISION")
    publicFiles[file] = Buffer.from(text)
  }
  if (task.publicFixtureTemplate === "private" || task.publicFixtureTemplate === "guardrail") {
    const packageBytes = publicFiles["package.json"]
    if (!packageBytes) throw new TypeError("TASK24_AUTHOR_PACKAGE_MISSING")
    const pkg = JSON.parse(Buffer.from(packageBytes).toString("utf8")) as Record<string, unknown>
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>
    publicFiles["package.json"] = Buffer.from(
      canonicalJson({
        ...pkg,
        scripts: {
          ...scripts,
          "task24:smoke": "bun --no-env-file test .task24/smoke.test.ts",
          ...(task.kind === "primary" ? { "task24:build": "bun --no-env-file run .task24/build.ts" } : {}),
        },
      }),
    )
  }
  const publicEntries = Object.entries(publicFiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, bytes]) => ({
      path: `public/${file}`,
      sha256: sha256Bytes(bytes),
      size: bytes.byteLength,
      purpose: /\.(png|jpe?g|webp)$/i.test(file) && file.startsWith("assets/") ? "reference" : "starter",
      origin: "task-public",
    }))
  const missing = [
    "independent-oracle-cases",
    "calibration-candidates",
    "linux-host-attestation",
    ...(task.kind === "primary" ? ["three-viewport-engine-reference", "browser-font-lock", "interaction-oracle"] : []),
    ...(task.stratum === "swebench-multimodal"
      ? [
          "resolved-dependency-image",
          ...task.requiredCapabilities.filter((c) => !["linux-isolation", "browser-three-viewports"].includes(c)),
        ]
      : []),
  ]
  const draft = {
    schemaVersion: 2,
    taskID: task.taskID,
    kind: task.kind,
    stratum: task.stratum,
    executionKind: task.executionKind,
    sourceRevision: input.sourceRevision,
    sourceSha256: input.sourceSha256,
    publicFixtureSha256: sha256Text(canonicalJson(publicEntries)),
    publicInputs: publicEntries,
    sourceEntry: task.sourceEntry,
    probeModules: task.probeModules,
    requiredOracleCases: task.requiredOracleCases,
    requiredCapabilities: task.requiredCapabilities,
    checks:
      task.stratum === "swebench-multimodal"
        ? [{ id: "build", cwd: ".", argv: ["bun", "--no-env-file", "run", "build"], timeoutMs: 300000, required: true }]
        : [
            {
              id: task.kind === "guardrail" ? "test" : "build",
              cwd: ".",
              argv: [
                "bun",
                "--no-env-file",
                ...(task.kind === "guardrail" ? ["test", ".task24/smoke.test.ts"] : ["run", ".task24/build.ts"]),
              ],
              timeoutMs: 30000,
              required: true,
            },
          ],
    protectedPaths: ["package.json", ...Object.keys(publicFixture(task))],
    missing,
  }
  async function write(tree: string, files: Record<string, Uint8Array>) {
    for (const [file, bytes] of Object.entries(files)) {
      safePath(file)
      const target = path.join(input.outputRoot, tree, file)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, bytes, { flag: "wx" })
    }
  }
  await write("public", publicFiles)
  await write("private", privateFiles)
  const controls = {
    required: [
      "correct",
      "alternate-correct",
      "seed",
      "functional-bad",
      ...(task.kind === "primary" ? ["visual-bad", "responsive-bad"] : []),
      "policy-bad",
    ],
    executed: false,
    source: input.sourceSha256,
  }
  await write("private", { "calibration-plan.json": Buffer.from(canonicalJson(controls)) })
  await fs.writeFile(path.join(input.outputRoot, "preparation-profile.json"), canonicalJson(draft), { flag: "wx" })
  return freeze({
    taskID: task.taskID,
    profileSha256: sha256Text(canonicalJson(draft)),
    oracleSha256: null,
    missing,
    status: "blocked" as const,
  })
}
export async function prepareEvaluationCorpus(input: {
  sourceRoot: string
  outputRoot: string
}): Promise<CorpusPreparationReport> {
  await validatePreparationRoots(input)
  const tasks = evaluationCatalogue(),
    names = (await fs.readdir(input.sourceRoot)).sort()
  if (canonicalJson(names) !== canonicalJson(tasks.map((t) => t.taskID).sort()))
    throw new TypeError("TASK24_AUTHOR_FIXED_TASKS")
  await fs.mkdir(input.outputRoot)
  const items: CorpusPreparationItem[] = [],
    sources = []
  for (const task of tasks) {
    const root = path.join(input.sourceRoot, task.taskID)
    await directRoot(root)
    const bundle = await validateTaskBundle(root)
    const before = await ordinaryFiles(root)
    const sourceFiles: Record<string, Uint8Array> = {}
    for (const f of bundle.files) {
      const bytes = await fs.readFile(path.join(root, f.path))
      if (sha256Bytes(bytes) !== f.sha256) throw new TypeError("TASK24_AUTHOR_SOURCE_DRIFT")
      sourceFiles[f.path] = bytes
    }
    items.push(
      await prepareTaskMaterials({
        task,
        outputRoot: path.join(input.outputRoot, task.taskID),
        sourceFiles,
        sourceRevision: bundle.manifest.source.revision,
        sourceSha256: bundle.bundleSha256,
      }),
    )
    if (canonicalJson(before) !== canonicalJson(await ordinaryFiles(root)))
      throw new TypeError("TASK24_AUTHOR_SOURCE_DRIFT")
    sources.push({ taskID: task.taskID, bundleSha256: bundle.bundleSha256 })
  }
  const report = freeze({
    schemaVersion: 2 as const,
    corpusEngineReady: false as const,
    items,
    sourceSha256: sha256Text(canonicalJson(sources)),
    publicMaterialOnly: false as const,
  })
  await fs.writeFile(path.join(input.outputRoot, "preparation-report.json"), canonicalJson(report), { flag: "wx" })
  return report
}
