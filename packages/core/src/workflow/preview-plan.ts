export * as PreviewPlan from "./preview-plan"

import { Location } from "@opencode-ai/schema/location"
import { WorkflowVisualBuild } from "@opencode-ai/schema/workflow-visual-build"
import { Schema } from "effect"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { WorkflowSecretGuard } from "./secret-guard"

const MAX_CONFIGURATION_FILE_BYTES = 16 * 1024 * 1024
const MAX_CONFIGURATION_BYTES = 64 * 1024 * 1024

const relevantConfigurationNames = Object.freeze([
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  ".npmrc",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml",
  ".pnpmfile.cjs",
  "yarn.lock",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
])
const relevantConfigurationKeys = new Set(relevantConfigurationNames.map((name) => name.toLowerCase()))
const frozenConfigurationKeys = new Set(["path", "sha256", "size"])

const unsafeEnvironmentName = /(?:^|_)(?:AUTH|COOKIE|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)(?:_|$)/i
const hostAuthorityEnvironmentNames = new Set([
  "ALL_PROXY",
  "BUN_OPTIONS",
  "COMSPEC",
  "DYLD_INSERT_LIBRARIES",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "PORT",
  "SHELL",
])
const allowedExecutables = new Set(["bun", "bun.exe", "node", "node.exe"])
const bunExecutables = new Set(["bun", "bun.exe"])
const nodeExecutables = new Set(["node", "node.exe"])
const shellExecutables = new Set([
  "bash",
  "bash.exe",
  "cmd",
  "cmd.exe",
  "command.com",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "sh.exe",
  "zsh",
  "zsh.exe",
])

export interface FrozenConfigurationFile {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

export interface PreviewPlan {
  readonly kind: "static" | "script"
  readonly entrypoint?: string
  readonly argv?: readonly string[]
  /** Canonical identity of the admitted Location, included in configSha256. */
  readonly locationRoot: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly allowedOrigins: readonly string[]
  readonly configFiles: readonly FrozenConfigurationFile[]
  readonly configSha256: string
}

export interface FreezeInput {
  /** Only the Location-aware admission boundary may freeze executable policy. */
  readonly authority: "admission"
  readonly location: Location.Ref
  readonly preview?: WorkflowVisualBuild.TrustedPreviewInput
  /** Host-supplied environment snapshot. Core never reads process.env. */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /** Exact names which may be copied into the child environment. */
  readonly envAllowlist?: readonly string[]
  /** Host-configured local dependencies; never part of the public payload. */
  readonly allowedOrigins?: readonly string[]
}

export class PreviewConfigurationRequired extends Schema.TaggedErrorClass<PreviewConfigurationRequired>()(
  "WorkflowPreviewPlan.PreviewConfigurationRequired",
  {
    code: Schema.Literal("preview_configuration_required"),
    message: Schema.String,
  },
) {}

export class Invalid extends Schema.TaggedErrorClass<Invalid>()("WorkflowPreviewPlan.Invalid", {
  code: Schema.Literals([
    "model_authored_preview_rejected",
    "invalid_preview_configuration",
    "preview_path_outside_location",
    "unsafe_preview_environment",
    "unsafe_preview_origin",
    "preview_configuration_changed",
  ]),
  message: Schema.String,
}) {}

/**
 * Freeze one immutable preview policy at Location-aware admission. This API is
 * intentionally synchronous: no process is started and no ambient environment
 * is consulted while the durable request hash is being derived.
 */
export function freeze(input: FreezeInput): PreviewPlan {
  assertAdmissionAuthority(input)
  const preview = decodeTrustedPreview(input.preview)
  const root = canonicalDirectory(input.location.directory, "Location")
  const cwd = resolveDirectory(root, preview?.cwd ?? ".")
  const allowedOrigins = freezeArray((input.allowedOrigins ?? []).map(normalizeLocalOrigin).toSorted())
  const env = freezeEnvironment(preview?.kind === "script" ? preview.env : undefined, input)

  if (preview?.kind === "static") {
    const entrypoint = resolveFile(root, cwd, preview.entrypoint)
    return makePlan({ kind: "static", locationRoot: root, cwd, entrypoint, env, allowedOrigins, configFiles: [] })
  }

  if (preview?.kind === "script") {
    const argv = freezeArgv(preview.argv)
    const configDirectory = scriptConfigurationDirectory(argv, root, cwd)
    const configFiles = configurationFiles(root, configDirectory)
    validateScriptInvocation(argv, root, configFiles)
    return makePlan({ kind: "script", locationRoot: root, cwd, argv, env, allowedOrigins, configFiles })
  }

  const recognized = recognizeProject(root)
  if (recognized !== undefined) {
    return makePlan({
      kind: "script",
      locationRoot: root,
      cwd: root,
      argv: recognized.argv,
      env,
      allowedOrigins,
      configFiles: recognized.configFiles,
    })
  }

  const staticEntrypoint = tryResolveStatic(root)
  if (staticEntrypoint !== undefined) {
    return makePlan({
      kind: "static",
      locationRoot: root,
      cwd: root,
      entrypoint: staticEntrypoint,
      env,
      allowedOrigins,
      configFiles: [],
    })
  }

  throw new PreviewConfigurationRequired({
    code: "preview_configuration_required",
    message: "The admitted project has no trusted static entrypoint or recognized preview script",
  })
}

/** Re-hash every command-bearing project file before a script plan is used. */
export function verifyConfiguration(plan: PreviewPlan): void {
  try {
    if (!isFrozen(plan)) changed()
    const identity = verifyDirectoryIdentity(plan)
    if (plan.kind === "script") {
      if (plan.argv === undefined) changed()
      const configDirectory = scriptConfigurationDirectory(plan.argv, identity.locationRoot, identity.cwd)
      const current = configurationFiles(identity.locationRoot, configDirectory)
      if (!sameConfiguration(current, plan.configFiles)) changed()
      validateScriptInvocation(plan.argv, identity.locationRoot, current)
    } else {
      verifyStaticIdentity(plan, identity.cwd)
      for (const file of plan.configFiles) {
        const current = hashConfigurationFile(plan.locationRoot, file.path)
        if (!sameConfiguration([current], [file])) changed()
      }
    }
    const recomputed = configHash({
      kind: plan.kind,
      locationRoot: plan.locationRoot,
      cwd: plan.cwd,
      entrypoint: plan.entrypoint,
      argv: plan.argv,
      env: plan.env,
      allowedOrigins: plan.allowedOrigins,
      configFiles: plan.configFiles,
    })
    if (recomputed !== plan.configSha256) changed()
  } catch (error) {
    if (error instanceof Invalid && error.code === "preview_configuration_changed") throw error
    changed()
  }
}

/** Runtime guard used by every host adapter before trusting plan fields. */
export function isFrozen(value: unknown): value is PreviewPlan {
  if (value === null || typeof value !== "object" || !Object.isFrozen(value)) return false
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, "kind")
  if (kindDescriptor === undefined || !Object.hasOwn(kindDescriptor, "value")) return false
  const expectedKeys = new Set(
    kindDescriptor.value === "static"
      ? ["kind", "locationRoot", "cwd", "entrypoint", "env", "allowedOrigins", "configFiles", "configSha256"]
      : ["kind", "locationRoot", "cwd", "argv", "env", "allowedOrigins", "configFiles", "configSha256"],
  )
  if (!hasExactPlainProperties(value, expectedKeys)) return false
  const plan = value as Partial<PreviewPlan>
  if (
    (plan.kind !== "static" && plan.kind !== "script") ||
    typeof plan.locationRoot !== "string" ||
    typeof plan.cwd !== "string" ||
    typeof plan.configSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(plan.configSha256) ||
    plan.env === null ||
    typeof plan.env !== "object" ||
    !Object.isFrozen(plan.env) ||
    !hasExactPlainProperties(plan.env) ||
    !Array.isArray(plan.allowedOrigins) ||
    !isExactFrozenArray(plan.allowedOrigins) ||
    !Array.isArray(plan.configFiles) ||
    !isExactFrozenArray(plan.configFiles) ||
    !plan.configFiles.every(
      (file) =>
        file !== null &&
        typeof file === "object" &&
        Object.isFrozen(file) &&
        hasExactPlainProperties(file, frozenConfigurationKeys) &&
        typeof file.path === "string" &&
        typeof file.sha256 === "string" &&
        typeof file.size === "number",
    )
  ) {
    return false
  }
  try {
    const envAliases = new Set<string>()
    for (const [name, item] of Object.entries(plan.env)) {
      validateEnvironmentName(name)
      validateEnvironmentValue(item)
      const key = name.toUpperCase()
      if (envAliases.has(key)) return false
      envAliases.add(key)
    }
    WorkflowSecretGuard.assertSafe(plan.env)
    if (plan.allowedOrigins.some((origin) => typeof origin !== "string" || normalizeLocalOrigin(origin) !== origin)) {
      return false
    }
    if (
      plan.configFiles.some(
        (file) =>
          !isConfigurationPath(file.path) ||
          !/^[a-f0-9]{64}$/.test(file.sha256) ||
          !Number.isSafeInteger(file.size) ||
          file.size < 0 ||
          file.size > MAX_CONFIGURATION_FILE_BYTES,
      )
    ) {
      return false
    }
    if (plan.kind === "static") {
      return typeof plan.entrypoint === "string" && plan.argv === undefined && plan.configFiles.length === 0
    }
    return (
      plan.entrypoint === undefined &&
      Array.isArray(plan.argv) &&
      isExactFrozenArray(plan.argv) &&
      plan.argv.length > 0 &&
      freezeArgv(plan.argv).every((argument, index) => argument === plan.argv?.[index])
    )
  } catch {
    return false
  }
}

export function normalizeLocalOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalid("unsafe_preview_origin", "Preview origin is not an absolute local HTTP origin")
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    url.port === "0" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw invalid("unsafe_preview_origin", "Preview origin must be an authority-free 127.0.0.1 HTTP origin")
  }
  return url.origin
}

function makePlan(input: Omit<PreviewPlan, "configSha256">): PreviewPlan {
  const configFiles = freezeArray(input.configFiles.map((file) => Object.freeze({ ...file })))
  const normalized = {
    kind: input.kind,
    locationRoot: input.locationRoot,
    cwd: input.cwd,
    ...(input.entrypoint === undefined ? {} : { entrypoint: input.entrypoint }),
    ...(input.argv === undefined ? {} : { argv: freezeArray([...input.argv]) }),
    env: Object.freeze({ ...input.env }),
    allowedOrigins: freezeArray([...new Set(input.allowedOrigins)]),
    configFiles,
  }
  return Object.freeze({ ...normalized, configSha256: configHash(normalized) })
}

function decodeTrustedPreview(
  value: WorkflowVisualBuild.TrustedPreviewInput | undefined,
): WorkflowVisualBuild.TrustedPreviewInput | undefined {
  if (value === undefined) return undefined
  try {
    return Schema.decodeUnknownSync(WorkflowVisualBuild.TrustedPreviewInput)(value)
  } catch {
    throw invalid("invalid_preview_configuration", "Trusted preview input is not an exact admission value")
  }
}

function verifyDirectoryIdentity(plan: PreviewPlan): { readonly locationRoot: string; readonly cwd: string } {
  if (!path.isAbsolute(plan.locationRoot) || !path.isAbsolute(plan.cwd)) changed()
  assertNoWindowsDeviceSegments(plan.locationRoot)
  assertNoWindowsDeviceSegments(plan.cwd)
  const locationRoot = realpathSync.native(plan.locationRoot)
  const cwd = realpathSync.native(plan.cwd)
  if (
    locationRoot !== plan.locationRoot ||
    cwd !== plan.cwd ||
    !statSync(locationRoot).isDirectory() ||
    !statSync(cwd).isDirectory()
  ) {
    changed()
  }
  assertContained(locationRoot, cwd)
  return { locationRoot, cwd }
}

function verifyStaticIdentity(plan: PreviewPlan, cwd: string): void {
  if (plan.kind !== "static" || plan.entrypoint === undefined) changed()
  const entrypoint = realpathSync.native(plan.entrypoint)
  if (entrypoint !== plan.entrypoint || !statSync(entrypoint).isFile()) {
    changed()
  }
  assertContained(cwd, entrypoint)
}

function assertAdmissionAuthority(input: FreezeInput): void {
  if (input === null || typeof input !== "object") {
    throw invalid("model_authored_preview_rejected", "Preview plans reject model-authored commands and URLs")
  }
  const value: object = input
  const forbidden = ["command", "url", "previewUrl", "provider", "model"]
  if (input.authority !== "admission" || forbidden.some((key) => Object.hasOwn(value, key))) {
    throw invalid("model_authored_preview_rejected", "Preview plans reject model-authored commands and URLs")
  }
  const allowed = new Set(["authority", "location", "preview", "environment", "envAllowlist", "allowedOrigins"])
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw invalid("invalid_preview_configuration", "Preview freeze input contains unexpected authority")
  }
  if (input.location === undefined || typeof input.location.directory !== "string") {
    throw invalid("invalid_preview_configuration", "Preview admission requires an immutable Location")
  }
}

function recognizeProject(
  root: string,
): { readonly argv: readonly string[]; readonly configFiles: readonly FrozenConfigurationFile[] } | undefined {
  const files = configurationFiles(root, root)
  const packageFile = files.find((file) => file.path === "package.json")
  if (packageFile === undefined) return undefined
  const packageJson = parsePackageJson(configurationAbsolutePath(root, packageFile.path))
  const scripts = record(packageJson.scripts)
  const dependencies = { ...record(packageJson.dependencies), ...record(packageJson.devDependencies) }

  if (typeof dependencies.vite === "string") {
    if (scripts.preview === "vite preview") {
      return { argv: freezeArray(["bun", "run", "--no-env-file", "preview"]), configFiles: files }
    }
    if (scripts.dev === "vite" || scripts.dev === "vite dev") {
      return { argv: freezeArray(["bun", "run", "--no-env-file", "dev"]), configFiles: files }
    }
  }
  if (typeof dependencies.next === "string") {
    if (scripts.dev === "next dev") {
      return { argv: freezeArray(["bun", "run", "--no-env-file", "dev"]), configFiles: files }
    }
    if (scripts.start === "next start") {
      return { argv: freezeArray(["bun", "run", "--no-env-file", "start"]), configFiles: files }
    }
  }
  return undefined
}

function parsePackageJson(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (value === null || Array.isArray(value) || typeof value !== "object") throw new TypeError("not an object")
    return Object.fromEntries(Object.entries(value))
  } catch {
    throw invalid("invalid_preview_configuration", "package.json is not a valid preview configuration")
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && !Array.isArray(value) && typeof value === "object"
    ? Object.fromEntries(Object.entries(value))
    : {}
}

function tryResolveStatic(root: string): string | undefined {
  try {
    return resolveFile(root, root, "index.html")
  } catch (error) {
    if (error instanceof Invalid && error.code === "invalid_preview_configuration") return undefined
    throw error
  }
}

function freezeArgv(argv: readonly string[]): readonly string[] {
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((argument) => typeof argument !== "string" || argument === "" || argument.includes("\0"))
  ) {
    throw invalid("invalid_preview_configuration", "Preview argv must be a non-empty array of direct arguments")
  }
  const executableName = argv[0]
  const executable = executableName.toLowerCase()
  if (
    executableName !== executable ||
    shellExecutables.has(executable) ||
    !allowedExecutables.has(executable) ||
    /[\\/]/.test(executableName)
  ) {
    throw invalid("invalid_preview_configuration", "Preview argv must use an approved direct runtime, never a shell")
  }
  if (directNodeEntrypoint(argv) === undefined) packageRunScript(argv)
  if (
    argv.some((argument) => /^--?(?:api[-_]?key|authorization|credential|password|secret|token)(?:=|$)/i.test(argument))
  ) {
    throw invalid("invalid_preview_configuration", "Preview argv must not carry credentials")
  }
  try {
    WorkflowSecretGuard.assertSafe(argv)
  } catch {
    throw invalid("invalid_preview_configuration", "Preview argv is not safe to persist")
  }
  return freezeArray([...argv])
}

function directNodeEntrypoint(argv: readonly string[]): string | undefined {
  const executable = (argv[0] ?? "").toLowerCase()
  if (!nodeExecutables.has(executable)) return undefined
  if (argv.length !== 2 || typeof argv[1] !== "string" || !/\.(?:js|mjs|cjs)$/.test(argv[1])) {
    throw invalid(
      "invalid_preview_configuration",
      "Direct Node previews require exactly one canonical .js, .mjs, or .cjs entrypoint",
    )
  }
  assertPortableRelativePath(argv[1], false)
  return argv[1]
}

function scriptConfigurationDirectory(argv: readonly string[], locationRoot: string, cwd: string): string {
  const relativeEntrypoint = directNodeEntrypoint(argv)
  if (relativeEntrypoint === undefined) return cwd
  return path.dirname(resolveFile(locationRoot, cwd, relativeEntrypoint))
}

function packageRunScript(argv: readonly string[]): string | undefined {
  const executable = (argv[0] ?? "").toLowerCase()
  if (!bunExecutables.has(executable)) return undefined
  if (
    argv.length !== 4 ||
    argv[1] !== "run" ||
    argv[2] !== "--no-env-file" ||
    typeof argv[3] !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(argv[3])
  ) {
    throw invalid(
      "invalid_preview_configuration",
      "Bun previews require canonical 'bun run --no-env-file <script>' argv",
    )
  }
  return argv[3]
}

function validateScriptInvocation(
  argv: readonly string[],
  locationRoot: string,
  configFiles: readonly FrozenConfigurationFile[],
): void {
  const script = packageRunScript(argv)
  if (script === undefined) return
  const packageFile = [...configFiles].reverse().find((file) => configurationName(file.path) === "package.json")
  if (packageFile === undefined) {
    throw invalid(
      "invalid_preview_configuration",
      "Package-manager preview script has no frozen package.json in Location",
    )
  }
  const packageJson = parsePackageJson(configurationAbsolutePath(locationRoot, packageFile.path))
  const configuredScript = record(packageJson.scripts)[script]
  if (typeof configuredScript !== "string" || configuredScript === "") {
    throw invalid(
      "invalid_preview_configuration",
      "Package-manager preview script is not declared by its nearest package.json",
    )
  }
}

function freezeEnvironment(
  configured: Readonly<Record<string, string>> | undefined,
  input: FreezeInput,
): Readonly<Record<string, string>> {
  const allowlist = input.envAllowlist ?? []
  const allowed = new Map<string, string>()
  for (const name of allowlist) {
    validateEnvironmentName(name)
    const key = name.toUpperCase()
    if (allowed.has(key)) throw invalid("unsafe_preview_environment", "Preview environment contains case aliases")
    allowed.set(key, name)
  }

  const configuredKeys = new Map<string, string>()
  for (const [name, value] of Object.entries(configured ?? {})) {
    validateEnvironmentName(name)
    validateEnvironmentValue(value)
    const key = name.toUpperCase()
    if (configuredKeys.has(key))
      throw invalid("unsafe_preview_environment", "Preview environment contains case aliases")
    configuredKeys.set(key, name)
    if (!allowed.has(key)) {
      throw invalid("unsafe_preview_environment", `Preview environment variable ${name} is not allowlisted`)
    }
  }

  const env: Record<string, string> = {}
  for (const [key, name] of [...allowed.entries()].toSorted(([left], [right]) => left.localeCompare(right))) {
    const configuredName = configuredKeys.get(key)
    const value = configuredName === undefined ? input.environment?.[name] : configured?.[configuredName]
    if (value !== undefined) {
      validateEnvironmentValue(value)
      env[name] = value
    }
  }
  try {
    WorkflowSecretGuard.assertSafe(env)
  } catch {
    throw invalid("unsafe_preview_environment", "Preview environment is not safe to persist")
  }
  return Object.freeze(env)
}

function validateEnvironmentName(name: string): void {
  const upper = name.toUpperCase()
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
    unsafeEnvironmentName.test(name) ||
    hostAuthorityEnvironmentNames.has(upper)
  ) {
    throw invalid("unsafe_preview_environment", `Preview environment variable ${name} is not safe to persist`)
  }
}

function validateEnvironmentValue(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.includes("\0") || /[\r\n]/.test(value)) {
    throw invalid("unsafe_preview_environment", "Preview environment contains an invalid value")
  }
}

function canonicalDirectory(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw invalid("invalid_preview_configuration", `${label} path must be absolute`)
  assertNoWindowsDeviceSegments(value)
  try {
    const canonical = realpathSync.native(value)
    if (!statSync(canonical).isDirectory()) throw new TypeError("not a directory")
    return canonical
  } catch {
    throw invalid("invalid_preview_configuration", `${label} directory is unavailable`)
  }
}

function resolveDirectory(root: string, value: string): string {
  assertPortableRelativePath(value, true)
  assertNoAliases(root, value)
  const candidate = path.resolve(root, value)
  let canonical: string
  try {
    canonical = realpathSync.native(candidate)
    if (!statSync(canonical).isDirectory()) throw new TypeError("not a directory")
  } catch (error) {
    if (error instanceof Invalid) throw error
    throw invalid("invalid_preview_configuration", "Preview working directory is unavailable")
  }
  assertContained(root, canonical)
  return canonical
}

function resolveFile(root: string, cwd: string, value: string): string {
  assertPortableRelativePath(value, false)
  assertNoAliases(cwd, value)
  const candidate = path.resolve(cwd, value)
  let canonical: string
  try {
    canonical = realpathSync.native(candidate)
    if (canonical !== candidate || !statSync(canonical).isFile()) throw new TypeError("not a canonical file")
  } catch (error) {
    if (error instanceof Invalid) throw error
    throw invalid("invalid_preview_configuration", "Preview entrypoint is unavailable")
  }
  assertContained(root, canonical)
  return canonical
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(comparisonKey(root), comparisonKey(target))
  if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)))
    return
  throw invalid("preview_path_outside_location", "Preview path resolves outside the admitted Location")
}

function comparisonKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value
}

function assertPortableRelativePath(value: string, allowDot: boolean): void {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("%") ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalid("invalid_preview_configuration", "Preview path must be a normalized relative POSIX path")
  }
  if (allowDot && value === ".") return
  const segments = value.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw invalid("invalid_preview_configuration", "Preview path must not contain dot or parent segments")
  }
  for (const segment of segments) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9._@+()[\]-]*$/.test(segment) || /[. ]$/.test(segment)) {
      throw invalid("invalid_preview_configuration", "Preview path contains a non-portable segment")
    }
    if (isWindowsDeviceName(segment)) {
      throw invalid("invalid_preview_configuration", "Preview path must not contain a Windows device name")
    }
  }
}

function assertNoWindowsDeviceSegments(value: string): void {
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (segment !== "" && isWindowsDeviceName(segment)) {
      throw invalid("invalid_preview_configuration", "Preview path must not contain a Windows device name")
    }
  }
}

function isWindowsDeviceName(segment: string): boolean {
  const basename = segment.split(".")[0].toUpperCase()
  return /^(?:CON|PRN|AUX|NUL|COM(?:[1-9]|¹|²|³)|LPT(?:[1-9]|¹|²|³))$/.test(basename)
}

function assertNoAliases(root: string, relative: string): void {
  if (relative === ".") return
  let current = root
  for (const segment of relative.split("/")) {
    current = path.join(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw invalid("invalid_preview_configuration", "Preview path must not traverse a directory alias")
      }
    } catch (error) {
      if (error instanceof Invalid) throw error
      return
    }
  }
}

function configurationFiles(locationRoot: string, cwd: string): readonly FrozenConfigurationFile[] {
  let total = 0
  const result: FrozenConfigurationFile[] = []
  for (const directory of configurationDirectories(locationRoot, cwd)) {
    if (realpathSync.native(directory) !== directory || !statSync(directory).isDirectory()) {
      throw invalid("invalid_preview_configuration", "Preview configuration directory identity changed")
    }
    const entries = readdirSync(directory, { withFileTypes: true })
    const aliases = new Map<string, string>()
    for (const entry of entries) {
      const key = entry.name.toLowerCase()
      if (!relevantConfigurationKeys.has(key)) continue
      const previous = aliases.get(key)
      if (previous !== undefined && previous !== entry.name) {
        throw invalid("invalid_preview_configuration", "Preview configuration contains case aliases")
      }
      aliases.set(key, entry.name)
    }
    const relativeDirectory = path.relative(locationRoot, directory).split(path.sep).join("/")
    for (const name of relevantConfigurationNames) {
      const actual = aliases.get(name.toLowerCase())
      if (actual === undefined) continue
      if (actual !== name) {
        throw invalid("invalid_preview_configuration", "Preview configuration filename is not canonical")
      }
      const relative = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`
      const file = hashConfigurationFile(locationRoot, relative)
      total += file.size
      if (total > MAX_CONFIGURATION_BYTES) {
        throw invalid("invalid_preview_configuration", "Preview configuration exceeds the bounded hash input")
      }
      result.push(file)
    }
  }
  return freezeArray(result)
}

function configurationDirectories(locationRoot: string, cwd: string): readonly string[] {
  assertContained(locationRoot, cwd)
  const relative = path.relative(locationRoot, cwd)
  if (relative === "") return [locationRoot]
  const result = [locationRoot]
  let current = locationRoot
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment)
    result.push(current)
  }
  return result
}

function hashConfigurationFile(locationRoot: string, relative: string): FrozenConfigurationFile {
  configurationName(relative)
  assertNoAliases(locationRoot, relative)
  const absolute = configurationAbsolutePath(locationRoot, relative)
  let canonical: string
  try {
    canonical = realpathSync.native(absolute)
    const info = statSync(canonical)
    if (canonical !== absolute || !info.isFile() || info.size > MAX_CONFIGURATION_FILE_BYTES) {
      throw new TypeError("not a canonical bounded file")
    }
  } catch (error) {
    if (error instanceof Invalid) throw error
    throw invalid("invalid_preview_configuration", `Preview configuration ${relative} is unavailable`)
  }
  assertContained(locationRoot, canonical)
  const bytes = readFileSync(canonical)
  return Object.freeze({ path: relative, sha256: sha256(bytes), size: bytes.byteLength })
}

function configurationAbsolutePath(locationRoot: string, relative: string): string {
  configurationName(relative)
  return path.resolve(locationRoot, ...relative.split("/"))
}

function configurationName(relative: string): string {
  if (
    typeof relative !== "string" ||
    relative === "" ||
    relative.includes("\\") ||
    relative.includes(":") ||
    relative.includes("%") ||
    relative !== relative.normalize("NFC") ||
    relative.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(relative)
  ) {
    throw invalid("invalid_preview_configuration", "Preview configuration path is not canonical")
  }
  const segments = relative.split("/")
  const name = segments.pop()
  if (name === undefined || !relevantConfigurationNames.includes(name)) {
    throw invalid("invalid_preview_configuration", "Preview configuration filename is not recognized")
  }
  if (segments.length > 0) assertPortableRelativePath(segments.join("/"), false)
  return name
}

function isConfigurationPath(relative: string): boolean {
  try {
    configurationName(relative)
    return true
  } catch {
    return false
  }
}

function sameConfiguration(
  left: readonly FrozenConfigurationFile[],
  right: readonly FrozenConfigurationFile[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (file, index) =>
        file.path === right[index]?.path && file.sha256 === right[index]?.sha256 && file.size === right[index]?.size,
    )
  )
}

function configHash(input: Omit<PreviewPlan, "configSha256">): string {
  return sha256(Buffer.from(canonical(input), "utf8"))
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value !== "object") throw invalid("invalid_preview_configuration", "Preview plan is not canonical")
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function changed(): never {
  throw invalid("preview_configuration_changed", "Frozen preview configuration changed after admission")
}

function invalid(code: Invalid["code"], message: string): Invalid {
  return new Invalid({ code, message })
}

function freezeArray<const A>(value: readonly A[]): readonly A[] {
  return Object.freeze([...value])
}

function hasExactPlainProperties(value: object, expected?: ReadonlySet<string>): boolean {
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  const keys = Reflect.ownKeys(value)
  if (
    keys.some((key) => typeof key !== "string") ||
    (expected !== undefined &&
      (keys.length !== expected.size || keys.some((key) => typeof key !== "string" || !expected.has(key))))
  ) {
    return false
  }
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value")
  })
}

function isExactFrozenArray(value: readonly unknown[]): boolean {
  if (!Object.isFrozen(value) || Object.getPrototypeOf(value) !== Array.prototype) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1) return false
  const expected = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))])
  return keys.every((key) => {
    if (typeof key !== "string" || !expected.has(key)) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return key === "length" || (descriptor?.enumerable === true && Object.hasOwn(descriptor, "value"))
  })
}
