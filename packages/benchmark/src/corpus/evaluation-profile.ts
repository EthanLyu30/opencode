import { Schema } from "effect"
import { ArmID, CampaignID, GitRevision, PositiveInt, Sha256, TaskID } from "../schema"
import { canonicalJson } from "../campaign/canonical"
import { FileEntry, assertSafeRelativePath } from "./manifest"

const exact = { onExcessProperty: "error" as const }
const Text = Schema.NonEmptyString
const Strings = Schema.Array(Text)
const Kind = Schema.Literals(["primary", "guardrail"])
const Assertion = Schema.Struct({ id: Text, mandatory: Schema.Boolean, weight: Schema.Finite })
const Operation = Schema.Struct({
  kind: Schema.Literals(["call", "method", "get"]),
  target: Text,
  args: Schema.Array(Schema.Unknown),
})
const Expected = Schema.Union([
  Schema.Struct({ comparator: Schema.Literals(["equal", "deep-equal"]), value: Schema.Unknown }),
  Schema.Struct({ comparator: Schema.Literal("throws"), message: Schema.String }),
  Schema.Struct({
    comparator: Schema.Literal("number"),
    value: Schema.Finite,
    tolerance: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
])
export const CheckCommand = Schema.Struct({
  id: Schema.Literals(["test", "build", "typecheck", "lint"]),
  cwd: Text,
  argv: Schema.NonEmptyArray(Text),
  timeoutMs: PositiveInt.check(Schema.isLessThanOrEqualTo(300000)),
  required: Schema.Boolean,
})
export const DependencyRequirement = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("locked"),
    sourceCommit: GitRevision,
    lockfiles: Schema.NonEmptyArray(FileEntry),
    recipeSha256: Sha256,
    requiredCapabilities: Strings,
  }),
])
export const DependencyResolution = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({
    kind: Schema.Literal("resolved"),
    recipeSha256: Sha256,
    lockfiles: Schema.NonEmptyArray(FileEntry),
    image: Text.check(Schema.isPattern(/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/)),
    platform: Text,
    receiptSha256: Sha256,
  }),
])
export const PreviewProfile = Schema.Struct({
  entry: Text,
  kind: Schema.Literals(["html", "canvas", "pdf"]),
  requiredCapabilities: Strings,
  interaction: Schema.Literals(["none", "primary-click", "menu-toggle"]),
  timeoutMs: PositiveInt.check(Schema.isLessThanOrEqualTo(30000)),
})
const Profile = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  taskID: TaskID,
  kind: Kind,
  stratum: Schema.Literals(["private", "design2code", "swebench-multimodal", "guardrail"]),
  executionKind: Schema.Literals(["visual-build", "coding-build"]),
  seedSha256: Sha256,
  publicFixtureSha256: Sha256,
  publicInputs: Schema.NonEmptyArray(
    Schema.Struct({
      ...FileEntry.fields,
      purpose: Schema.Literals(["starter", "fixture", "reference"]),
      origin: Schema.Literal("task-public"),
    }),
  ),
  sourceEntry: Text,
  probeModules: Strings,
  protectedPaths: Strings,
  mutablePaths: Strings,
  checks: Schema.Array(CheckCommand),
  dependency: DependencyRequirement,
  preview: Schema.NullOr(PreviewProfile),
})
const Oracle = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  taskID: TaskID,
  kind: Kind,
  privateFiles: Schema.Array(FileEntry),
  cases: Schema.NonEmptyArray(
    Schema.Struct({
      ...Assertion.fields,
      module: Text,
      operations: Schema.NonEmptyArray(Operation),
      expected: Schema.NonEmptyArray(Expected),
    }),
  ),
  requirements: Schema.Array(Assertion),
  quality: Strings,
  policy: Strings,
  visual: Schema.NullOr(
    Schema.Struct({
      references: Schema.Struct({ mobile: FileEntry, tablet: FileEntry, desktop: FileEntry }),
      domReferences: Schema.Struct({ mobile: FileEntry, tablet: FileEntry, desktop: FileEntry }),
      masks: Schema.Array(
        Schema.Struct({ x: Schema.Finite, y: Schema.Finite, width: Schema.Finite, height: Schema.Finite }),
      ),
      tolerance: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      browserSha256: Sha256,
      fontSha256: Sha256,
    }),
  ),
  calibration: Schema.Array(
    Schema.Struct({
      id: Text,
      kind: Schema.Literals([
        "correct",
        "alternate-correct",
        "seed",
        "functional-bad",
        "visual-bad",
        "responsive-bad",
        "policy-bad",
      ]),
      path: Text,
    }),
  ),
  note: Schema.String,
})
export const EvaluationIdentityV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  campaignID: CampaignID,
  runID: CampaignID,
  attemptID: CampaignID,
  leaseGeneration: PositiveInt,
  taskID: TaskID,
  armID: ArmID,
  repeat: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  campaignSha256: Sha256,
  binarySha256: Sha256,
  routeSha256: Sha256,
  profileSha256: Sha256,
  oracleSha256: Sha256,
  seedSha256: Sha256,
  candidateSha256: Sha256,
  evaluatorSha256: Sha256,
})
export type TaskExecutionProfile = typeof Profile.Type
export type EvaluationOracle = typeof Oracle.Type
export type EvaluationIdentityV2 = typeof EvaluationIdentityV2.Type
export type CheckCommand = typeof CheckCommand.Type
export type DependencyResolution = typeof DependencyResolution.Type
export type ProbeOperation = typeof Operation.Type

export function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export function safePath(value: string): string {
  assertSafeRelativePath(value)
  if (
    value
      .split("/")
      .some(
        (part) => /[. ]$|[\x00-\x1f<>"|?*]/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
      )
  )
    throw new TypeError("TASK24_PATH_UNSAFE")
  return value
}
function unique(values: readonly string[]) {
  if (new Set(values.map((v) => v.toLowerCase())).size !== values.length) throw new TypeError("TASK24_DUPLICATE")
}
export function decodeTaskExecutionProfile(input: unknown): TaskExecutionProfile {
  canonicalJson(input)
  const p = Schema.decodeUnknownSync(Profile)(input, exact)
  if (
    (p.kind === "guardrail") !== (p.executionKind === "coding-build") ||
    (p.kind === "guardrail") !== (p.stratum === "guardrail") ||
    (p.kind === "guardrail") !== (p.preview === null)
  )
    throw new TypeError("TASK24_KIND_MISMATCH")
  for (const value of [
    p.sourceEntry,
    ...p.probeModules,
    ...p.protectedPaths,
    ...p.mutablePaths,
    ...p.publicInputs.map((v) => v.path),
  ])
    safePath(value)
  for (const file of p.publicInputs)
    if (!file.path.startsWith("public/") || /(?:^|\/)(?:private|gold|oracle|repaired)(?:[/.]|$)/i.test(file.path))
      throw new TypeError("TASK24_PUBLIC_PATH")
  unique(p.publicInputs.map((v) => v.path))
  unique(p.probeModules)
  unique(p.checks.map((v) => v.id))
  for (const c of p.checks) {
    if (c.cwd !== ".") safePath(c.cwd)
    if (c.argv.some((v) => v.includes("\0"))) throw new TypeError("TASK24_ARGV")
  }
  if (p.preview) safePath(p.preview.entry)
  if (p.dependency.kind === "locked") for (const f of p.dependency.lockfiles) safePath(f.path)
  return freeze(p)
}
export function decodeEvaluationOracle(input: unknown): EvaluationOracle {
  canonicalJson(input)
  const o = Schema.decodeUnknownSync(Oracle)(input, exact)
  if ((o.kind === "guardrail") !== (o.visual === null)) throw new TypeError("TASK24_ORACLE_KIND")
  unique(o.cases.map((c) => c.id))
  for (const c of o.cases) {
    safePath(c.module)
    if (c.operations.length !== c.expected.length || c.operations.length > 1000 || c.weight <= 0)
      throw new TypeError("TASK24_CASE")
  }
  for (const f of o.privateFiles) {
    safePath(f.path)
    if (!f.path.startsWith("private/")) throw new TypeError("TASK24_PRIVATE_PATH")
  }
  unique(o.privateFiles.map((v) => v.path))
  if (o.visual)
    for (const f of [...Object.values(o.visual.references), ...Object.values(o.visual.domReferences)])
      if (!o.privateFiles.some((x) => canonicalJson(x) === canonicalJson(f)))
        throw new TypeError("TASK24_REFERENCE_UNDECLARED")
  for (const c of o.calibration) {
    safePath(c.path)
    if (!c.path.startsWith("private/")) throw new TypeError("TASK24_CALIBRATION_PATH")
  }
  return freeze(o)
}
export function decodeEvaluationIdentity(input: unknown): EvaluationIdentityV2 {
  return freeze(Schema.decodeUnknownSync(EvaluationIdentityV2)(input, exact))
}
