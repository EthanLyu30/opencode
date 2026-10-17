import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { decodeTaskExecutionProfile, freeze, type TaskExecutionProfile } from "../corpus/evaluation-profile"
import { ordinaryFiles, directRoot } from "../corpus/evaluation-bundle"
import {
  buildManifest,
  type BuildRequest,
  type BuildPayload,
  type ProbeRequest,
  type ProbePayload,
  type FailurePayload,
  type CommonRequest,
} from "../evaluator/independent/host"
import { probeWorkerSource, decodeProbeResponse, makeProbeRequest } from "../evaluator/independent/probe"
import { sha256Text } from "../hash"
import { materializeCandidate, readCandidateArchive, outputPolicy, assertSourceUnchanged } from "./archive"
import { buildWorkerSource } from "./worker"
import { sessionState } from "./preflight"
import { requireOperation } from "./docker"
import { createOwnedContainer, cleanupOwnedContainer, inspectOwnedContainer, type Owner } from "./ownership"
import { recordOperationReceipt, type OperationReceipt } from "./receipt"
import type { ResolvedImages, ResolvedTask } from "./dependencies"
import type { EngineSession, DockerRunner, AuthorityGuard } from "./contracts"

export type BackendImage = Pick<ResolvedTask, "taskID" | "image" | "volumes" | "receiptSha256">
export type RawBuild = Readonly<{ payload: BuildPayload | FailurePayload; receipt: OperationReceipt }>
export type RawProbe = Readonly<{ payload: ProbePayload | FailurePayload; receipt: OperationReceipt }>
const BuildReply = Schema.Struct({ commands: Schema.Array(Schema.Struct({ id: Schema.String, exitCode: Schema.Int })) })
export function makeLinuxBackend(input: {
  session: EngineSession
  images: Omit<ResolvedImages, "tasks"> & { tasks: readonly BackendImage[] }
  runner: DockerRunner
  guard: AuthorityGuard
  profiles: readonly { profile: TaskExecutionProfile; outputs: readonly string[] }[]
  signal?: AbortSignal
}) {
  const state = sessionState(input.session),
    signal = input.signal ?? new AbortController().signal
  if (state.manifest.phase !== "accept" || input.images.manifestSha256 !== input.session.manifestSha256)
    throw new TypeError("TASK24_LINUX_BACKEND_MANIFEST")
  const profiles = input.profiles.map((p) => {
    const profile = decodeTaskExecutionProfile(p.profile)
    outputPolicy(profile, p.outputs)
    return freeze({ profile, outputs: [...p.outputs] })
  })
  const workspaces = new Map<string, string>(),
    owned = new Map<string, Owner>(),
    allocated = new Set<string>()
  function policy(request: CommonRequest) {
    const item = profiles.find((p) => sha256Text(canonicalJson(p.profile)) === request.profileSha256)
    const image = input.images.tasks.find((i) => i.taskID === request.identity.taskID)
    if (
      !item ||
      !image ||
      item.profile.taskID !== request.identity.taskID ||
      request.identity.profileSha256 !== request.profileSha256 ||
      request.identity.candidateSha256 !== request.candidate.candidateSha256 ||
      signal.aborted
    )
      throw new TypeError("TASK24_LINUX_BACKEND_BINDING")
    return { ...item, image }
  }
  const key = (r: CommonRequest) => sha256Text(canonicalJson({ identity: r.identity, candidate: r.candidate }))
  async function stop(owner: Owner) {
    const result = await cleanupOwnedContainer({ ...input, owner, signal })
    if (!result.ended || !result.removed) throw new TypeError(`TASK24_LINUX_CLEANUP_UNCERTAIN:${owner.containerID}`)
    owned.delete(owner.containerID)
  }
  async function execute(
    request: CommonRequest,
    operation: "build" | "probe",
    source: string,
    stdin: unknown,
    workspace: string,
  ) {
    const p = policy(request)
    await input.guard()
    const owner = await createOwnedContainer({
      ...input,
      signal,
      owner: {
        acceptanceID: input.session.acceptanceID,
        runID: request.identity.runID,
        attemptID: request.identity.attemptID,
        leaseGeneration: request.identity.leaseGeneration,
        operationID: operation,
        nonce: randomBytes(16).toString("hex"),
        daemonFingerprint: state.inventory.contextFingerprint,
      },
      spec: {
        image: p.image.image,
        argv: ["/usr/local/bin/node", "-e", "setInterval(()=>{},1000)"],
        workspace: { source: workspace, readonly: operation !== "build" },
        dependencies: p.image.volumes,
      },
    })
    owned.set(owner.containerID, owner)
    try {
      await requireOperation(input.session, "container-exec", input.guard)
      const argv = [
        "container",
        "exec",
        "--interactive",
        "--workdir",
        "/workspace",
        owner.containerID,
        operation === "build" ? "/usr/local/bin/node" : "/usr/local/bin/bun",
        ...(operation === "probe" ? ["--no-env-file"] : []),
        "-e",
        source,
        "/workspace",
      ]
      const execution = await input.runner.execute({
        argv,
        stdin: Buffer.from(canonicalJson(stdin)),
        timeoutMs: operation === "build" ? 300000 : 30000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        signal,
      })
      const inspect = await inspectOwnedContainer({ ...input, owner, signal })
      const receipt = await recordOperationReceipt({
        ...input,
        owner,
        operation,
        binding: {
          candidateSha256: request.candidate.candidateSha256,
          configSha256: request.candidate.configSha256,
          profileSha256: request.profileSha256,
          dependencySha256: p.image.receiptSha256,
          workerSha256: sha256Text(source),
        },
        argv,
        inspect,
        execution,
        evidenceRoot: state.manifest.roots.evidence,
      })
      if (!execution.started || execution.truncated || execution.exitCode === 124 || execution.exitCode === 130)
        throw new TypeError("TASK24_LINUX_TRANSPORT_INCOMPLETE")
      return { execution, receipt }
    } finally {
      await stop(owner)
    }
  }
  return {
    session: input.session,
    async build(request: BuildRequest): Promise<RawBuild> {
      const p = policy(request)
      if (
        request.timeoutMs !== 300000 ||
        canonicalJson(request.commands) !== canonicalJson(p.profile.checks) ||
        (request.dependency.kind === "none") !== (p.profile.dependency.kind === "none") ||
        (request.dependency.kind === "resolved" && request.dependency.receiptSha256 !== p.image.receiptSha256)
      )
        throw new TypeError("TASK24_LINUX_BUILD_COMMAND")
      const files = await readCandidateArchive(request.candidate, p.profile)
      const workspace = path.join(state.manifest.roots.work, `candidate-${randomBytes(16).toString("hex")}`)
      await materializeCandidate(files, workspace, p.outputs)
      allocated.add(workspace)
      const before = await ordinaryFiles(workspace)
      const protectedBefore = before.filter(
        (f) =>
          p.profile.protectedPaths.includes(f.path) || /(?:^|\/)(?:package\.json|.*lock.*|.*config\..*)$/i.test(f.path),
      )
      const commands = request.commands.map((c) => ({
        ...c,
        argv:
          c.argv[0] === "bun"
            ? ["/usr/local/bin/bun", "--no-env-file", ...c.argv.slice(1).filter((s) => s !== "--no-env-file")]
            : c.argv[0] === "node"
              ? ["/usr/local/bin/node", ...c.argv.slice(1)]
              : c.argv,
      }))
      const { execution, receipt } = await execute(request, "build", buildWorkerSource(), { commands }, workspace)
      await readCandidateArchive(request.candidate, p.profile)
      const after = await ordinaryFiles(workspace)
      assertSourceUnchanged(before, after)
      for (const file of protectedBefore)
        if (!after.some((a) => canonicalJson(a) === canonicalJson(file)))
          throw new TypeError("TASK24_LINUX_PROTECTED_DRIFT")
      if (execution.exitCode !== 0) return { payload: { kind: "candidate_failure", reason: "BUILD_EXIT" }, receipt }
      const reply = Schema.decodeUnknownSync(BuildReply)(JSON.parse(Buffer.from(execution.stdout).toString("utf8")), {
        onExcessProperty: "error",
      })
      if (
        !reply.commands.length ||
        reply.commands.length > commands.length ||
        reply.commands.some((c, i) => c.id !== commands[i]?.id)
      )
        throw new TypeError("TASK24_LINUX_BUILD_PROTOCOL")
      if (reply.commands.some((c) => c.exitCode !== 0))
        return { payload: { kind: "candidate_failure", reason: "BUILD_CHECK_FAILED" }, receipt }
      if (reply.commands.length !== commands.length) throw new TypeError("TASK24_LINUX_BUILD_INCOMPLETE")
      const exported = p.outputs.length
        ? after.filter((f) => p.outputs.some((o) => f.path === o || f.path.startsWith(o + "/")))
        : after
      const build = buildManifest({
        candidateSha256: request.candidate.candidateSha256,
        configSha256: request.candidate.configSha256,
        dependencySha256: sha256Text(canonicalJson(request.dependency)),
        files: exported,
      })
      workspaces.set(key(request), workspace)
      return freeze({ payload: { kind: "ok", commands: reply.commands, build }, receipt })
    },
    async probe(request: ProbeRequest): Promise<RawProbe> {
      const p = policy(request)
      const workspace = workspaces.get(key(request))
      if (!workspace || request.timeoutMs !== 30000) throw new TypeError("TASK24_LINUX_PROBE_BUILD_REQUIRED")
      const checked = makeProbeRequest({
        identity: request.identity,
        profile: p.profile,
        inputs: {
          candidate: request.candidate,
          module: request.module,
          cases: request.operations.map((c) => ({
            id: c.id,
            fixtures: request.inputs.find((i) => i.id === c.id)?.fixtures,
            operations: c.steps.map((s) => ({ ...s, kind: s.kind as "get" | "call" | "method" })),
          })),
        },
      })
      if (canonicalJson(request) !== canonicalJson(checked)) throw new TypeError("TASK24_LINUX_PROBE_REQUEST")
      const before = await ordinaryFiles(workspace)
      const { execution, receipt } = await execute(
        request,
        "probe",
        "process.argv[2]=process.argv.at(-1);\n" + probeWorkerSource(),
        request,
        workspace,
      )
      await readCandidateArchive(request.candidate, p.profile)
      if (canonicalJson(await ordinaryFiles(workspace)) !== canonicalJson(before))
        throw new TypeError("TASK24_LINUX_PROBE_SOURCE_DRIFT")
      if (execution.exitCode !== 0) return { payload: { kind: "candidate_failure", reason: "PROBE_EXIT" }, receipt }
      const response = decodeProbeResponse(execution.stdout)
      if (
        response.cases.length !== request.operations.length ||
        response.cases.some(
          (c, i) => c.id !== request.operations[i]?.id || c.outputs.length !== request.operations[i]?.steps.length,
        )
      )
        throw new TypeError("TASK24_LINUX_PROBE_COVERAGE")
      return freeze({ payload: { kind: "ok", response }, receipt })
    },
    stop,
    async workspace(request: CommonRequest) {
      policy(request)
      const root = workspaces.get(key(request))
      if (!root) throw new TypeError("TASK24_LINUX_BUILD_REQUIRED")
      return directRoot(root)
    },
    async dispose() {
      for (const owner of owned.values()) await stop(owner)
      for (const root of allocated) {
        const resolved = await directRoot(root)
        if (
          path.dirname(resolved) !== state.manifest.roots.work ||
          !/^candidate-[a-f0-9]{32}$/.test(path.basename(resolved))
        )
          throw new TypeError("TASK24_LINUX_WORKSPACE_OWNER")
        await fs.rm(resolved, { recursive: true })
      }
      workspaces.clear()
      allocated.clear()
    },
  }
}
export type LinuxBackend = ReturnType<typeof makeLinuxBackend>
