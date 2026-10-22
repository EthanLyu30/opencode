import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import {
  decodeHostRequest,
  type DockerInvocation,
  type DockerExecution,
  type DockerRunner,
  type HostRequest,
  type EngineSession,
  type EngineApproval,
  type AuthorityGuard,
  type StorageProof,
  requestOf,
} from "./contracts"
import { directoryIdentity, fileIdentity, hostCliIdentity, inspectStorage } from "./storage"
import { makeNativeWsl2Transport, makeNativeAttestedWsl2Transport } from "./wsl2-independent"
import { revalidateSession, sessionState } from "./preflight"
import { sha256Bytes, sha256Text } from "../hash"

const realRunners = new WeakSet<object>()
const executions = new WeakMap<object, { runner: DockerRunner; argv: string; bytes: string }>()
export function isReadonlyDockerInvocation(args: readonly string[], hasSession: boolean) {
  if (
    hasSession &&
    args[0] === "volume" &&
    args[1] === "inspect" &&
    args.length === 5 &&
    /^task24-dep-[a-f0-9]{64}$/.test(args[2]!) &&
    args[3] === "--format" &&
    args[4] === "{{json .}}"
  )
    return true
  if (
    (args[0] === "version" || args[0] === "info") &&
    args.length === 3 &&
    args[1] === "--format" &&
    /^\{\{json \.(?:Server)?\}\}$/.test(args[2]!)
  )
    return true
  if (
    args[0] === "context" &&
    args[1] === "inspect" &&
    args.length === 5 &&
    /^[a-z0-9][a-z0-9._-]{0,127}$/.test(args[2]!) &&
    args[3] === "--format" &&
    args[4] === "{{json .}}"
  )
    return true
  if (!hasSession || args[0] !== "image" || args[1] !== "inspect" || args.length !== 5) return false
  const digest = /^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/
  return (
    (digest.test(args[2]!) && args[3] === "--format" && args[4] === "{{json .}}") ||
    (args[2] === "--format" && args[3] === "{{json .}}" && digest.test(args[4]!))
  )
}
function executionBytes(value: DockerExecution) {
  return sha256Text(
    canonicalJson({
      started: value.started,
      exitCode: value.exitCode,
      truncated: value.truncated,
      cleanupUncertain: value.cleanupUncertain === true,
      stdout: sha256Bytes(value.stdout),
      stderr: sha256Bytes(value.stderr),
    }),
  )
}
export function requireDockerExecution(runner: DockerRunner, execution: DockerExecution, argv: readonly string[]) {
  const issued = executions.get(execution)
  if (
    !issued ||
    issued.runner !== runner ||
    issued.argv !== canonicalJson(argv) ||
    issued.bytes !== executionBytes(execution)
  )
    throw new TypeError("TASK24_LINUX_EXECUTION_AUTHORITY")
}
export function requireRealDockerRunner(runner: DockerRunner) {
  if (!realRunners.has(runner)) throw new TypeError("TASK24_LINUX_FIXTURE_TRANSPORT")
}
export function isRealDockerRunner(runner: DockerRunner) {
  return realRunners.has(runner)
}

/** Generic byte transport; using it for an own fixture never attests a Docker engine. */
export function makeProcessRunner(options: {
  executable: string
  argvPrefix: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
}): DockerRunner {
  return {
    async execute(input) {
      if (
        ![input.timeoutMs, input.maxStdoutBytes, input.maxStderrBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
        input.timeoutMs > 600000 ||
        input.maxStdoutBytes > 100663296 ||
        input.maxStderrBytes > 1048576 ||
        input.argv.some((v) => v.includes("\0"))
      )
        throw new TypeError("TASK24_LINUX_INVOCATION")
      if (input.signal.aborted)
        return { started: false, exitCode: 130, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false }
      if (
        input.stdinFile &&
        (input.stdin || canonicalJson(await fileIdentity(input.stdinFile.path)) !== canonicalJson(input.stdinFile))
      )
        throw new TypeError("TASK24_LINUX_STDIN_FILE")
      const proc = (() => {
        try {
          return Bun.spawn([options.executable, ...options.argvPrefix, ...input.argv], {
            cwd: options.cwd,
            env: { ...options.env },
            stdin: input.stdinFile ? Bun.file(input.stdinFile.path) : input.stdin ? "pipe" : "ignore",
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
          })
        } catch {
          return null
        }
      })()
      if (!proc)
        return { started: false, exitCode: 127, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false }
      let truncated = false,
        timedOut = false,
        cleanupUncertain = false
      let drainTimer: ReturnType<typeof setTimeout> | undefined,
        finishDrain: () => void = () => {}
      const drainExpired = new Promise<null>((resolve) => {
        finishDrain = () => resolve(null)
      })
      const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
      const collected: Uint8Array[][] = []
      const stop = () => {
        cleanupUncertain = true
        truncated = true
        try {
          proc.kill()
        } catch {}
        drainTimer ??= setTimeout(() => {
          cleanupUncertain = true
          truncated = true
          for (const reader of readers) void reader.cancel().catch(() => {})
          finishDrain()
        }, 250)
      }
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, input.timeoutMs)
      input.signal.addEventListener("abort", stop, { once: true })
      async function collect(stream: ReadableStream<Uint8Array>, limit: number) {
        const reader = stream.getReader(),
          chunks: Uint8Array[] = []
        readers.push(reader)
        collected.push(chunks)
        let length = 0
        while (true) {
          const next = await reader.read()
          if (next.done) break
          const remaining = limit - length
          if (next.value.length > remaining) {
            if (remaining > 0) chunks.push(next.value.slice(0, remaining))
            length = limit
            truncated = true
            stop()
            continue
          }
          chunks.push(next.value)
          length += next.value.length
        }
        return new Uint8Array(Buffer.concat(chunks))
      }
      try {
        const write = async () => {
          if (input.stdin && proc.stdin && typeof proc.stdin !== "number") {
            try {
              proc.stdin.write(input.stdin)
              await proc.stdin.end()
            } catch {
              stop()
            }
          }
        }
        const completed = Promise.all([
          collect(proc.stdout, input.maxStdoutBytes),
          collect(proc.stderr, input.maxStderrBytes),
          proc.exited,
          write(),
        ]).catch(() => null)
        const result = await Promise.race([completed, drainExpired])
        if (!result) {
          cleanupUncertain = true
          truncated = true
          stop()
        }
        const stdout = result?.[0] ?? new Uint8Array(Buffer.concat(collected[0] ?? [])),
          stderr = result?.[1] ?? new Uint8Array(Buffer.concat(collected[1] ?? [])),
          exitCode = result?.[2] ?? (timedOut ? 124 : input.signal.aborted ? 130 : 125)
        if (
          input.stdinFile &&
          canonicalJson(await fileIdentity(input.stdinFile.path)) !== canonicalJson(input.stdinFile)
        )
          throw new TypeError("TASK24_LINUX_STDIN_FILE")
        return {
          started: true,
          exitCode: timedOut ? 124 : input.signal.aborted ? 130 : exitCode,
          stdout,
          stderr,
          truncated,
          ...(cleanupUncertain ? { cleanupUncertain: true as const } : {}),
        }
      } finally {
        clearTimeout(timer)
        if (drainTimer) clearTimeout(drainTimer)
        input.signal.removeEventListener("abort", stop)
      }
    },
  }
}
export async function requireOperation(
  session: EngineSession,
  operation: EngineApproval["allowedOperations"][number],
  guard: AuthorityGuard,
) {
  await guard()
  const state = await revalidateSession(session)
  if (!state.approval.allowedOperations.includes(operation)) throw new TypeError("TASK24_LINUX_OPERATION_DENIED")
  return state
}
export function makeDockerRunner(options: {
  request: HostRequest
  session?: EngineSession
  guard?: AuthorityGuard
}): DockerRunner {
  return makeRunner(options)
}

/** Same fresh proof, collected alongside execution instead of six WSL crossings per verb. */
export async function makeProductionCommandDockerRunner(input: { session: EngineSession; guard: AuthorityGuard }) {
  const state = await revalidateSession(input.session)
  if (!state.manifest.wsl2 || state.manifest.phase !== "accept") throw new TypeError("TASK24_WSL2_PRODUCTION_SESSION")
  return makeRunner({ request: requestOf(state.manifest), ...input }, state.manifest.storage)
}

function makeRunner(
  options: { request: HostRequest; session?: EngineSession; guard?: AuthorityGuard },
  storage?: StorageProof,
): DockerRunner {
  const request = decodeHostRequest(options.request)
  const process = request.wsl2
    ? storage
      ? makeNativeAttestedWsl2Transport(request, storage)
      : makeNativeWsl2Transport(request)
    : makeProcessRunner({
        executable: request.cli.path,
        argvPrefix: [],
        cwd: request.roots.temp,
        env: {
          DOCKER_CONFIG: request.roots.config,
          DOCKER_HOST: "",
          DOCKER_CONTEXT: request.context,
          DOCKER_TLS_VERIFY: "",
          DOCKER_CERT_PATH: "",
          BUILDX_BUILDER: "",
          BUILDKIT_HOST: "",
          TEMP: request.roots.temp,
          TMP: request.roots.temp,
          PATH: path.dirname(request.cli.path),
        },
      })
  const runner: DockerRunner = {
    async execute(input) {
      const args = input.argv[0] === "--context" ? input.argv.slice(2) : input.argv
      const context = input.argv[0] === "--context" ? input.argv[1] : request.context
      if (context !== request.context && context !== "default") throw new TypeError("TASK24_LINUX_OPERATION_DENIED")
      if (storage && options.session) {
        const expected = sessionState(options.session).inventory.rootIdentities
        for (const [key, root] of Object.entries(request.roots))
          if ((await directoryIdentity(root).catch(() => null)) !== expected[key])
            throw new TypeError("TASK24_LINUX_SESSION_STALE")
      }
      const readonly = isReadonlyDockerInvocation(args, !!options.session)
      if (!readonly) {
        if (
          args[0] === "container" &&
          args[1] === "cp" &&
          (args.length !== 4 ||
            args[2] !== "-" ||
            !/^[a-f0-9]{64}:\/$/.test(args[3] ?? "") ||
            !input.stdin ||
            input.stdinFile ||
            input.stdin.byteLength > 8388608)
        )
          throw new TypeError("TASK24_LINUX_OPERATION_DENIED")
        const map: Record<string, EngineApproval["allowedOperations"][number]> = {
          "container/create": "container-create",
          "container/start": "container-start",
          "container/exec": "container-exec",
          "container/cp": "container-exec",
          "container/stop": "container-stop",
          "container/kill": "container-stop",
          "container/rm": "container-remove",
          "container/inspect": "container-exec",
          "container/ls": "container-exec",
          "image/pull": "image-pull",
          "image/load": "image-load",
          "image/build": "image-build",
          "volume/create": "volume-prepare",
          "volume/inspect": "volume-prepare",
        }
        const operation = map[`${args[0]}/${args[1]}`]
        if (!operation || !options.session || !options.guard) throw new TypeError("TASK24_LINUX_OPERATION_DENIED")
        if (!storage) await requireOperation(options.session, operation, options.guard)
        if (storage) {
          await options.guard()
          if (
            !sessionState(options.session).approval.allowedOperations.includes(operation) ||
            (await inspectStorage(storage)).kind !== "ready"
          )
            throw new TypeError("TASK24_LINUX_OPERATION_DENIED")
        }
      }
      if (canonicalJson(await hostCliIdentity(request)) !== canonicalJson(request.cli))
        throw new TypeError("TASK24_LINUX_CLI_CHANGED")
      const result = await process.execute({ ...input, argv: ["--context", context!, ...args] })
      if (canonicalJson(await hostCliIdentity(request)) !== canonicalJson(request.cli))
        throw new TypeError("TASK24_LINUX_CLI_CHANGED")
      executions.set(result, { runner, argv: canonicalJson(input.argv), bytes: executionBytes(result) })
      return result
    },
  }
  realRunners.add(runner)
  return runner
}
