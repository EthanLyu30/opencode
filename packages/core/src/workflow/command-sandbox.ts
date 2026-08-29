export * as WorkflowCommandSandbox from "./command-sandbox"

import path from "path"
import { type ToolCall } from "@opencode-ai/llm"
import { WorkflowRole } from "@opencode-ai/schema/workflow-role"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Context, Duration, Effect, Layer, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { AppProcess } from "../process"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { WorkflowProductionHostPlan } from "./production-host-plan"
import { WorkflowWorkspaceMaterialization } from "./workspace-materialization"

export interface Request {
  readonly role: WorkflowRole.Role
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly policyDigest: string
  readonly sessionID: SessionSchema.ID
  readonly agent: AgentV2.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: ToolCall["id"]
  readonly command: string
  readonly workdir?: string
  readonly timeout?: number
}

export interface Result {
  readonly exit: number
  readonly output: string
  readonly truncated: boolean
}

export interface FrozenTestRequest {
  readonly workflowID: Workflow.ID
  readonly stageID: Workflow.StageID
  readonly revision: number
  readonly argv: readonly ["bun", "test"] | readonly ["bun", "run", "test"]
  readonly cwd: WorkflowProductionHostPlan.FunctionalTest["cwd"]
  readonly policySha256: string
  readonly configSha256: string
  readonly sealedSnapshot: WorkflowWorkspaceMaterialization.Sealed
}

export class Unavailable extends Schema.TaggedErrorClass<Unavailable>()("WorkflowCommandSandbox.Unavailable", {
  message: Schema.String,
}) {}

export class Rejected extends Schema.TaggedErrorClass<Rejected>()("WorkflowCommandSandbox.Rejected", {
  message: Schema.String,
}) {}

export type Error = Unavailable | Rejected

export interface Interface {
  readonly run: (input: Request) => Effect.Effect<Result, Error>
  /** Trusted host-selected test plan; no model-authored shell text is accepted. */
  readonly runFrozenTest?: (input: FrozenTestRequest) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WorkflowCommandSandbox") {}

const unavailableLayer = Layer.succeed(
  Service,
  Service.of({
    run: () =>
      Effect.fail(
        new Unavailable({
          message: "Workflow command sandbox is unavailable; host Bash fallback is forbidden",
        }),
      ),
  }),
)

export const node = makeLocationNode({ service: Service, layer: unavailableLayer, deps: [] })

export interface WslConfig {
  readonly distribution: string
  readonly resolvePolicy: (input: {
    readonly workflowID: Workflow.ID
    readonly stageID: Workflow.StageID
    readonly role: WorkflowRole.Role
    readonly policyDigest: string
  }) =>
    | {
        readonly workspace: "readonly" | "readwrite"
        readonly outputDirectories: readonly string[]
      }
    | undefined
  readonly limits: {
    readonly timeoutMs: number
    readonly maxOutputBytes: number
    readonly maxProcesses: number
    readonly maxMemoryBytes: number
    readonly maxOpenFiles: number
  }
}

/**
 * Real executable test backend for Windows hosts with unprivileged WSL2 user
 * namespaces. It is opt-in and never selected by production Core. The later
 * Server runtime task owns the Docker backend, pinned image, and deployment
 * configuration; until then production uses the unavailable layer above.
 */
export function wslNode(config: WslConfig) {
  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const location = yield* Location.Service
      const mutation = yield* LocationMutation.Service
      const fs = yield* FSUtil.Service
      const processes = yield* AppProcess.Service

      return Service.of({
        run: Effect.fn("WorkflowCommandSandbox.run")(function* (request) {
          const resolved = config.resolvePolicy(request)
          if (!resolved) return yield* reject("No exact frozen sandbox policy matches the verified workflow lineage")
          const policy = {
            workspace: resolved.workspace,
            outputDirectories: Object.freeze([...resolved.outputDirectories]),
          }
          const outputDirectories = policy.outputDirectories
          const workdir = request.workdir ?? "."
          if (!relativePath(workdir) || outputDirectories.some((directory) => !relativePath(directory)))
            return yield* reject("Workflow sandbox paths must be workspace-relative")
          const cwd = yield* inside(mutation, workdir, "directory")
          if (cwd.externalDirectory) return yield* reject("Workflow working directory escapes the persisted Location")
          const outputs = yield* Effect.forEach(outputDirectories, (directory) =>
            inside(mutation, directory, "directory"),
          )
          if (outputs.some((target) => target.externalDirectory))
            return yield* reject("Workflow output directory escapes the persisted Location")
          yield* Effect.forEach(outputs, (target) =>
            fs
              .ensureDir(target.canonical)
              .pipe(Effect.mapError(() => new Rejected({ message: "Unable to prepare workflow output directory" }))),
          )
          if (
            yield* containsLink(fs, location.directory).pipe(
              Effect.mapError(() => new Rejected({ message: "Unable to inspect workflow workspace links" })),
            )
          )
            return yield* reject("Workflow sandbox rejects workspaces containing symbolic links or junctions")

          const timeout = Math.min(request.timeout ?? config.limits.timeoutMs, config.limits.timeoutMs)
          const workspace = windowsToWsl(location.directory)
          if (!workspace) return yield* new Unavailable({ message: "WSL sandbox requires a local Windows drive path" })
          const script = renderWrapper({
            workspace,
            workdir: workdir.replaceAll("\\", "/"),
            timeoutSeconds: Math.max(1, Math.ceil(timeout / 1_000)),
            maxProcesses: config.limits.maxProcesses,
            maxMemoryBytes: config.limits.maxMemoryBytes,
            maxOpenFiles: config.limits.maxOpenFiles,
            workspaceAccess: policy.workspace,
            outputDirectories: outputDirectories.map((directory) => directory.replaceAll("\\", "/")),
            command: request.command,
          })
          const command = ChildProcess.make(
            "wsl.exe",
            [
              "-d",
              config.distribution,
              "--",
              "unshare",
              "--user",
              "--map-root-user",
              "--mount",
              "--net",
              "--pid",
              "--fork",
              "--mount-proc",
              "--ipc",
              "--uts",
              "/bin/sh",
            ],
            { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
          )
          const result = yield* processes
            .run(command, {
              stdin: script,
              combineOutput: true,
              timeout: Duration.millis(timeout + 5_000),
              maxOutputBytes: config.limits.maxOutputBytes,
            })
            .pipe(
              Effect.mapError(
                () => new Unavailable({ message: "Workflow WSL sandbox failed before command settlement" }),
              ),
            )
          return {
            exit: result.exitCode,
            output: result.output?.toString("utf8") || "(no output)",
            truncated: result.outputTruncated === true,
          }
        }),
      })
    }),
  )
  return makeLocationNode({
    service: Service,
    layer,
    deps: [Location.node, LocationMutation.node, FSUtil.node, AppProcess.node],
  })
}

function inside(mutation: LocationMutation.Interface, value: string, kind: LocationMutation.Kind) {
  return mutation
    .resolve({ path: value, kind })
    .pipe(Effect.mapError(() => new Rejected({ message: "Workflow path escapes the persisted Location" })))
}

function reject(message: string) {
  return Effect.fail(new Rejected({ message }))
}

function relativePath(value: string) {
  if (value.length === 0 || value.includes("\0") || path.isAbsolute(value)) return false
  const parts = value.replaceAll("\\", "/").split("/")
  if (parts.some((part) => part === "..")) return false
  return !parts.some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}

const containsLink = Effect.fn("WorkflowCommandSandbox.containsLink")(function* (
  fs: FSUtil.Interface,
  directory: string,
): Effect.fn.Return<boolean, FSUtil.Error> {
  const entries = yield* fs.readDirectoryEntries(directory)
  if (entries.some((entry) => entry.type === "symlink" || entry.type === "other")) return true
  return (yield* Effect.forEach(
    entries.filter((entry) => entry.type === "directory"),
    (entry) => containsLink(fs, path.join(directory, entry.name)),
  )).some(Boolean)
})

function windowsToWsl(value: string) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(value)
  if (!match) return undefined
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`
}

function renderWrapper(input: {
  readonly workspace: string
  readonly workdir: string
  readonly timeoutSeconds: number
  readonly maxProcesses: number
  readonly maxMemoryBytes: number
  readonly maxOpenFiles: number
  readonly workspaceAccess: "readonly" | "readwrite"
  readonly outputDirectories: readonly string[]
  readonly command: string
}) {
  const encode = (value: string) => Buffer.from(value, "utf8").toString("base64")
  return String.raw`set -eu
workspace_source="$(printf %s '${encode(input.workspace)}' | base64 -d)"
workdir="$(printf %s '${encode(input.workdir)}' | base64 -d)"
timeout_seconds='${input.timeoutSeconds}'
max_processes='${input.maxProcesses}'
max_memory='${input.maxMemoryBytes}'
max_files='${input.maxOpenFiles}'
workspace_access='${input.workspaceAccess}'
encoded_outputs='${input.outputDirectories.map(encode).join(" ")}'
command_text="$(printf %s '${encode(input.command)}' | base64 -d)"

mount --bind "$workspace_source" /run
mount -o remount,bind,ro /run
mount -t tmpfs -o mode=755,nosuid,nodev,noexec tmpfs /home
mount -t tmpfs -o mode=700,nosuid,nodev,noexec tmpfs /root
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /var/tmp
mount -t tmpfs -o mode=755,nosuid,nodev tmpfs /mnt
mkdir -p /mnt/workspace

if [ "$workspace_access" = readwrite ]; then
  mount --bind /run /mnt/workspace
  mount -o remount,bind,rw /mnt/workspace
else
  cp -a /run/. /mnt/workspace/
fi

for encoded_output in $encoded_outputs; do
  output="$(printf %s "$encoded_output" | base64 -d)"
  case "$output" in
    ""|/*|../*|*/../*|*/..) exit 125 ;;
  esac
  mkdir -p "/mnt/workspace/$output"
  mount --bind "/run/$output" "/mnt/workspace/$output"
  mount -o remount,bind,rw "/mnt/workspace/$output"
done

mount -o remount,bind,ro /mnt
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /tmp
mount -t tmpfs -o mode=755,nosuid,nodev,noexec tmpfs /run
mount --bind /dev/null /init
hostname opencode-sandbox
cd "/mnt/workspace/$workdir"
exec env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=/tmp \
  LANG=C.UTF-8 \
  timeout --signal=TERM --kill-after=2s "${"$"}{timeout_seconds}s" \
  prlimit --nproc="$max_processes" --as="$max_memory" --nofile="$max_files" -- \
  /bin/sh -c "$command_text"`
}
