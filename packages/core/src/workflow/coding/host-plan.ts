export * as CodingHostPlan from "./host-plan"

import { DesignArtifact } from "@opencode-ai/schema/design-artifact"
import { Location } from "@opencode-ai/schema/location"
import { WorkflowCodingBuild } from "@opencode-ai/schema/workflow-coding-build"
import { NonNegativeInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { WorkflowBusinessArtifact } from "../artifacts/business"
import { WorkflowSecretGuard } from "../secret-guard"

export const KIND = "workflow.coding-host-plan.v1"
export const RESERVED_INPUT_KEY = KIND
const exact = { parseOptions: { onExcessProperty: "error" as const } }
const names = ["package.json", "bunfig.toml", "bun.lock", "bun.lockb", "tsconfig.json"] as const
const MAX_CONFIG_BYTES = 16 * 1024 * 1024
const ConfigFile = Schema.Union([
  Schema.Struct({ state: Schema.Literal("absent"), path: DesignArtifact.SourcePath }).annotate(exact),
  Schema.Struct({
    state: Schema.Literal("present"),
    path: DesignArtifact.SourcePath,
    sha256: DesignArtifact.Sha256,
    size: NonNegativeInt.check(Schema.isLessThanOrEqualTo(MAX_CONFIG_BYTES)),
  }).annotate(exact),
])
const Command = Schema.Union([
  Schema.Struct({
    id: Schema.Literal("test"),
    argv: Schema.NonEmptyArray(Schema.NonEmptyString),
    reporter: Schema.Literal("bun-junit"),
  }).annotate(exact),
  Schema.Struct({
    id: Schema.Literals(["build", "typecheck"]),
    argv: Schema.NonEmptyArray(Schema.NonEmptyString),
  }).annotate(exact),
])
const Content = Schema.Struct({
  kind: Schema.Literal(KIND),
  location: Location.Ref,
  locationSha256: DesignArtifact.Sha256,
  cwd: WorkflowCodingBuild.Checks.fields.cwd,
  checks: WorkflowCodingBuild.Checks,
  configFiles: Schema.NonEmptyArray(ConfigFile),
  configSha256: DesignArtifact.Sha256,
  commands: Schema.NonEmptyArray(Command),
})
const Envelope = Schema.Struct({ ...Content.fields, sha256: DesignArtifact.Sha256 }).annotate({
  identifier: "CodingHostPlan.Plan",
  ...exact,
})
export interface Plan extends Schema.Schema.Type<typeof Envelope> {}

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("CodingHostPlan.Invalid", {
  code: Schema.Literal("coding_configuration_required"),
  message: Schema.String,
}) {}

export function freeze(input: {
  readonly authority: "admission"
  readonly location: Location.Ref
  readonly checks: WorkflowCodingBuild.Checks
}): Plan {
  try {
    if (input.authority !== "admission") throw invalid()
    const location = Schema.decodeUnknownSync(Location.Ref)(input.location)
    const checks = Schema.decodeUnknownSync(WorkflowCodingBuild.Checks)(
      Schema.encodeSync(WorkflowCodingBuild.Checks)(Schema.decodeUnknownSync(WorkflowCodingBuild.Checks)(input.checks)),
    )
    const root = directory(location.directory)
    const cwd = directory(path.join(root, ...checks.cwd.split("/")))
    if (cwd !== root && !comparisonKey(cwd).startsWith(comparisonKey(root) + path.sep)) throw invalid()
    const directories: string[] = []
    for (let cursor = cwd; ; cursor = path.dirname(cursor)) {
      directories.push(cursor)
      if (comparisonKey(cursor) === comparisonKey(root)) break
      if (path.dirname(cursor) === cursor) throw invalid()
    }
    const configFiles = directories
      .flatMap((directory) => names.map((name) => configuration(root, path.join(directory, name))))
      .toSorted((left, right) => left.path.localeCompare(right.path, "en"))
    const packageFile = configFiles.find(
      (file) => file.path === (checks.cwd === "." ? "package.json" : `${checks.cwd}/package.json`),
    )
    const pkg = (() => {
      if (packageFile?.state !== "present") return {}
      const bytes = readFileSync(path.join(cwd, "package.json"))
      if (
        bytes.byteLength !== packageFile.size ||
        new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== packageFile.sha256
      )
        throw invalid()
      return Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(bytes.toString("utf8"))
    })()
    if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) throw invalid()
    WorkflowSecretGuard.assertSafe(pkg)
    const scripts = Reflect.get(pkg, "scripts")
    const script = (name: string) => {
      if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) throw invalid()
      const value: unknown = Reflect.get(scripts, name)
      if (typeof value !== "string" || value.trim().length === 0) throw invalid()
      return value
    }
    const testArgs =
      checks.test === "bun-test"
        ? []
        : (() => {
            if (
              scripts &&
              typeof scripts === "object" &&
              (Object.hasOwn(scripts, "pretest") || Object.hasOwn(scripts, "posttest"))
            )
              throw invalid()
            const tokens = script("test").trim().split(/\s+/)
            if (tokens.shift() !== "bun") throw invalid()
            if (tokens[0] === "--no-env-file") tokens.shift()
            if (tokens.shift() !== "test") throw invalid()
            validateTestArguments(tokens)
            return tokens
          })()
    const optionalCommands = (["build", "typecheck"] as const).flatMap((id) => {
      if (checks[id] === undefined) return []
      script(id)
      return [{ id, argv: ["bun", "--no-env-file", "run", id] }]
    })
    const commands = [
      { id: "test", argv: ["bun", "--no-env-file", "test", ...testArgs], reporter: "bun-junit" },
      ...optionalCommands,
    ]
    const content = {
      kind: KIND,
      location,
      locationSha256: WorkflowBusinessArtifact.locationSha256(location),
      cwd: checks.cwd,
      checks,
      configFiles,
      configSha256: WorkflowBusinessArtifact.hash(configFiles),
      commands,
    }
    return decode({ ...content, sha256: WorkflowBusinessArtifact.hash(content) }, location)
  } catch {
    throw invalid()
  }
}

export function decode(input: unknown, locationInput: Location.Ref): Plan {
  try {
    const plan = Schema.decodeUnknownSync(Envelope)(input)
    const location = Schema.decodeUnknownSync(Location.Ref)(locationInput)
    const { sha256, ...content } = plan
    if (
      WorkflowBusinessArtifact.hash(content) !== sha256 ||
      WorkflowBusinessArtifact.hash(plan.location) !== WorkflowBusinessArtifact.hash(location) ||
      plan.locationSha256 !== WorkflowBusinessArtifact.locationSha256(location) ||
      plan.configSha256 !== WorkflowBusinessArtifact.hash(plan.configFiles) ||
      plan.cwd !== plan.checks.cwd
    )
      throw invalid()
    const expectedIDs = [
      "test",
      ...(plan.checks.build ? ["build"] : []),
      ...(plan.checks.typecheck ? ["typecheck"] : []),
    ]
    if (plan.commands.length !== expectedIDs.length) throw invalid()
    for (const [index, command] of plan.commands.entries()) {
      if (command.id !== expectedIDs[index]) throw invalid()
      if (command.id === "test") {
        if (command.argv[0] !== "bun" || command.argv[1] !== "--no-env-file" || command.argv[2] !== "test")
          throw invalid()
        validateTestArguments(command.argv.slice(3))
        if (plan.checks.test === "bun-test" && command.argv.length !== 3) throw invalid()
      } else if (
        WorkflowBusinessArtifact.encode(command.argv) !==
        WorkflowBusinessArtifact.encode(["bun", "--no-env-file", "run", command.id])
      )
        throw invalid()
    }
    WorkflowSecretGuard.assertSafe(plan)
    Object.freeze(plan.location)
    Object.freeze(plan.checks)
    plan.configFiles.forEach(Object.freeze)
    Object.freeze(plan.configFiles)
    plan.commands.forEach((command) => {
      Object.freeze(command.argv)
      Object.freeze(command)
    })
    Object.freeze(plan.commands)
    return Object.freeze(plan)
  } catch {
    throw invalid()
  }
}

export function verifyCurrentConfiguration(plan: Plan): void {
  const value = decode(plan, plan.location)
  const current = freeze({ authority: "admission", location: value.location, checks: value.checks })
  if (current.sha256 !== value.sha256) throw invalid()
}

/** Entries must come from an already validated, byte-sealed Snapshot archive. */
export function verifySealedConfiguration(
  plan: Plan,
  entries: readonly { readonly path: string; readonly sha256: string; readonly size: number }[],
): void {
  const value = decode(plan, plan.location)
  for (const file of value.configFiles) {
    const matches = entries.filter((entry) => entry.path === file.path)
    if (file.state === "absent") {
      if (matches.length !== 0) throw invalid()
      continue
    }
    if (matches.length !== 1 || matches[0]!.sha256 !== file.sha256 || matches[0]!.size !== file.size) throw invalid()
  }
}

function directory(input: string): string {
  const absolute = path.resolve(input)
  if (comparisonKey(realpathSync.native(absolute)) !== comparisonKey(absolute)) throw invalid()
  for (let cursor = absolute; ; cursor = path.dirname(cursor)) {
    const stat = lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid()
    if (path.dirname(cursor) === cursor) break
  }
  return absolute
}

function configuration(root: string, file: string): typeof ConfigFile.Type {
  const relative = DesignArtifact.SourcePath.make(path.relative(root, file).replaceAll(path.sep, "/"))
  try {
    const stat = lstatSync(file)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > MAX_CONFIG_BYTES ||
      comparisonKey(realpathSync.native(file)) !== comparisonKey(file)
    )
      throw invalid()
    const bytes = readFileSync(file)
    if (bytes.byteLength !== stat.size) throw invalid()
    return {
      path: relative,
      state: "present",
      size: bytes.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    }
  } catch (cause) {
    if (cause && typeof cause === "object" && Reflect.get(cause, "code") === "ENOENT")
      return { path: relative, state: "absent" }
    throw invalid()
  }
}

function validateTestArguments(tokens: readonly string[]): void {
  if (tokens.length > 64) throw invalid()
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (["--only-failures", "--todo", "--concurrent", "--randomize", "--bail"].includes(token)) continue
    if (["--timeout", "--rerun-each", "--seed", "--max-concurrency"].includes(token)) {
      if (!/^\d{1,9}$/.test(tokens[++index] ?? "")) throw invalid()
      continue
    }
    if (token.startsWith("--")) {
      if (/^--(?:timeout|rerun-each|seed|max-concurrency)=\d{1,9}$/.test(token)) continue
      throw invalid()
    }
    if (token !== "." && !Schema.is(DesignArtifact.SourcePath)(token)) throw invalid()
  }
}

function comparisonKey(value: string): string {
  return path.normalize(value).toLowerCase()
}

function invalid() {
  return new Invalid({
    code: "coding_configuration_required",
    message: "A valid admission-frozen coding check plan is required",
  })
}
