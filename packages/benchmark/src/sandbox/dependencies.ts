import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { freeze, DependencyResolution, type TaskExecutionProfile } from "../corpus/evaluation-profile"
import { sha256Text } from "../hash"
import type { TaskAdapterDefinition } from "../corpus/evaluation-catalogue"
import {
  requireDPath,
  decodeHostManifest,
  decodeEngineApproval,
  type HostRequest,
  type HostInventory,
  type HostManifest,
  type EngineSession,
  type DockerRunner,
  type AuthorityGuard,
  type Gate,
} from "./contracts"
import { sessionState, revalidateSession } from "./preflight"
import { requireOperation, isRealDockerRunner, requireDockerExecution } from "./docker"
import { verifyImageRecipe, type ImageRecipe } from "./image-recipes"
import { createOwnedContainer, inspectOwnedContainer, cleanupOwnedContainer } from "./ownership"
import { recordOperationReceipt } from "./receipt"
import { fileIdentity } from "./storage"
import type { FileIdentity } from "./contracts"

export type DependencyVolume = Readonly<{ name: string; target: string; treeSha256: string; receiptSha256: string }>
export type ResolvedTask = Readonly<{
  artifactID: string
  taskID: string
  recipe: ImageRecipe
  image: string
  imageID: string
  platform: string
  volumes: readonly DependencyVolume[]
  tools: readonly string[]
  receiptSha256: string
  assurance: "fixture" | "linux-attested"
}>
export type ResolvedImages = Readonly<{
  schemaVersion: 2
  platform: string
  tasks: readonly ResolvedTask[]
  manifestSha256: string
}>
export type PreparationArtifact = Readonly<{
  id: string
  recipe: ImageRecipe
  source: Readonly<{ kind: "registry" } | { kind: "archive" | "build"; path: string; sha256: string }>
  downloadBytes: number
  unpackedBytes: number
  volumes: readonly { name: string; target: string; treeSha256: string }[]
}>
export type PreparationPlan = Readonly<{
  schemaVersion: 2
  request: HostRequest
  contextFingerprint: string
  artifacts: readonly PreparationArtifact[]
  missing: readonly string[]
  ready: boolean
  maxDiskBytes: number
  planSha256: string
}>
const issuedImages = new WeakSet<object>()

export function planLinuxPreparation(input: {
  request: HostRequest
  inventory: HostInventory
  catalogue: readonly TaskAdapterDefinition[]
  available: readonly PreparationArtifact[]
}): PreparationPlan {
  const missing = [...input.inventory.missing]
  if (!input.available.some((a) => a.id === "linux-runtime")) missing.push("linux-runtime")
  for (const task of input.catalogue)
    if (
      !input.available.some(
        (a) => a.recipe.taskID === task.taskID || (a.id === "linux-runtime" && task.stratum !== "swebench-multimodal"),
      )
    )
      missing.push(`recipe:${task.taskID}`)
  if (input.inventory.requestSha256 !== sha256Text(canonicalJson(input.request)))
    throw new TypeError("TASK24_LINUX_PREPARATION_IDENTITY")
  for (const artifact of input.available) {
    verifyImageRecipe(artifact.recipe)
    if (
      artifact.recipe.platform !== `linux/${input.request.architecture}` ||
      ![artifact.downloadBytes, artifact.unpackedBytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
      artifact.unpackedBytes < artifact.downloadBytes
    )
      throw new TypeError("TASK24_LINUX_ARTIFACT_BOUNDS")
    if (artifact.source.kind !== "registry") {
      requireDPath(artifact.source.path)
      if (
        !/^d:\\opencode-benchmark\\task24\\(?:toolchain\\linux\\[a-f0-9]{64}|tmp\\bprep2-[a-f0-9]+)\\[^\r\n]+\.tar$/i.test(
          artifact.source.path,
        )
      )
        throw new TypeError("TASK24_LINUX_ARTIFACT_SOURCE")
      if (!/^[a-f0-9]{64}$/.test(artifact.source.sha256)) throw new TypeError("TASK24_LINUX_ARTIFACT_HASH")
    }
    for (const volume of artifact.volumes) {
      if (
        volume.name !== `task24-dep-${volume.treeSha256}` ||
        !volume.target.startsWith("/workspace/") ||
        volume.target.includes("..")
      )
        throw new TypeError("TASK24_LINUX_DEPENDENCY_MOUNT")
    }
  }
  if (new Set(input.available.map((a) => a.id)).size !== input.available.length)
    throw new TypeError("TASK24_LINUX_ARTIFACT_DUPLICATE")
  const maxDiskBytes = input.available.reduce((sum, a) => sum + a.downloadBytes + a.unpackedBytes, 0)
  if (!Number.isSafeInteger(maxDiskBytes)) throw new TypeError("TASK24_LINUX_ARTIFACT_BOUNDS")
  const body = {
    schemaVersion: 2 as const,
    request: input.request,
    contextFingerprint: input.inventory.contextFingerprint,
    artifacts: input.available,
    missing: [...new Set(missing)],
    ready: missing.length === 0,
    maxDiskBytes,
  }
  return freeze({ ...body, planSha256: sha256Text(canonicalJson(body)) })
}
export async function prepareLinuxArtifacts(input: {
  plan: PreparationPlan
  approval: unknown
  session: EngineSession
  runner: DockerRunner
  guard: AuthorityGuard
  signal?: AbortSignal
}): Promise<ResolvedImages> {
  const approval = decodeEngineApproval(input.approval),
    state = sessionState(input.session),
    plan = input.plan
  const { planSha256, ...body } = plan
  if (
    sha256Text(canonicalJson(body)) !== planSha256 ||
    !plan.ready ||
    approval.scope !== "prepare" ||
    state.manifest.phase !== "prepare" ||
    canonicalJson(approval) !== canonicalJson(state.approval) ||
    approval.artifactManifestSha256 !== planSha256 ||
    approval.contextFingerprint !== plan.contextFingerprint ||
    approval.maxDiskBytes < plan.maxDiskBytes
  )
    throw new TypeError("TASK24_LINUX_PREPARATION_DENIED")
  const signal = input.signal ?? new AbortController().signal,
    tasks: ResolvedTask[] = []
  async function execute(
    argv: readonly string[],
    operation?: Parameters<typeof requireOperation>[1],
    stdin?: Uint8Array | FileIdentity,
  ) {
    await input.guard()
    await revalidateSession(input.session)
    if (operation) await requireOperation(input.session, operation, input.guard)
    const result = await input.runner.execute({
      argv,
      ...(stdin ? (stdin instanceof Uint8Array ? { stdin } : { stdinFile: stdin }) : {}),
      signal,
      timeoutMs: operation === "image-build" ? 300000 : 15000,
      maxStdoutBytes: 1048576,
      maxStderrBytes: 65536,
    })
    if (isRealDockerRunner(input.runner)) requireDockerExecution(input.runner, result, argv)
    return result
  }
  for (const artifact of plan.artifacts) {
    const recipe = verifyImageRecipe(artifact.recipe)
    const inspectArgs = ["image", "inspect", recipe.image, "--format", "{{json .}}"]
    let inspection = await execute(inspectArgs)
    if (!inspection.started || inspection.exitCode !== 0) {
      if (artifact.source.kind === "registry")
        inspection = await execute(["image", "pull", "--platform", recipe.platform, recipe.image], "image-pull")
      else {
        const source = await fileIdentity(artifact.source.path)
        if (source.sha256 !== artifact.source.sha256 || Bun.file(source.path).size > artifact.downloadBytes)
          throw new TypeError("TASK24_LINUX_ARTIFACT_DRIFT")
        inspection =
          artifact.source.kind === "archive"
            ? await execute(["image", "load"], "image-load", source)
            : await execute(
                [
                  "image",
                  "build",
                  "--pull=false",
                  "--network=default",
                  "--tag",
                  `task24-preparation-${recipe.recipeSha256}`,
                  "-",
                ],
                "image-build",
                source,
              )
      }
      if (!inspection.started || inspection.exitCode !== 0 || inspection.truncated)
        throw new TypeError("TASK24_LINUX_PREPARATION_FAILED")
      inspection = await execute(inspectArgs)
    }
    const Image = Schema.Struct({
      Id: Schema.NonEmptyString,
      RepoDigests: Schema.Array(Schema.String),
      Os: Schema.Literal("linux"),
      Architecture: Schema.String,
      Size: Schema.Int,
    })
    if (inspection.exitCode !== 0 || inspection.truncated) throw new TypeError("TASK24_LINUX_IMAGE_NOT_ADDRESSABLE")
    const image = Schema.decodeUnknownSync(Image)(JSON.parse(Buffer.from(inspection.stdout).toString("utf8")))
    if (
      !/^sha256:[a-f0-9]{64}$/.test(image.Id) ||
      !image.RepoDigests.includes(recipe.image) ||
      `linux/${image.Architecture}` !== recipe.platform ||
      image.Size > artifact.unpackedBytes
    )
      throw new TypeError("TASK24_LINUX_IMAGE_DRIFT")
    for (const volume of artifact.volumes) {
      const queried = await execute(["volume", "inspect", volume.name, "--format", "{{json .}}"], "volume-prepare")
      if (queried.exitCode !== 0) {
        const created = await execute(
          ["volume", "create", "--label", `opencode.task24.tree=${volume.treeSha256}`, volume.name],
          "volume-prepare",
        )
        if (!created.started || created.exitCode !== 0 || created.truncated)
          throw new TypeError("TASK24_LINUX_DEPENDENCY_VOLUME")
      } else {
        const existing = JSON.parse(Buffer.from(queried.stdout).toString("utf8")) as { Labels?: Record<string, string> }
        if (existing.Labels?.["opencode.task24.tree"] !== volume.treeSha256)
          throw new TypeError("TASK24_LINUX_DEPENDENCY_VOLUME")
      }
    }
    const seed = {
      acceptanceID: plan.request.acceptanceID,
      runID: "preparation",
      attemptID: `prepare-${randomBytes(8).toString("hex")}`,
      leaseGeneration: 1,
      operationID: `prepare-${recipe.recipeSha256.slice(0, 16)}`,
      nonce: randomBytes(16).toString("hex"),
      daemonFingerprint: plan.contextFingerprint,
    }
    const owner = await createOwnedContainer({
      session: input.session,
      runner: input.runner,
      owner: seed,
      guard: input.guard,
      signal,
      spec: {
        image: recipe.image,
        argv: ["/usr/local/bin/node", "-e", "setInterval(()=>{},1000)"],
        dependencies: artifact.volumes.map((v) => ({ name: v.name, target: v.target })),
        preparingDependencies: true,
      },
    })
    try {
      const argv = [
        "container",
        "exec",
        "--interactive",
        owner.containerID,
        "/usr/local/bin/node",
        "/opt/task24/audit.mjs",
      ]
      const audited = await execute(
        argv,
        "container-exec",
        Buffer.from(
          canonicalJson({
            volumes: artifact.volumes.map((v) => ({ name: v.name, target: v.target })),
            maxBytes: artifact.unpackedBytes,
          }),
        ),
      )
      if (!audited.started || audited.exitCode !== 0 || audited.truncated)
        throw new TypeError("TASK24_LINUX_ARTIFACT_AUDIT_FAILED")
      const Audit = Schema.Struct({
        platform: Schema.String,
        workerSha256: Schema.String,
        tools: Schema.Array(Schema.NonEmptyString),
        volumes: Schema.Array(Schema.Struct({ name: Schema.String, treeSha256: Schema.String })),
      })
      const audit = Schema.decodeUnknownSync(Audit)(JSON.parse(Buffer.from(audited.stdout).toString("utf8")), {
        onExcessProperty: "error",
      })
      if (
        audit.workerSha256 !== recipe.auditSha256 ||
        audit.platform !== recipe.platform ||
        !["bun", "node", ...(recipe.family === "react-pdf" ? ["pdf-parser", "pdf-raster"] : [])].every((t) =>
          audit.tools.includes(t),
        ) ||
        audit.volumes.length !== artifact.volumes.length ||
        artifact.volumes.some((v) => !audit.volumes.some((a) => a.name === v.name && a.treeSha256 === v.treeSha256))
      )
        throw new TypeError("TASK24_LINUX_ARTIFACT_AUDIT_FAILED")
      const inspect = await inspectOwnedContainer({ session: input.session, runner: input.runner, owner, signal })
      const receipt = await recordOperationReceipt({
        session: input.session,
        runner: input.runner,
        owner,
        operation: "dependency-audit",
        binding: null,
        argv,
        inspect,
        execution: audited,
        evidenceRoot: state.manifest.roots.evidence,
      })
      tasks.push(
        freeze({
          artifactID: artifact.id,
          taskID: recipe.taskID,
          recipe,
          image: recipe.image,
          imageID: image.Id,
          platform: recipe.platform,
          volumes: artifact.volumes.map((v) => ({ ...v, receiptSha256: receipt.receiptSha256 })),
          tools: audit.tools,
          receiptSha256: receipt.receiptSha256,
          assurance: receipt.assurance,
        }),
      )
    } finally {
      const cleaned = await cleanupOwnedContainer({
        session: input.session,
        runner: input.runner,
        owner,
        guard: input.guard,
        signal: new AbortController().signal,
      })
      if (!cleaned.ended || !cleaned.removed) throw new TypeError("TASK24_LINUX_PREPARATION_CLEANUP_UNCERTAIN")
    }
  }
  const result = freeze({
    schemaVersion: 2 as const,
    platform: `linux/${plan.request.architecture}`,
    tasks,
    manifestSha256: input.session.manifestSha256,
  })
  issuedImages.add(result)
  return result
}
export function resolveTaskDependency(input: {
  profile: Pick<TaskExecutionProfile, "dependency">
  images: Pick<ResolvedImages, "tasks">
}): Gate<DependencyResolution> {
  const dependency = input.profile.dependency
  if (dependency.kind === "none") return { kind: "ready", value: { kind: "none" } }
  const task = input.images.tasks.find((t) => t.recipe.recipeSha256 === dependency.recipeSha256)
  if (
    !task ||
    canonicalJson(task.recipe.lockfiles) !== canonicalJson(dependency.lockfiles) ||
    task.recipe.sourceCommit !== dependency.sourceCommit ||
    dependency.requiredCapabilities.some((c) => !task.recipe.capabilities.includes(c)) ||
    ![
      "bun",
      "node",
      ...(dependency.requiredCapabilities.includes("pdf-raster") ? ["pdf-parser", "pdf-raster"] : []),
    ].every((t) => task.tools.includes(t))
  )
    return { kind: "blocked", code: "dependency_unresolved", missing: ["dependency_unresolved"] }
  try {
    verifyImageRecipe(task.recipe)
  } catch {
    return { kind: "blocked", code: "dependency_unresolved", missing: ["dependency_unresolved"] }
  }
  return {
    kind: "ready",
    value: freeze(
      Schema.decodeUnknownSync(DependencyResolution)({
        kind: "resolved",
        recipeSha256: task.recipe.recipeSha256,
        lockfiles: task.recipe.lockfiles,
        image: task.image,
        platform: task.platform,
        receiptSha256: task.receiptSha256,
      }),
    ),
  }
}
export function finalizeHostManifest(input: {
  preparedManifest: HostManifest
  images: ResolvedImages
  binaries: HostManifest["artifacts"]
  browser: HostManifest["artifacts"]
}): HostManifest {
  if (
    !issuedImages.has(input.images) ||
    input.preparedManifest.phase !== "prepare" ||
    input.images.manifestSha256 !== sha256Text(canonicalJson(input.preparedManifest)) ||
    !input.images.tasks.length ||
    input.images.tasks.some((t) => t.assurance !== "linux-attested")
  )
    throw new TypeError("TASK24_LINUX_ARTIFACT_UNVERIFIED")
  const artifacts = [
    ...input.binaries,
    ...input.browser,
    ...input.images.tasks.map((t) => ({
      id: t.artifactID,
      kind: "image" as const,
      sha256: t.image.slice(t.image.lastIndexOf(":") + 1),
      image: t.image,
    })),
  ]
  return decodeHostManifest({
    ...input.preparedManifest,
    phase: "accept",
    artifacts,
    artifactManifestSha256: sha256Text(canonicalJson(artifacts)),
  })
}
