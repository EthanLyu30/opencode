import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Bytes, sha256Text } from "../hash"
import { directRoot, ordinaryFiles, loadEvaluationBundle } from "./evaluation-bundle"
import { decodeEvaluationOracle, freeze, safePath } from "./evaluation-profile"
import { evaluationCatalogue, type TaskAdapterDefinition } from "./evaluation-catalogue"
import type { FileEntry } from "./manifest"
import { applyControlPatch } from "./evaluation-controls"
import { PositiveInt, Sha256, TaskID } from "../schema"
import { bindEvidenceFile, verifyEvidenceFile } from "../evaluator/evidence"

const Kinds = [
  "correct",
  "alternate-correct",
  "seed",
  "functional-bad",
  "visual-bad",
  "responsive-bad",
  "policy-bad",
] as const
const Edit = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("copy"), from: Schema.NonEmptyString, path: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("patch"), from: Schema.NonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("replace"),
    path: Schema.NonEmptyString,
    search: Schema.NonEmptyString,
    replacement: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("append"), path: Schema.NonEmptyString, text: Schema.NonEmptyString }),
])
const InteractionAssertion = Schema.Struct({
  id: Schema.NonEmptyString,
  observation: Schema.Literals([
    "keyboard.tabFocusMoved",
    "keyboard.focusVisible",
    "keyboard.enterActivated",
    "keyboard.spaceActivated",
    "consoleErrors",
    "pageErrors",
  ]),
  value: Schema.Unknown,
})
const Envelope = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  taskID: Schema.NonEmptyString,
  cases: Schema.Array(Schema.Unknown),
  requirements: Schema.Array(Schema.Unknown),
  quality: Schema.Array(Schema.NonEmptyString),
  policy: Schema.Array(Schema.NonEmptyString),
  interactionAssertions: Schema.optionalKey(Schema.Array(InteractionAssertion)),
  controls: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(Kinds),
      base: Schema.Literals(["seed", "correct"]),
      edits: Schema.Array(Edit),
      expected: Schema.Struct({
        functional: Schema.Literals(["pass", "fail", "not_observed"]),
        visual: Schema.NullOr(Schema.Literals(["pass", "fail", "not_observed"])),
        policy: Schema.Literals(["pass", "fail"]),
      }),
    }),
  ),
})
type Envelope = typeof Envelope.Type
export type AuthoredOracle = Omit<Envelope, "cases" | "requirements"> &
  Pick<ReturnType<typeof decodeEvaluationOracle>, "cases" | "requirements">
export type CalibrationCandidate = Readonly<{
  schemaVersion: 2
  kind: Envelope["controls"][number]["kind"]
  treeSha256: string
  entries: readonly FileEntry[]
  overlays: readonly { path: string; sha256: string }[]
  expected: Envelope["controls"][number]["expected"]
}>
export type TaskAuthoring = Readonly<{
  schemaVersion: 2
  taskID: string
  oracleSha256: string
  canary: FileEntry
  requirementsSource: FileEntry
  seed: readonly FileEntry[]
  controls: readonly CalibrationCandidate[]
  engineVerified: false
}>

export function decodeOracleAuthoring(input: unknown, task: TaskAdapterDefinition): AuthoredOracle {
  canonicalJson(input)
  const raw = Schema.decodeUnknownSync(Envelope)(input, { onExcessProperty: "error" })
  const interactions = raw.interactionAssertions ?? []
  if (
    (task.kind === "primary" &&
      [
        "keyboard.tabFocusMoved",
        "keyboard.focusVisible",
        "keyboard.enterActivated",
        "keyboard.spaceActivated",
        "consoleErrors",
        "pageErrors",
      ].some((key) => !interactions.some((a) => a.observation === key))) ||
    (task.kind === "guardrail" && interactions.length) ||
    new Set(interactions.map((a) => a.id)).size !== interactions.length
  )
    throw new TypeError("TASK24_AUTHORING_INTERACTION_COVERAGE")
  if (raw.taskID !== task.taskID) throw new TypeError("TASK24_AUTHORING_TASK_IDENTITY")
  // Functional authoring is complete independently of unavailable engine/reference identities.
  const oracle = decodeEvaluationOracle({
    schemaVersion: 2,
    taskID: task.taskID,
    kind: "guardrail",
    privateFiles: [],
    publicReferenceManifest: null,
    cases: raw.cases,
    requirements: raw.requirements,
    quality: raw.quality,
    policy: raw.policy,
    visual: null,
    calibration: [],
    note: "",
  })
  if (task.requiredOracleCases.some((id) => !oracle.cases.some((c) => c.id === id)))
    throw new TypeError("TASK24_AUTHORING_CASE_COVERAGE")
  const required = Kinds.filter((k) => task.kind === "primary" || !["visual-bad", "responsive-bad"].includes(k))
  if (
    raw.controls.length !== required.length ||
    new Set(raw.controls.map((c) => c.kind)).size !== required.length ||
    required.some((k) => !raw.controls.some((c) => c.kind === k))
  )
    throw new TypeError("TASK24_AUTHORING_CONTROL_COVERAGE")
  for (const control of raw.controls) {
    if (
      (control.kind === "seed" && (control.base !== "seed" || control.edits.length)) ||
      (control.kind === "correct" && control.base !== "seed") ||
      (!["seed", "correct"].includes(control.kind) && control.base !== "correct")
    )
      throw new TypeError("TASK24_AUTHORING_CONTROL_BASE")
    if ((task.kind === "guardrail") !== (control.expected.visual === null))
      throw new TypeError("TASK24_AUTHORING_CONTROL_KIND")
    if (
      ["correct", "alternate-correct"].includes(control.kind) &&
      (control.expected.functional !== "pass" ||
        control.expected.policy !== "pass" ||
        (task.kind === "primary" && control.expected.visual !== "pass"))
    )
      throw new TypeError("TASK24_AUTHORING_CONTROL_EXPECTATION")
    for (const edit of control.edits) {
      if ("path" in edit) safePath(edit.path)
      if ("from" in edit) {
        safePath(edit.from)
        if (!edit.from.startsWith("gold/")) throw new TypeError("TASK24_AUTHORING_PRIVATE_SOURCE")
      }
    }
  }
  return freeze({ ...raw, cases: oracle.cases, requirements: oracle.requirements })
}

export async function authorIndependentTask(input: {
  task: TaskAdapterDefinition
  sourceFiles: Readonly<Record<string, Uint8Array>>
  publicFiles: Readonly<Record<string, Uint8Array>>
  outputRoot: string
  authoring: unknown
  protectedPaths?: readonly string[]
}): Promise<TaskAuthoring> {
  const provided = decodeOracleAuthoring(input.authoring, input.task)
  const requirementBytes = input.sourceFiles["gold/requirements.json"]
  const RequirementsSource = Schema.Struct({
    mandatory: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
    selectors: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
    observableOnly: Schema.optionalKey(Schema.Boolean),
  })
  const inherited = Schema.decodeUnknownSync(RequirementsSource)(
    requirementBytes ? JSON.parse(Buffer.from(requirementBytes).toString("utf8")) : {},
    { onExcessProperty: "error" },
  )
  const sourceAssertions = [
    ...(inherited.mandatory ?? []).map((text) => ({
      id: `source-mandatory-${sha256Text(text).slice(0, 16)}`,
      mandatory: true,
      weight: 1,
    })),
    ...(inherited.selectors ?? []).map((text) => ({
      id: `source-selector-${sha256Text(text).slice(0, 16)}`,
      mandatory: true,
      weight: 1,
    })),
  ]
  const oracle = decodeOracleAuthoring(
    { ...provided, requirements: [...provided.requirements, ...sourceAssertions] },
    input.task,
  )
  const requirementSourceBytes = Buffer.from(
    canonicalJson({
      schemaVersion: 2,
      source: requirementBytes
        ? { path: "gold/requirements.json", sha256: sha256Bytes(requirementBytes), size: requirementBytes.byteLength }
        : null,
      mandatory: inherited.mandatory ?? [],
      selectors: inherited.selectors ?? [],
      observableOnly: inherited.observableOnly ?? null,
    }),
  )
  if (oracle.cases.some((c) => !Object.hasOwn(input.publicFiles, c.module)))
    throw new TypeError("TASK24_AUTHORING_PROBE_MODULE_MISSING")
  await directRoot(path.dirname(input.outputRoot))
  await fs.mkdir(input.outputRoot)
  await fs.mkdir(path.join(input.outputRoot, "blobs"))
  await fs.mkdir(path.join(input.outputRoot, "controls"))
  const seed = entries(input.publicFiles)
  const controlFiles = new Map<string, Readonly<Record<string, Uint8Array>>>()
  const controls: CalibrationCandidate[] = []
  for (const kind of Kinds) {
    const control = oracle.controls.find((c) => c.kind === kind)
    if (!control) continue
    const files: Record<string, Uint8Array> = {
      ...(control.base === "seed" ? input.publicFiles : controlFiles.get("correct")),
    }
    if (control.base === "correct" && !controlFiles.has("correct"))
      throw new TypeError("TASK24_AUTHORING_CONTROL_ORDER")
    for (const edit of control.edits) {
      if (edit.kind === "patch") {
        const patch = input.sourceFiles[edit.from]
        if (!patch) throw new TypeError("TASK24_AUTHORING_SOURCE_MISSING")
        Object.assign(files, applyControlPatch(files, Buffer.from(patch).toString("utf8")))
        continue
      }
      safePath(edit.path)
      if (/(?:^|\/)(?:\.git|\.env|node_modules)(?:[/.]|$)/i.test(edit.path))
        throw new TypeError("TASK24_AUTHORING_CONTROL_PATH")
      if (edit.kind === "copy") {
        const bytes = input.sourceFiles[edit.from]
        if (!bytes) throw new TypeError("TASK24_AUTHORING_SOURCE_MISSING")
        files[edit.path] = bytes
        continue
      }
      const old = files[edit.path]
      if (!old) throw new TypeError("TASK24_AUTHORING_EDIT_MISSING")
      const text = Buffer.from(old).toString("utf8")
      if (edit.kind === "replace") {
        const at = text.indexOf(edit.search)
        if (at < 0 || text.indexOf(edit.search, at + edit.search.length) >= 0)
          throw new TypeError("TASK24_AUTHORING_EDIT_AMBIGUOUS")
        files[edit.path] = Buffer.from(text.slice(0, at) + edit.replacement + text.slice(at + edit.search.length))
        continue
      }
      files[edit.path] = Buffer.from(text + edit.text)
    }
    for (const file of input.protectedPaths ?? []) {
      safePath(file)
      if (!input.publicFiles[file] && !files[file]) continue
      if (!input.publicFiles[file] || !files[file] || sha256Bytes(files[file]) !== sha256Bytes(input.publicFiles[file]))
        throw new TypeError("TASK24_AUTHORING_PROTECTED_CONTROL_EDIT")
    }
    const list = entries(files),
      overlays = []
    for (const file of list) {
      const bytes = files[file.path]!
      // All inputs, including unchanged seed files, are private content-addressed bytes.
      // No recipe depends on a future mutable source directory.
      const blob = path.join(input.outputRoot, "blobs", file.sha256)
      try {
        await fs.writeFile(blob, bytes, { flag: "wx" })
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
        if (sha256Bytes(await fs.readFile(blob)) !== file.sha256) throw new TypeError("TASK24_AUTHORING_BLOB_CONFLICT")
      }
      if (!seed.some((s) => s.path === file.path && s.sha256 === file.sha256))
        overlays.push({ path: file.path, sha256: file.sha256 })
    }
    const candidate = freeze({
      schemaVersion: 2 as const,
      kind,
      treeSha256: sha256Text(canonicalJson(list)),
      entries: list,
      overlays,
      expected: control.expected,
    })
    if (controls.some((c) => c.treeSha256 === candidate.treeSha256))
      throw new TypeError("TASK24_AUTHORING_DUPLICATE_CONTROL")
    await fs.writeFile(path.join(input.outputRoot, "controls", `${kind}.json`), canonicalJson(candidate), {
      flag: "wx",
    })
    controlFiles.set(kind, files)
    controls.push(candidate)
  }
  const oracleBytes = canonicalJson(oracle)
  await fs.writeFile(path.join(input.outputRoot, "oracle-authored.json"), oracleBytes, { flag: "wx" })
  const requirementsSource = {
    path: "source-requirements.json",
    sha256: sha256Bytes(requirementSourceBytes),
    size: requirementSourceBytes.length,
  }
  await fs.writeFile(path.join(input.outputRoot, requirementsSource.path), requirementSourceBytes, { flag: "wx" })
  const canaryBytes = Buffer.from(`TASK24_PRIVATE_CANARY_${sha256Text(oracleBytes + input.task.taskID)}`)
  const canary = { path: "canary.txt", sha256: sha256Bytes(canaryBytes), size: canaryBytes.length }
  await fs.writeFile(path.join(input.outputRoot, canary.path), canaryBytes, { flag: "wx" })
  const result = freeze({
    schemaVersion: 2 as const,
    taskID: input.task.taskID,
    oracleSha256: sha256Text(oracleBytes),
    canary,
    requirementsSource,
    seed,
    controls,
    engineVerified: false as const,
  })
  await fs.writeFile(path.join(input.outputRoot, "authoring.json"), canonicalJson(result), { flag: "wx" })
  await verifyTaskAuthoring({ root: input.outputRoot, task: input.task })
  return result
}
function entries(files: Readonly<Record<string, Uint8Array>>): readonly FileEntry[] {
  const result = Object.entries(files)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, bytes]) => ({ path: safePath(file), sha256: sha256Bytes(bytes), size: bytes.byteLength }))
  if (
    !result.length ||
    result.length > 20000 ||
    result.some((f) => f.size > 8 * 1024 * 1024) ||
    result.reduce((n, f) => n + f.size, 0) > 64 * 1024 * 1024 ||
    new Set(result.map((f) => f.path.toLowerCase())).size !== result.length
  )
    throw new TypeError("TASK24_AUTHORING_CANDIDATE_LIMIT")
  return freeze(result)
}
export async function verifyTaskAuthoring(input: {
  root: string
  task: TaskAdapterDefinition
}): Promise<TaskAuthoring> {
  await directRoot(input.root)
  const files = await ordinaryFiles(input.root)
  const bytes = await fs.readFile(path.join(input.root, "oracle-authored.json"))
  const oracle = decodeOracleAuthoring(JSON.parse(bytes.toString("utf8")), input.task)
  const record = JSON.parse(await fs.readFile(path.join(input.root, "authoring.json"), "utf8")) as TaskAuthoring
  if (
    record.schemaVersion !== 2 ||
    record.taskID !== input.task.taskID ||
    record.oracleSha256 !== sha256Bytes(bytes) ||
    record.engineVerified !== false ||
    record.controls.length !== oracle.controls.length
  )
    throw new TypeError("TASK24_AUTHORING_IDENTITY")
  if (
    record.canary?.path !== "canary.txt" ||
    !files.some(
      (f) => f.path === record.canary.path && f.sha256 === record.canary.sha256 && f.size === record.canary.size,
    )
  )
    throw new TypeError("TASK24_AUTHORING_CANARY_DRIFT")
  if (
    record.requirementsSource?.path !== "source-requirements.json" ||
    !files.some(
      (f) =>
        f.path === record.requirementsSource.path &&
        f.sha256 === record.requirementsSource.sha256 &&
        f.size === record.requirementsSource.size,
    )
  )
    throw new TypeError("TASK24_AUTHORING_REQUIREMENTS_DRIFT")
  for (const control of record.controls) {
    const declaration = oracle.controls.find((c) => c.kind === control.kind)
    if (
      !Kinds.includes(control.kind) ||
      !declaration ||
      canonicalJson(control.expected) !== canonicalJson(declaration.expected) ||
      record.controls.filter((c) => c.kind === control.kind).length !== 1
    )
      throw new TypeError("TASK24_AUTHORING_CONTROL_DECLARATION_DRIFT")
    if (
      sha256Text(canonicalJson(control.entries)) !== control.treeSha256 ||
      canonicalJson(
        JSON.parse(await fs.readFile(path.join(input.root, "controls", `${control.kind}.json`), "utf8")),
      ) !== canonicalJson(control)
    )
      throw new TypeError("TASK24_AUTHORING_CONTROL_DRIFT")
    const data: Record<string, Uint8Array> = {}
    for (const entry of control.entries) {
      safePath(entry.path)
      if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new TypeError("TASK24_AUTHORING_HASH")
      const blob = files.find((f) => f.path === `blobs/${entry.sha256}`)
      if (!blob || blob.sha256 !== entry.sha256 || blob.size !== entry.size)
        throw new TypeError("TASK24_AUTHORING_BLOB_DRIFT")
      data[entry.path] = await fs.readFile(path.join(input.root, blob.path))
    }
    if (canonicalJson(entries(data)) !== canonicalJson(control.entries))
      throw new TypeError("TASK24_AUTHORING_ENTRY_DRIFT")
  }
  return freeze(record)
}
export async function materializeCalibrationCandidate(input: {
  root: string
  kind: CalibrationCandidate["kind"]
  destination: string
}): Promise<void> {
  await directRoot(input.root)
  await directRoot(path.dirname(input.destination))
  await directRoot(path.join(input.root, "blobs"))
  await directRoot(path.join(input.root, "controls"))
  const from = path.resolve(input.root).toLowerCase(),
    to = path.resolve(input.destination).toLowerCase()
  if (to === from || to.startsWith(from + path.sep) || from.startsWith(to + path.sep))
    throw new TypeError("TASK24_AUTHORING_MATERIALIZE_OVERLAP")
  if (!Kinds.includes(input.kind)) throw new TypeError("TASK24_AUTHORING_CONTROL_KIND")
  const candidate = JSON.parse(
    await fs.readFile(path.join(input.root, "controls", `${input.kind}.json`), "utf8"),
  ) as CalibrationCandidate
  if (sha256Text(canonicalJson(candidate.entries)) !== candidate.treeSha256)
    throw new TypeError("TASK24_AUTHORING_CONTROL_DRIFT")
  const data: Record<string, Uint8Array> = {}
  for (const entry of candidate.entries) {
    safePath(entry.path)
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new TypeError("TASK24_AUTHORING_HASH")
    const blob = path.join(input.root, "blobs", entry.sha256),
      stat = await fs.lstat(blob)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new TypeError("TASK24_AUTHORING_BLOB_LINK")
    const bytes = await fs.readFile(blob)
    if (sha256Bytes(bytes) !== entry.sha256 || bytes.length !== entry.size)
      throw new TypeError("TASK24_AUTHORING_BLOB_DRIFT")
    data[entry.path] = bytes
  }
  if (canonicalJson(entries(data)) !== canonicalJson(candidate.entries))
    throw new TypeError("TASK24_AUTHORING_ENTRY_DRIFT")
  await fs.mkdir(input.destination)
  for (const [relative, bytes] of Object.entries(data)) {
    const file = path.join(input.destination, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, bytes, { flag: "wx" })
  }
}

/** Read-only static acceptance. It neither imports nor launches any corpus candidate. */
export async function verifyPreparedCorpus(input: { root: string }) {
  const root = await directRoot(input.root),
    tasks = evaluationCatalogue()
  bindEvidenceFile(root, path.join(root, "preparation-report.json"), "preparation-report")
  const Report = Schema.Struct({
    schemaVersion: Schema.Literal(2),
    corpusEngineReady: Schema.Literal(false),
    publicMaterialOnly: Schema.Literal(false),
    sourceSha256: Sha256,
    items: Schema.NonEmptyArray(
      Schema.Struct({
        taskID: TaskID,
        profileSha256: Sha256,
        oracleSha256: Sha256,
        oracleFormat: Schema.Literals(["strict-v2", "authored-v2"]),
        authoringReady: Schema.Literal(true),
        controls: PositiveInt,
        missing: Schema.Array(Schema.NonEmptyString),
        status: Schema.Literal("blocked"),
      }),
    ),
  })
  const report = Schema.decodeUnknownSync(Report)(
    JSON.parse(await fs.readFile(path.join(root, "preparation-report.json"), "utf8")),
    { onExcessProperty: "error" },
  )
  if (
    report.items.length !== tasks.length ||
    new Set(report.items.map((i) => i.taskID)).size !== tasks.length ||
    tasks.some((t) => !report.items.some((i) => i.taskID === t.taskID))
  )
    throw new TypeError("TASK24_AUTHORING_CORPUS_COVERAGE")
  const records = []
  for (const task of tasks) {
    const item = report.items.find((i) => i.taskID === task.taskID)!,
      directory = path.join(root, task.taskID),
      authoringRoot = path.join(directory, "private", "authoring")
    if (
      item.missing.some((v) => ["independent-oracle-cases", "calibration-candidates", "interaction-oracle"].includes(v))
    )
      throw new TypeError("TASK24_AUTHORING_INCOMPLETE")
    const authored = await verifyTaskAuthoring({ root: authoringRoot, task })
    const oracle = decodeOracleAuthoring(
      JSON.parse(await fs.readFile(path.join(authoringRoot, "oracle-authored.json"), "utf8")),
      task,
    )
    if (authored.controls.length !== item.controls) throw new TypeError("TASK24_AUTHORING_CONTROL_COUNT")
    const canary = await fs.readFile(path.join(authoringRoot, authored.canary.path))
    for (const file of await ordinaryFiles(path.join(directory, "public"))) {
      if ((await fs.readFile(path.join(directory, "public", file.path))).includes(canary))
        throw new TypeError("TASK24_AUTHORING_PUBLIC_CANARY_LEAK")
    }
    let strictBundleSha256: string | null = null
    if (item.oracleFormat === "strict-v2") {
      const bundle = await loadEvaluationBundle(directory)
      if (
        bundle.profileSha256 !== item.profileSha256 ||
        bundle.oracleSha256 !== item.oracleSha256 ||
        task.kind !== "guardrail"
      )
        throw new TypeError("TASK24_AUTHORING_STRICT_IDENTITY")
      strictBundleSha256 = bundle.bundleSha256
    } else {
      if (
        task.kind !== "primary" ||
        authored.oracleSha256 !== item.oracleSha256 ||
        sha256Bytes(await fs.readFile(path.join(directory, "preparation-profile.json"))) !== item.profileSha256
      )
        throw new TypeError("TASK24_AUTHORING_DRAFT_IDENTITY")
    }
    const sources = JSON.parse(
      await fs.readFile(path.join(directory, "private", "oracle-visual-sources.json"), "utf8"),
    ) as { schemaVersion: number; taskID: string; files: FileEntry[] | null; engineBinding: unknown }
    if (
      sources.schemaVersion !== 2 ||
      sources.taskID !== task.taskID ||
      sources.engineBinding !== null ||
      (task.kind === "guardrail") !== (sources.files === null)
    )
      throw new TypeError("TASK24_AUTHORING_REFERENCE_IDENTITY")
    for (const file of sources.files ?? [])
      verifyEvidenceFile(directory, {
        kind: "reference-source",
        relativePath: file.path,
        sha256: file.sha256,
        bytes: file.size,
      })
    records.push({
      taskID: task.taskID,
      oracleSha256: item.oracleSha256,
      oracleFormat: item.oracleFormat,
      cases: oracle.cases.length,
      interactionAssertions: oracle.interactionAssertions?.length ?? 0,
      controls: authored.controls.length,
      controlTrees: authored.controls.map((c) => ({ kind: c.kind, treeSha256: c.treeSha256 })),
      canarySha256: authored.canary.sha256,
      strictBundleSha256,
    })
  }
  return freeze({
    schemaVersion: 2,
    taskCount: records.length,
    caseCount: records.reduce((n, t) => n + t.cases, 0),
    controlCount: records.reduce((n, t) => n + t.controls, 0),
    interactionAssertionCount: records.reduce((n, t) => n + t.interactionAssertions, 0),
    strictBundleCount: records.filter((r) => r.strictBundleSha256 !== null).length,
    sourceSha256: report.sourceSha256,
    authoringSha256: sha256Text(canonicalJson(records)),
    engineVerified: false,
    corpusEngineReady: false,
    records,
  })
}
