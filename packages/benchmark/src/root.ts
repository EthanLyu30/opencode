import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs"
import { win32 } from "node:path"

const FIXED_ROOT = "D:\\OpenCode-Benchmark\\Task24"
const CHILDREN = ["assets", "cache", "toolchain", "workspaces", "runs", "reports", "tmp"] as const

export type Task24RootErrorCode =
  | "TASK24_ROOT_OUTSIDE_D"
  | "TASK24_ROOT_NOT_CANONICAL"
  | "TASK24_ROOT_NOT_FIXED"
  | "TASK24_ROOT_REDIRECTED"

export class Task24RootError extends Error {
  readonly code: Task24RootErrorCode

  constructor(code: Task24RootErrorCode) {
    super(code)
    this.name = "Task24RootError"
    this.code = code
  }
}

export interface Task24Layout {
  readonly root: string
  readonly assets: string
  readonly cache: string
  readonly toolchain: string
  readonly workspaces: string
  readonly runs: string
  readonly reports: string
  readonly tmp: string
}

function assertExistingSegmentsAreDirect(path: string) {
  let current = win32.parse(path).root
  for (const segment of path.slice(current.length).split("\\").filter(Boolean)) {
    current = win32.join(current, segment)
    if (!existsSync(current)) break
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Task24RootError("TASK24_ROOT_REDIRECTED")
    const real = realpathSync.native(current)
    if (real.localeCompare(current, undefined, { sensitivity: "accent" }) !== 0) {
      throw new Task24RootError("TASK24_ROOT_REDIRECTED")
    }
  }
}

function layout(root: string): Task24Layout {
  return Object.freeze({
    root,
    assets: win32.join(root, "assets"),
    cache: win32.join(root, "cache"),
    toolchain: win32.join(root, "toolchain"),
    workspaces: win32.join(root, "workspaces"),
    runs: win32.join(root, "runs"),
    reports: win32.join(root, "reports"),
    tmp: win32.join(root, "tmp"),
  })
}

export namespace Task24Root {
  export const fixed = FIXED_ROOT

  export function make(value: string): Task24Layout {
    if (!win32.isAbsolute(value) || win32.parse(value).root.toUpperCase() !== "D:\\") {
      throw new Task24RootError("TASK24_ROOT_OUTSIDE_D")
    }

    const normalized = win32.normalize(value)
    if (normalized !== value) throw new Task24RootError("TASK24_ROOT_NOT_CANONICAL")
    if (normalized !== FIXED_ROOT) throw new Task24RootError("TASK24_ROOT_NOT_FIXED")
    assertExistingSegmentsAreDirect(normalized)
    return layout(normalized)
  }

  export function ensure(value: string = FIXED_ROOT): Task24Layout {
    const result = make(value)
    mkdirSync(result.root, { recursive: true })
    for (const child of CHILDREN) mkdirSync(result[child], { recursive: true })
    return make(result.root)
  }
}
