export * as DockerConfig from "./docker-config"

import fs from "node:fs/promises"
import path from "node:path"

const pinnedImagePattern = /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/
const executablePattern = /^[A-Za-z]:\\(?:[^<>:"/\\|?*\u0000-\u001f]+\\)*docker\.exe$/i

export interface Config {
  readonly enginePath: string
  readonly image: string
  readonly dockerConfig: string
  readonly temp: string
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
    limits: defaults,
  }
}

export async function validate(config: Config): Promise<Config> {
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
  const dockerConfig = await canonicalDDirectory(config.dockerConfig)
  const temp = await canonicalDDirectory(config.temp)
  if (overlap(dockerConfig, temp)) throw new TypeError("Docker config and temp roots must be separate")
  return { ...config, dockerConfig, temp }
}

export function invocationEnvironment(config: Config): Readonly<Record<string, string>> {
  return { DOCKER_CONFIG: config.dockerConfig, TEMP: config.temp, TMP: config.temp }
}

async function canonicalDDirectory(value: string): Promise<string> {
  if (!path.win32.isAbsolute(value) || !/^D:\\/i.test(value) || unsafeWindowsPath(value)) {
    throw new TypeError("Docker host roots must be canonical D-drive paths")
  }
  const canonical = await fs.realpath(value)
  if (path.resolve(value) !== canonical || !/^D:\\/i.test(canonical)) {
    throw new TypeError("Docker host root changed identity or spelling")
  }
  const stat = await fs.lstat(canonical)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError("Docker host root must be a real directory")
  return canonical
}

function unsafeWindowsPath(value: string) {
  if (value.includes(",") || value.includes("=") || /[\u0000-\u001f\u007f]/.test(value)) return true
  return value
    .replaceAll("\\", "/")
    .split("/")
    .some((part) => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

function contains(parent: string, child: string) {
  const relative = path.relative(parent, child)
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function overlap(left: string, right: string) {
  return contains(left, right) || contains(right, left)
}

function positiveSafe(value: number) {
  return Number.isSafeInteger(value) && value > 0
}
