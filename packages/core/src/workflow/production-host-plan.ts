export * as WorkflowProductionHostPlan from "./production-host-plan"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { Workflow } from "@opencode-ai/schema/workflow"
import { AbsolutePath, RelativePath } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { WorkflowBusinessArtifact } from "./artifacts/business"
import { PreviewPlan } from "./preview-plan"
import { WorkflowSecretGuard } from "./secret-guard"

export const RESERVED_INPUT_KEY = "workflow.production-host-plan.v1"
export const KIND = "workflow.production-host-plan.v1"
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024
const exact = { parseOptions: { onExcessProperty: "error" as const } }

const FrozenConfigurationFile = Schema.Struct({
  path: RelativePath,
  sha256: DesignArtifact.Sha256,
  size: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_PACKAGE_BYTES)),
}).annotate({ identifier: "WorkflowProductionHostPlan.FrozenConfigurationFile", ...exact })

const FunctionalTest = Schema.Struct({
  argv: Schema.Union([
    Schema.Tuple([Schema.Literal("bun"), Schema.Literal("test")]),
    Schema.Tuple([Schema.Literal("bun"), Schema.Literal("run"), Schema.Literal("test")]),
  ]),
  cwd: RelativePath,
  configFiles: Schema.Array(FrozenConfigurationFile),
  configSha256: DesignArtifact.Sha256,
  policySha256: DesignArtifact.Sha256,
}).annotate({ identifier: "WorkflowProductionHostPlan.FunctionalTest", ...exact })

const Envelope = Schema.Struct({
  kind: Schema.Literal(KIND),
  locationSha256: DesignArtifact.Sha256,
  preview: Schema.Unknown,
  previewConfigSha256: DesignArtifact.Sha256,
  functionalTest: FunctionalTest,
}).annotate({ identifier: "WorkflowProductionHostPlan.Envelope", ...exact })

export interface FunctionalTest {
  readonly argv: readonly ["bun", "test"] | readonly ["bun", "run", "test"]
  readonly cwd: RelativePath
  readonly configFiles: readonly { readonly path: RelativePath; readonly sha256: string; readonly size: number }[]
  readonly configSha256: string
  readonly policySha256: string
}

export interface Plan {
  readonly kind: typeof KIND
  readonly locationSha256: string
  readonly preview: PreviewPlan.PreviewPlan
  readonly previewConfigSha256: string
  readonly functionalTest: FunctionalTest
}

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("WorkflowProductionHostPlan.Invalid", {
  code: Schema.Literal("preview_configuration_required"),
  message: Schema.String,
}) {}

export function freeze(input: {
  readonly authority: "admission"
  readonly location: Location.Ref
  readonly preview: PreviewPlan.PreviewPlan
}): Plan {
  if (input.authority !== "admission" || !PreviewPlan.isFrozen(input.preview)) throw invalid()
  const location = Schema.decodeUnknownSync(Location.Ref)(input.location)
  if (comparisonKey(realpathSync(location.directory)) !== comparisonKey(input.preview.locationRoot)) throw invalid()
  const functionalTest = freezeFunctionalTest(location, input.preview.cwd)
  return validate(
    {
      kind: KIND,
      locationSha256: WorkflowBusinessArtifact.locationSha256(location),
      preview: input.preview,
      previewConfigSha256: input.preview.configSha256,
      functionalTest,
    },
    location,
  )
}

export function decode(input: unknown, locationInput: Location.Ref): Plan {
  return validate(input, Schema.decodeUnknownSync(Location.Ref)(locationInput))
}

export function fromWorkflow(workflow: Workflow.Info): Plan {
  if (workflow.type !== "visual-build" || workflow.location === undefined) throw invalid()
  if (!Object.hasOwn(workflow.input, RESERVED_INPUT_KEY)) throw invalid()
  return decode(workflow.input[RESERVED_INPUT_KEY], workflow.location)
}

export function withPlan(input: Readonly<Record<string, unknown>>, plan: Plan): Readonly<Record<string, unknown>> {
  if (Object.hasOwn(input, RESERVED_INPUT_KEY)) throw invalid()
  return Object.freeze({ ...input, [RESERVED_INPUT_KEY]: plan })
}

export function verifyCurrentConfiguration(plan: Plan): void {
  PreviewPlan.verifyConfiguration(plan.preview)
  const current = freezeFunctionalTest(
    Location.Ref.make({ directory: AbsolutePath.make(plan.preview.locationRoot) }),
    plan.preview.cwd,
  )
  if (WorkflowBusinessArtifact.encode(current) !== WorkflowBusinessArtifact.encode(plan.functionalTest)) throw invalid()
}

function validate(input: unknown, location: Location.Ref): Plan {
  try {
    const envelope = Schema.decodeUnknownSync(Envelope)(input)
    const preview = freezePreview(envelope.preview)
    const configFiles = Object.freeze(envelope.functionalTest.configFiles.map((file) => Object.freeze({ ...file })))
    const argv =
      envelope.functionalTest.argv.length === 2
        ? Object.freeze(["bun", "test"] as const)
        : Object.freeze(["bun", "run", "test"] as const)
    const functionalTest = Object.freeze({ ...envelope.functionalTest, argv, configFiles })
    if (
      envelope.locationSha256 !== WorkflowBusinessArtifact.locationSha256(location) ||
      envelope.previewConfigSha256 !== preview.configSha256 ||
      comparisonKey(realpathSync(location.directory)) !== comparisonKey(preview.locationRoot) ||
      functionalTest.cwd !== relativeWorkdir(location, preview.cwd) ||
      functionalTest.configSha256 !== WorkflowBusinessArtifact.hash(configFiles) ||
      functionalTest.policySha256 !==
        WorkflowBusinessArtifact.hash({
          argv: functionalTest.argv,
          cwd: functionalTest.cwd,
          configSha256: functionalTest.configSha256,
        })
    ) {
      throw invalid()
    }
    const plan = Object.freeze({
      kind: KIND,
      locationSha256: envelope.locationSha256,
      preview,
      previewConfigSha256: envelope.previewConfigSha256,
      functionalTest,
    })
    WorkflowSecretGuard.assertSafe(plan)
    return plan
  } catch (cause) {
    if (cause instanceof Invalid) throw cause
    throw invalid()
  }
}

function freezeFunctionalTest(location: Location.Ref, frozenCwd: string): FunctionalTest {
  const cwd = relativeWorkdir(location, frozenCwd)
  const packageFile = path.join(realpathSync(location.directory), ...cwd.split("/"), "package.json")
  const packagePath = RelativePath.make(cwd === "." ? "package.json" : `${cwd}/package.json`)
  const configFiles = (() => {
    try {
      const stat = lstatSync(packageFile)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > MAX_PACKAGE_BYTES ||
        realpathSync(packageFile) !== packageFile
      )
        throw invalid()
      const bytes = readFileSync(packageFile)
      if (bytes.byteLength !== stat.size) throw invalid()
      return Object.freeze([
        Object.freeze({
          path: packagePath,
          sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
        }),
      ])
    } catch (cause) {
      if (cause instanceof Invalid) throw cause
      const code = cause !== null && typeof cause === "object" ? Reflect.get(cause, "code") : undefined
      if (code === "ENOENT") return Object.freeze([])
      throw invalid()
    }
  })()
  const scripted = (() => {
    if (configFiles.length === 0) return false
    try {
      const parsed: unknown = JSON.parse(readFileSync(packageFile, "utf8"))
      WorkflowSecretGuard.assertSafe(parsed)
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid()
      const scripts = Reflect.get(parsed, "scripts")
      if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) return false
      const test = Reflect.get(scripts, "test")
      return typeof test === "string" && test.trim().length > 0
    } catch (cause) {
      if (cause instanceof Invalid) throw cause
      throw invalid()
    }
  })()
  const argv = Object.freeze(scripted ? (["bun", "run", "test"] as const) : (["bun", "test"] as const))
  const configSha256 = WorkflowBusinessArtifact.hash(configFiles)
  return Object.freeze({
    argv,
    cwd,
    configFiles,
    configSha256,
    policySha256: WorkflowBusinessArtifact.hash({ argv, cwd, configSha256 }),
  })
}

function relativeWorkdir(location: Location.Ref, frozenCwd: string): RelativePath {
  const root = realpathSync.native(location.directory)
  const cwd = realpathSync.native(frozenCwd)
  if (!lstatSync(root).isDirectory() || !lstatSync(cwd).isDirectory()) throw invalid()
  if (comparisonKey(path.parse(root).root) !== comparisonKey(path.parse(cwd).root)) throw invalid()
  const relative = path.relative(root, cwd)
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || relative.includes(":"))
    throw invalid()
  return RelativePath.make(relative === "" ? "." : relative.replaceAll(path.sep, "/"))
}

function freezePreview(input: unknown): PreviewPlan.PreviewPlan {
  const preview = freezeUnknown(input)
  if (!PreviewPlan.isFrozen(preview)) throw invalid()
  return preview
}

function freezeUnknown(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input
  if (Array.isArray(input)) return Object.freeze(input.map(freezeUnknown))
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) throw invalid()
  const keys = Reflect.ownKeys(input)
  if (keys.some((key) => typeof key !== "string")) throw invalid()
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    if (typeof key !== "string") throw invalid()
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined
    )
      throw invalid()
    result[key] = freezeUnknown(descriptor.value)
  }
  return Object.freeze(result)
}

function comparisonKey(value: string): string {
  return path.normalize(value).toLowerCase()
}

function invalid() {
  return new Invalid({
    code: "preview_configuration_required",
    message: "A valid admission-frozen production host plan is required",
  })
}
