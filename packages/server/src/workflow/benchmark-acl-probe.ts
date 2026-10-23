export * as BenchmarkAclProbe from "./benchmark-acl-probe"

import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { HostRootPolicy } from "./host-root-policy"

interface Invocation extends HostRootPolicy.ProbeInvocation {
  readonly timeoutMs: 5000
  readonly stdout: number
  readonly stderr: number
}

/** Only the transport changes; productionProbe retains the fixed query and decoder. */
export function make(input: {
  readonly tempRoot: string
  readonly guard: () => void
  readonly run?: (input: Invocation) => { readonly status: number | null; readonly error?: unknown }
}): HostRootPolicy.Probe {
  const temp = path.resolve(input.tempRoot)
  if (temp !== input.tempRoot || path.parse(temp).root.toLowerCase() !== "d:\\" || temp === path.parse(temp).root)
    throw new TypeError("TASK24_BENCHMARK_ACL_TEMP")
  const parent = identity(temp, true)
  const refuseResidue = () => {
    if (fs.readdirSync(temp).some((name) => name.startsWith("acl-query-")))
      throw Object.assign(new Error("TASK24_BENCHMARK_ACL_CLEANUP_UNCERTAIN"), { cleanupUncertain: true, root: temp })
  }
  refuseResidue()
  const run =
    input.run ??
    ((invocation: Invocation) => {
      const result = spawnSync(invocation.executable, [...invocation.argv], {
        env: { ...invocation.env },
        stdio: ["ignore", invocation.stdout, invocation.stderr],
        windowsHide: true,
        shell: false,
        timeout: invocation.timeoutMs,
      })
      return { status: result.status, error: result.error }
    })
  return HostRootPolicy.productionProbe({
    tempRoot: temp,
    run(invocation) {
      input.guard()
      if (identity(temp, true) !== parent) throw new TypeError("TASK24_BENCHMARK_ACL_TEMP_CHANGED")
      refuseResidue()
      const root = fs.mkdtempSync(path.join(temp, "acl-query-"))
      let rootID: string | undefined
      const files = new Map<string, string>()
      const handles: number[] = []
      let ended = false
      try {
        rootID = identity(root, true)
        for (const name of ["result.json", "error.txt"]) {
          const file = path.join(root, name)
          handles.push(fs.openSync(file, "wx+", 0o600))
          files.set(file, identity(file, false))
        }
        const output = path.join(root, "result.json"),
          error = path.join(root, "error.txt")
        const result = run({
          ...invocation,
          env: { ...invocation.env, OPENCODE_ACL_PROBE_OUTPUT: output, OPENCODE_ACL_PROBE_ERROR: error },
          timeoutMs: 5000,
          stdout: handles[0]!,
          stderr: handles[1]!,
        })
        ended = result.status !== null && result.error === undefined
        if (!ended) throw new TypeError("TASK24_BENCHMARK_ACL_PROCESS_UNCERTAIN")
        const stdout = read(output, files.get(output)!, 1048576)
        const stderr = read(error, files.get(error)!, 65536)
        input.guard()
        return { exit: result.status!, stdout, stderr }
      } finally {
        try {
          for (const handle of handles) fs.closeSync(handle)
          if (
            !ended ||
            !rootID ||
            identity(temp, true) !== parent ||
            identity(root, true) !== rootID ||
            files.size !== 2 ||
            fs.readdirSync(root).length !== files.size
          )
            throw new TypeError("unverified probe ownership")
          for (const [file, id] of files) if (identity(file, false) !== id) throw new TypeError("probe file changed")
          for (const file of files.keys()) fs.unlinkSync(file)
          fs.rmdirSync(root)
        } catch {
          throw Object.assign(new Error("TASK24_BENCHMARK_ACL_CLEANUP_UNCERTAIN"), { cleanupUncertain: true, root })
        }
      }
    },
  })
}

function identity(file: string, directory: boolean) {
  const stat = fs.lstatSync(file, { bigint: true })
  if (
    fs.realpathSync.native(file) !== file ||
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
  )
    throw new TypeError("TASK24_BENCHMARK_ACL_IDENTITY")
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

function read(file: string, expected: string, limit: number) {
  if (identity(file, false) !== expected) throw new TypeError("TASK24_BENCHMARK_ACL_IDENTITY")
  const before = fs.lstatSync(file, { bigint: true })
  if (before.size > BigInt(limit)) throw new TypeError("TASK24_BENCHMARK_ACL_OUTPUT_LIMIT")
  const bytes = fs.readFileSync(file)
  const after = fs.lstatSync(file, { bigint: true })
  if (
    identity(file, false) !== expected ||
    before.size !== BigInt(bytes.length) ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  )
    throw new TypeError("TASK24_BENCHMARK_ACL_IDENTITY")
  // Match the original spawnSync encoding:'utf8', including genuine startup stderr.
  return bytes.toString("utf8")
}
