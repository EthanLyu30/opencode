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
} from "./contracts"
import { fileIdentity } from "./storage"
import { revalidateSession } from "./preflight"
import { sha256Bytes, sha256Text } from "../hash"

const realRunners = new WeakSet<object>()
const executions = new WeakMap<object, { runner: DockerRunner; argv: string; bytes: string }>()
function executionBytes(value: DockerExecution) {
  return sha256Text(
    canonicalJson({
      started: value.started,
      exitCode: value.exitCode,
      truncated: value.truncated,
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
      const proc = (() => {
        try {
          return Bun.spawn([options.executable, ...options.argvPrefix, ...input.argv], {
            cwd: options.cwd,
            env: { ...options.env },
            stdin: input.stdin ? "pipe" : "ignore",
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
        timedOut = false
      const stop = () => {
        try {
          proc.kill()
        } catch {}
      }
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, input.timeoutMs)
      input.signal.addEventListener("abort", stop, { once: true })
      async function collect(stream: ReadableStream<Uint8Array>, limit: number) {
        const reader = stream.getReader(),
          chunks: Uint8Array[] = []
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
        const [stdout, stderr, exitCode] = await Promise.all([
          collect(proc.stdout, input.maxStdoutBytes),
          collect(proc.stderr, input.maxStderrBytes),
          proc.exited,
          write(),
        ])
        return {
          started: true,
          exitCode: timedOut ? 124 : input.signal.aborted ? 130 : exitCode,
          stdout,
          stderr,
          truncated,
        }
      } finally {
        clearTimeout(timer)
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
  const request = decodeHostRequest(options.request)
  const process = makeProcessRunner({
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
      const readonly = args[0] === "version" || args[0] === "info" || (args[0] === "context" && args[1] === "inspect")
      if (!readonly) {
        const map: Record<string, EngineApproval["allowedOperations"][number]> = {
          "container/create": "container-create",
          "container/start": "container-start",
          "container/exec": "container-exec",
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
        await requireOperation(options.session, operation, options.guard)
      }
      if (canonicalJson(await fileIdentity(request.cli.path)) !== canonicalJson(request.cli))
        throw new TypeError("TASK24_LINUX_CLI_CHANGED")
      const result = await process.execute({ ...input, argv: ["--context", context!, ...args] })
      if (canonicalJson(await fileIdentity(request.cli.path)) !== canonicalJson(request.cli))
        throw new TypeError("TASK24_LINUX_CLI_CHANGED")
      executions.set(result, { runner, argv: canonicalJson(input.argv), bytes: executionBytes(result) })
      return result
    },
  }
  realRunners.add(runner)
  return runner
}
