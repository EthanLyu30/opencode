import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import type { EngineSession, DockerRunner, AuthorityGuard } from "./contracts"
import { sessionState, revalidateSession } from "./preflight"
import { createOwnedContainer, inspectOwnedContainer, cleanupOwnedContainer, type Owner } from "./ownership"
import { requireRealDockerRunner, requireOperation } from "./docker"
import { recordOperationReceipt } from "./receipt"
import { publishImmutable } from "../offline/atomic"
import { bindEvidenceFile, type EvidenceReference } from "../evaluator/evidence"
import { type ResolvedImages, volumeMetadataIdentity } from "./dependencies"
import { readControllerJson } from "./readiness"
import { freeze } from "../corpus/evaluation-profile"
const auditProofs = new WeakMap<object, string>()
export function requireDependencyAudit(value: readonly EvidenceReference[], session: EngineSession) {
  if (auditProofs.get(value) !== session.manifestSha256) throw new TypeError("TASK24_DEPENDENCY_AUDIT_AUTHORITY")
}
const Audit = Schema.Struct({
  platform: Schema.String,
  workerSha256: Schema.String,
  tools: Schema.Array(Schema.String),
  volumes: Schema.Array(Schema.Struct({ name: Schema.String, treeSha256: Schema.String, fileID: Schema.String })),
})
export function validateDependencyAudit(
  raw: unknown,
  expected: {
    platform: string
    workerSha256: string
    volumes: readonly { name: string; treeSha256: string; fileID: string }[]
  },
) {
  const value = Schema.decodeUnknownSync(Audit)(raw, { onExcessProperty: "error" })
  if (
    value.platform !== expected.platform ||
    value.workerSha256 !== expected.workerSha256 ||
    !["node", "bun"].every((t) => value.tools.includes(t)) ||
    value.volumes.length !== expected.volumes.length ||
    new Set(value.volumes.map((v) => v.name)).size !== value.volumes.length ||
    expected.volumes.some((v) => !value.volumes.some((a) => canonicalJson(a) === canonicalJson(v)))
  )
    throw new TypeError("TASK24_DEPENDENCY_AUDIT_STALE")
  return value
}
export type DependencyAuditSet = Readonly<{
  schemaVersion: 2
  manifestSha256: string
  keepers: readonly { taskID: string; owner: Owner }[]
  setSha256: string
}>
type Input = { session: EngineSession; runner: DockerRunner; guard: AuthorityGuard; images: ResolvedImages }
/** Retained, approval-bound read-only keepers are environment deliverables, never silently recreated by verify. */
export async function createDependencyAuditors(input: Input): Promise<DependencyAuditSet> {
  const state = await revalidateSession(input.session)
  requireRealDockerRunner(input.runner)
  await requireOperation(input.session, "dependency-auditor-retain", input.guard)
  const keepers: { taskID: string; owner: Owner }[] = []
  try {
    for (const task of input.images.tasks.filter((t) => t.volumes.length)) {
      if (keepers.length >= 16) throw new TypeError("TASK24_DEPENDENCY_AUDITOR_LIMIT")
      const owner = await createOwnedContainer({
        ...input,
        owner: {
          acceptanceID: input.session.acceptanceID,
          runID: "dependency-auditors",
          attemptID: "audit-" + randomBytes(16).toString("hex"),
          leaseGeneration: 1,
          operationID: "audit-" + task.recipe.recipeSha256.slice(0, 16),
          nonce: randomBytes(16).toString("hex"),
          daemonFingerprint: state.inventory.contextFingerprint,
        },
        spec: {
          image: task.image,
          argv: [
            "/usr/local/bin/node",
            "-e",
            `setTimeout(()=>process.exit(0),${Math.min(2147483647, state.approval.expiresAt - Date.now())});setInterval(()=>{},1000)`,
          ],
          dependencies: task.volumes,
        },
        signal: new AbortController().signal,
      })
      keepers.push({ taskID: task.taskID, owner })
    }
    const body = { schemaVersion: 2 as const, manifestSha256: input.session.manifestSha256, keepers },
      set = freeze({ ...body, setSha256: sha256Text(canonicalJson(body)) })
    await auditDependencySet({ ...input, set, published: false })
    await publishImmutable(
      path.join(state.manifest.roots.evidence, "linux-dependency-auditors.json"),
      canonicalJson(set),
    )
    return set
  } catch (error) {
    await stopDependencyAuditors({
      ...input,
      set: { schemaVersion: 2, manifestSha256: input.session.manifestSha256, keepers, setSha256: "" },
    })
    throw error
  }
}
export async function auditDependencySet(
  input: Input & { set: DependencyAuditSet; published?: false; taskID?: string },
): Promise<readonly EvidenceReference[]> {
  const state = await revalidateSession(input.session),
    set = input.set,
    { setSha256, ...body } = set
  requireRealDockerRunner(input.runner)
  const dep = state.manifest.artifacts.find((a) => a.id === "dependencies")
  if (!dep || !("path" in dep) || !dep.path || !("sha256" in dep))
    throw new TypeError("TASK24_DEPENDENCY_METADATA_BINDING")
  const original = (await readControllerJson(dep.path)) as ResolvedImages
  if (
    sha256Text(canonicalJson(original)) !== dep.sha256 ||
    canonicalJson({ ...original, manifestSha256: input.session.manifestSha256 }) !== canonicalJson(input.images)
  )
    throw new TypeError("TASK24_DEPENDENCY_METADATA_BINDING")
  if (
    set.schemaVersion !== 2 ||
    set.manifestSha256 !== input.session.manifestSha256 ||
    sha256Text(canonicalJson(body)) !== setSha256
  )
    throw new TypeError("TASK24_DEPENDENCY_AUDITOR_STALE")
  const tasks = input.images.tasks.filter((t) => t.volumes.length)
  if (set.keepers.length !== tasks.length || new Set(set.keepers.map((k) => k.taskID)).size !== tasks.length)
    throw new TypeError("TASK24_DEPENDENCY_AUDITOR_COVERAGE")
  const refs: EvidenceReference[] = []
  if (input.published !== false) {
    const file = path.join(state.manifest.roots.evidence, "linux-dependency-auditors.json")
    if (canonicalJson(await readControllerJson(file)) !== canonicalJson(set))
      throw new TypeError("TASK24_DEPENDENCY_AUDITOR_STALE")
    refs.push(bindEvidenceFile(state.manifest.roots.evidence, file, "dependency-auditors"))
  }
  if (input.taskID && !input.images.tasks.some((t) => t.taskID === input.taskID))
    throw new TypeError("TASK24_DEPENDENCY_AUDITOR_TASK")
  for (const keeper of set.keepers.filter((k) => !input.taskID || k.taskID === input.taskID)) {
    await input.guard()
    const task = tasks.find((t) => t.taskID === keeper.taskID)
    if (!task) throw new TypeError("TASK24_DEPENDENCY_AUDITOR_TASK")
    const inspect = await inspectOwnedContainer({ ...input, owner: keeper.owner, signal: new AbortController().signal })
    if (
      !inspect.State.Running ||
      inspect.Config.Image !== task.image ||
      inspect.Mounts.length !== task.volumes.length ||
      task.volumes.some(
        (v) =>
          !inspect.Mounts.some((m) => m.Type === "volume" && m.Name === v.name && m.Destination === v.target && !m.RW),
      )
    )
      throw new TypeError("TASK24_DEPENDENCY_AUDITOR_MOUNTS")
    for (const volume of task.volumes) {
      const r = await input.runner.execute({
        argv: ["volume", "inspect", volume.name, "--format", "{{json .}}"],
        timeoutMs: 15000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        signal: new AbortController().signal,
      })
      if (
        !r.started ||
        r.exitCode ||
        r.truncated ||
        volumeMetadataIdentity(JSON.parse(Buffer.from(r.stdout).toString("utf8"))) !== volume.metadataSha256
      )
        throw new TypeError("TASK24_DEPENDENCY_VOLUME_STALE")
    }
    await requireOperation(input.session, "container-exec", input.guard)
    const argv = [
        "container",
        "exec",
        "--interactive",
        keeper.owner.containerID,
        "/usr/local/bin/node",
        "/opt/task24/audit.mjs",
      ],
      execution = await input.runner.execute({
        argv,
        stdin: Buffer.from(
          canonicalJson({
            volumes: task.volumes.map((v) => ({ name: v.name, target: v.target })),
            maxBytes: 8589934592,
          }),
        ),
        timeoutMs: 300000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        signal: new AbortController().signal,
      })
    if (!execution.started || execution.exitCode || execution.truncated)
      throw new TypeError("TASK24_DEPENDENCY_AUDIT_UNOBSERVED")
    validateDependencyAudit(JSON.parse(Buffer.from(execution.stdout).toString("utf8")), {
      platform: task.platform,
      workerSha256: task.recipe.auditSha256,
      volumes: task.volumes.map((v) => ({ name: v.name, treeSha256: v.treeSha256, fileID: v.fileID })),
    })
    const receipt = await recordOperationReceipt({
      ...input,
      owner: keeper.owner,
      operation: "dependency-reaudit",
      binding: null,
      argv,
      execution,
      inspect: await inspectOwnedContainer({ ...input, owner: keeper.owner, signal: new AbortController().signal }),
      evidenceRoot: state.manifest.roots.evidence,
    })
    if (receipt.assurance !== "linux-attested") throw new TypeError("TASK24_DEPENDENCY_AUDIT_FIXTURE")
    refs.push(receipt.evidence)
  }
  const proof = freeze(refs)
  if (!input.taskID) auditProofs.set(proof, input.session.manifestSha256)
  return proof
}
export async function stopDependencyAuditors(input: Input & { set: DependencyAuditSet }) {
  let uncertain = false
  for (const keeper of input.set.keepers) {
    const r = await cleanupOwnedContainer({ ...input, owner: keeper.owner })
    if (!r.ended || !r.removed) uncertain = true
  }
  if (uncertain) throw new TypeError("TASK24_DEPENDENCY_AUDITOR_CLEANUP_UNCERTAIN")
}
