export * as DockerConfig from "./docker-config"

import fs from "node:fs/promises"
import path from "node:path"
import type { ProductionHostRoots } from "./production-host-roots"

const pinnedImagePattern = /^(?:[a-z0-9][a-z0-9._/-]*|127\.0\.0\.1:5000\/[a-z0-9][a-z0-9._/-]*)@sha256:[a-f0-9]{64}$/
const executablePattern = /^[A-Za-z]:\\(?:[^<>:"/\\|?*\u0000-\u001f]+\\)*docker\.exe$/i

export interface Config {
  readonly enginePath: string
  readonly image: string
  readonly dockerConfig: string
  readonly temp: string
  /** Host-owned roots which may never overlap an admitted workflow Location. */
  readonly protectedRoots?: readonly string[]
  /** Exact workflow-owned leaves which must not overlap Docker engine/config/temp. */
  readonly isolationRoots?: readonly string[]
  /** Umbrella roots excluded only from workflow Location admission. */
  readonly locationExcludedRoots?: readonly string[]
  /** Revalidates ACL and filesystem identity at each Docker operation boundary. */
  readonly verifyHostRoots?: () => void
  /** Minted only by validate(); callers must pass the validated record to Docker execution helpers. */
  readonly engineIdentity?: EngineIdentity
  /** Minted only by validate(); binds every configured directory to its original filesystem identity. */
  readonly directoryIdentities?: readonly DirectoryIdentity[]
  readonly limits: {
    readonly timeoutMs: number
    readonly engineTimeoutMs: number
    readonly cleanupTimeoutMs: number
    readonly maxOutputBytes: number
    readonly memoryBytes: number
    readonly cpus: number
    readonly pids: 64
  }
}

export interface EngineIdentity {
  readonly canonical: string
  readonly device: string
  readonly inode: string
  readonly birthtimeMs: string
}

export interface DirectoryIdentity {
  readonly canonical: string
  readonly device: string
  readonly inode: string
  readonly birthtimeMs: string
}

export type ValidatedConfig = Config & {
  readonly protectedRoots: readonly string[]
  readonly isolationRoots: readonly string[]
  readonly locationExcludedRoots: readonly string[]
  readonly engineIdentity: EngineIdentity
  readonly directoryIdentities: readonly DirectoryIdentity[]
}

export const defaults: Config["limits"] = Object.freeze({
  timeoutMs: 10 * 60 * 1_000,
  engineTimeoutMs: 15_000,
  cleanupTimeoutMs: 5_000,
  maxOutputBytes: 1024 * 1024,
  memoryBytes: 1024 * 1024 * 1024,
  cpus: 1.5,
  pids: 64,
})

/** One environment contract shared by command and preview Docker adapters. */
export function fromEnvironment(environment: Readonly<Record<string, string | undefined>>): Config {
  return {
    enginePath: environment.OPENCODE_WORKFLOW_SANDBOX_ENGINE ?? "",
    image: environment.OPENCODE_WORKFLOW_SANDBOX_IMAGE ?? "",
    dockerConfig: environment.OPENCODE_WORKFLOW_SANDBOX_CONFIG ?? "",
    temp: environment.OPENCODE_WORKFLOW_SANDBOX_TEMP ?? "",
    isolationRoots: [
      environment.OPENCODE_WORKFLOW_HOST_DATA ?? "",
      environment.OPENCODE_WORKFLOW_EVIDENCE_ROOT ?? "",
      environment.OPENCODE_WORKFLOW_HOST_RUNTIME ?? "",
      environment.PLAYWRIGHT_BROWSERS_PATH ?? "",
      environment.OPENCODE_WORKFLOW_HOST_CACHE ?? "",
      environment.OPENCODE_WORKFLOW_HOST_TEMP ?? "",
    ],
    locationExcludedRoots: [environment.OPENCODE_WORKFLOW_HOST_ROOT ?? ""],
    limits: defaults,
  }
}

export function fromProductionHostRoots(contract: ProductionHostRoots.Contract): Config {
  return {
    enginePath: contract.sandbox.enginePath,
    image: contract.sandbox.image,
    dockerConfig: contract.roots.dockerConfigRoot,
    temp: contract.roots.dockerTempRoot,
    isolationRoots: [
      contract.roots.dataRoot,
      contract.roots.browserRuntimeRoot,
      contract.roots.browserCacheRoot,
      contract.roots.previewCapabilityRoot,
    ],
    locationExcludedRoots: [contract.roots.deploymentRoot],
    verifyHostRoots: contract.policy.verifyAll,
    limits: defaults,
  }
}

export async function validate(config: Config): Promise<ValidatedConfig> {
  config.verifyHostRoots?.()
  if (
    !pinnedImagePattern.test(config.image) ||
    !path.win32.isAbsolute(config.enginePath) ||
    !/^D:\\/i.test(config.enginePath) ||
    !executablePattern.test(config.enginePath)
  ) {
    throw new TypeError("Docker engine and image must be absolute and digest pinned")
  }
  if (
    !positiveSafe(config.limits.timeoutMs) ||
    !positiveSafe(config.limits.engineTimeoutMs) ||
    !positiveSafe(config.limits.cleanupTimeoutMs) ||
    !positiveSafe(config.limits.maxOutputBytes) ||
    !positiveSafe(config.limits.memoryBytes) ||
    !Number.isFinite(config.limits.cpus) ||
    config.limits.cpus <= 0 ||
    config.limits.pids !== 64
  ) {
    throw new TypeError("Docker resource limits are invalid")
  }
  const engineIdentity = await engineFileIdentity(config.enginePath)
  if (config.engineIdentity !== undefined && !sameEngineIdentity(config.engineIdentity, engineIdentity)) {
    throw new TypeError("Docker engine file identity changed")
  }
  const dockerConfigIdentity = await directoryIdentity(config.dockerConfig)
  const tempIdentity = await directoryIdentity(config.temp)
  const dockerConfig = dockerConfigIdentity.canonical
  const temp = tempIdentity.canonical
  if (overlap(dockerConfig, temp)) throw new TypeError("Docker config and temp roots must be separate")
  if (overlap(engineIdentity.canonical, dockerConfig) || overlap(engineIdentity.canonical, temp)) {
    throw new TypeError("Docker engine, config, and temp must be isolated")
  }
  const protectedRoots = await canonicalDirectoryList(config.protectedRoots ?? [])
  const isolationRoots = await canonicalDirectoryList([...(config.isolationRoots ?? []), ...protectedRoots])
  const locationExcludedRoots = await canonicalDirectoryList([
    ...(config.locationExcludedRoots ?? []),
    ...protectedRoots,
  ])
  for (const protectedRoot of isolationRoots) {
    if (
      overlap(dockerConfig, protectedRoot) ||
      overlap(temp, protectedRoot) ||
      overlap(engineIdentity.canonical, protectedRoot)
    ) {
      throw new TypeError("Docker and workflow protected roots must be isolated")
    }
  }
  const directoryIdentities = Object.freeze(
    await identitiesFor([dockerConfig, temp, ...isolationRoots, ...locationExcludedRoots]),
  )
  if (
    config.directoryIdentities !== undefined &&
    !sameDirectoryIdentities(config.directoryIdentities, directoryIdentities)
  ) {
    throw new TypeError("Docker host directory identity changed")
  }
  return Object.freeze({
    ...config,
    enginePath: engineIdentity.canonical,
    dockerConfig,
    temp,
    protectedRoots: Object.freeze(protectedRoots),
    isolationRoots: Object.freeze(isolationRoots),
    locationExcludedRoots: Object.freeze(locationExcludedRoots),
    engineIdentity,
    directoryIdentities,
  })
}

export async function revalidate(config: Config): Promise<ValidatedConfig> {
  if (
    config.engineIdentity === undefined ||
    config.protectedRoots === undefined ||
    config.isolationRoots === undefined ||
    config.locationExcludedRoots === undefined ||
    config.directoryIdentities === undefined
  ) {
    throw new TypeError("Docker configuration was not host-validated")
  }
  return validate(config)
}

export async function admitWorkspace(config: ValidatedConfig, workspace: string): Promise<string> {
  const canonical = await canonicalDDirectory(workspace)
  const protectedPaths = [
    config.dockerConfig,
    config.temp,
    config.enginePath,
    ...config.isolationRoots,
    ...config.locationExcludedRoots,
    ...config.protectedRoots,
  ]
  if (protectedPaths.some((protectedPath) => overlap(protectedPath, canonical))) {
    throw new TypeError("Workflow Location overlaps a protected host/runtime path")
  }
  return canonical
}

export function invocationEnvironment(config: Config): Readonly<Record<string, string>> {
  return {
    DOCKER_CONFIG: config.dockerConfig,
    DOCKER_CONTEXT: "default",
    DOCKER_HOST: "",
    DOCKER_TLS_VERIFY: "",
    DOCKER_CERT_PATH: "",
    BUILDX_BUILDER: "",
    BUILDKIT_HOST: "",
    PATH: path.win32.dirname(config.enginePath),
    TEMP: config.temp,
    TMP: config.temp,
  }
}

async function canonicalDDirectory(value: string): Promise<string> {
  if (!path.win32.isAbsolute(value) || !/^D:\\/i.test(value) || unsafeWindowsPath(value)) {
    throw new TypeError("Docker host roots must be canonical D-drive paths")
  }
  const canonical = await fs.realpath(value)
  if (!sameWindowsPath(path.resolve(value), canonical) || !/^D:\\/i.test(canonical)) {
    throw new TypeError("Docker host root changed identity or spelling")
  }
  const stat = await fs.lstat(canonical)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("Docker host root must be a real directory")
  return canonical
}

async function directoryIdentity(value: string): Promise<DirectoryIdentity> {
  const canonical = await canonicalDDirectory(value)
  const stat = await fs.lstat(canonical, { bigint: true })
  return Object.freeze({
    canonical,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    birthtimeMs: stat.birthtimeMs.toString(),
  })
}

async function canonicalDirectoryList(values: readonly string[]): Promise<string[]> {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const canonical = await canonicalDDirectory(value)
    const key = canonical.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(canonical)
  }
  return result
}

async function identitiesFor(values: readonly string[]): Promise<DirectoryIdentity[]> {
  const result: DirectoryIdentity[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const identity = await directoryIdentity(value)
    const key = identity.canonical.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(identity)
  }
  return result
}

function sameDirectoryIdentities(left: readonly DirectoryIdentity[], right: readonly DirectoryIdentity[]): boolean {
  if (left.length !== right.length) return false
  return left.every((identity, index) => {
    const current = right[index]
    return (
      current !== undefined &&
      sameWindowsPath(identity.canonical, current.canonical) &&
      identity.device === current.device &&
      identity.inode === current.inode &&
      identity.birthtimeMs === current.birthtimeMs
    )
  })
}

async function engineFileIdentity(value: string): Promise<EngineIdentity> {
  const lexical = path.resolve(value)
  const canonical = await fs.realpath(lexical)
  const stat = await fs.lstat(lexical, { bigint: true })
  if (
    !sameWindowsPath(lexical, canonical) ||
    !/^D:\\/i.test(canonical) ||
    path.win32.basename(canonical).toLowerCase() !== "docker.exe" ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n
  ) {
    throw new TypeError("Docker engine must be one fixed ordinary D-drive docker.exe")
  }
  return Object.freeze({
    canonical,
    device: String(stat.dev),
    inode: String(stat.ino),
    birthtimeMs: String(stat.birthtimeMs),
  })
}

function sameEngineIdentity(left: EngineIdentity, right: EngineIdentity) {
  return (
    sameWindowsPath(left.canonical, right.canonical) &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeMs === right.birthtimeMs
  )
}

function unsafeWindowsPath(value: string) {
  if (value.includes(",") || value.includes("=") || /[\u0000-\u001f\u007f]/.test(value)) return true
  return value
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

function contains(parent: string, child: string) {
  const relative = path.win32.relative(parent, child)
  return (
    relative === "" ||
    (!path.win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.win32.sep}`))
  )
}

function overlap(left: string, right: string) {
  return contains(left, right) || contains(right, left)
}

function positiveSafe(value: number) {
  return Number.isSafeInteger(value) && value > 0
}

function sameWindowsPath(left: string, right: string) {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase()
}
