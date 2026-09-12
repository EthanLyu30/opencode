import fs from "node:fs/promises"
import path from "node:path"
import { Task24Root } from "../root"
import type { ArmMode, RunRoots } from "./types"

const systemEnvironment = ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec"] as const

export function assertRunRoots(roots: RunRoots): RunRoots {
  const layout = Task24Root.ensure()
  const resolvedRun = path.resolve(roots.runRoot)
  const permitted = [layout.workspaces, layout.tmp].some((root) =>
    resolvedRun.startsWith(path.resolve(root) + path.sep),
  )
  if (!permitted || path.parse(resolvedRun).root.toLowerCase() !== "d:\\")
    throw new TypeError("TASK24_RUN_ROOT_INVALID")
  for (const child of ["repo", "data", "config", "cache", "temp", "output"] as const) {
    if (path.resolve(roots[child]) !== path.join(resolvedRun, child)) throw new TypeError("TASK24_RUN_ROOTS_FORGED")
  }
  return Object.freeze({ ...roots })
}

export function buildLaunchEnvironment(input: {
  readonly roots: RunRoots
  readonly mode: ArmMode
  readonly brokerGrant: string
  readonly configFile?: string
  readonly inherited?: Readonly<Record<string, string | undefined>>
}): Readonly<Record<string, string>> {
  const roots = assertRunRoots(input.roots)
  const inherited = input.inherited ?? process.env
  const environment: Record<string, string> = {}
  for (const name of systemEnvironment) {
    const value = inherited[name]
    if (value) environment[name] = value
  }
  Object.assign(environment, {
    XDG_DATA_HOME: roots.data,
    XDG_CONFIG_HOME: roots.config,
    XDG_CACHE_HOME: roots.cache,
    XDG_STATE_HOME: path.join(roots.data, "state"),
    TMP: roots.temp,
    TEMP: roots.temp,
    BUN_INSTALL_CACHE_DIR: path.join(roots.cache, "bun"),
    npm_config_cache: path.join(roots.cache, "npm"),
    OPENCODE_TEST_HOME: path.join(roots.data, "home"),
    OPENCODE_CONFIG_DIR: roots.config,
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PRUNE: "1",
    OPENCODE_PERMISSION: JSON.stringify({ external_directory: "deny" }),
  })
  if (input.configFile) environment.OPENCODE_CONFIG = input.configFile
  if (input.mode === "workflow") {
    environment.MOONSHOT_API_KEY = input.brokerGrant
    environment.DEEPSEEK_API_KEY = input.brokerGrant
  } else {
    environment.TASK24_BROKER_GRANT = input.brokerGrant
  }
  return Object.freeze(environment)
}

export async function assertReferenceFiles(roots: RunRoots, files: readonly string[]): Promise<void> {
  const trusted = assertRunRoots(roots)
  for (const relative of files) {
    if (relative.length === 0 || path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
      throw new TypeError("TASK24_REFERENCE_PATH_INVALID")
    }
    const resolved = path.resolve(trusted.repo, relative)
    if (!resolved.startsWith(path.resolve(trusted.repo) + path.sep))
      throw new TypeError("TASK24_REFERENCE_PATH_INVALID")
    const stat = await fs.lstat(resolved)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError("TASK24_REFERENCE_FILE_INVALID")
  }
}
