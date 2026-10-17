import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { evaluationCatalogue } from "../corpus/evaluation-catalogue"
import { decodeHostRequest, decodeHostManifest, decodeEngineApproval, requestOf, requireDPath } from "./contracts"
import { makeDockerRunner } from "./docker"
import { inspectLinuxHost, openLinuxSession, revalidateSession } from "./preflight"
import { StorageSource, makeStorageProbe } from "./storage-source"
import {
  planLinuxPreparation,
  prepareLinuxArtifacts,
  type PreparationArtifact,
  type PreparationPlan,
} from "./dependencies"
import { readControllerJson, publishLinuxReadiness, verifyLinuxReadiness } from "./readiness"
import { verifyControllerIdentity } from "./controller-identity"
import { publishImmutable } from "../offline/atomic"
export { verifyLinuxReadiness } from "./readiness"
const modes = ["inspect", "plan-preparation", "prepare", "accept", "calibrate", "verify"] as const
const flags = ["root", "request", "manifest", "approval", "storage-source", "artifacts", "plan"] as const
const initial = {
  software_complete: true,
  engine_verified: false,
  capabilities_verified: false,
  corpus_engine_ready: false,
}
export async function runLinuxHostCommand(argv: readonly string[]): Promise<{ exitCode: 0 | 1 | 2; output: unknown }> {
  const response = (exitCode: 0 | 1 | 2, code: string, extra: Record<string, unknown> = {}) => ({
    exitCode,
    output: { ...initial, code, ...extra },
  })
  const mode = argv[0]
  if (!mode) return response(2, "operation_required", { operations: modes })
  if (!modes.includes(mode as (typeof modes)[number])) return response(1, "unknown_operation")
  const args: Record<string, string> = {}
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i]!,
      value = argv[i + 1]
    if (
      !flag.startsWith("--") ||
      !flags.includes(flag.slice(2) as (typeof flags)[number]) ||
      !value ||
      value.startsWith("--") ||
      Object.hasOwn(args, flag.slice(2))
    )
      return response(1, "invalid_arguments")
    args[flag.slice(2)] = value
  }
  const allowed =
    mode === "inspect"
      ? ["request", "storage-source"]
      : mode === "plan-preparation"
        ? ["request", "storage-source", "artifacts", "root"]
        : mode === "prepare"
          ? ["manifest", "approval", "storage-source", "plan", "root"]
          : ["manifest", "approval", "storage-source", "root"]
  if (Object.keys(args).some((k) => !allowed.includes(k))) return response(1, "invalid_arguments")
  const required =
    mode === "inspect"
      ? ["request", "storage-source"]
      : mode === "plan-preparation"
        ? ["request", "storage-source", "artifacts", "root"]
        : mode === "prepare"
          ? ["manifest", "approval", "storage-source", "plan", "root"]
          : ["manifest", "approval", "storage-source", "root"]
  if (required.some((k) => !args[k]))
    return response(2, "explicit_inputs_required", { missing: required.filter((k) => !args[k]) })
  try {
    for (const value of Object.values(args)) requireDPath(value)
    const manifest = args.manifest ? decodeHostManifest(await readControllerJson(args.manifest)) : undefined
    const request = manifest ? requestOf(manifest) : decodeHostRequest(await readControllerJson(args.request!))
    if (manifest && args.root !== manifest.roots.evidence) return response(2, "evidence_root_mismatch")
    const source = Schema.decodeUnknownSync(StorageSource)(await readControllerJson(args["storage-source"]!), {
        onExcessProperty: "error",
      }),
      storageProbe = makeStorageProbe({ request, source }),
      readRunner = makeDockerRunner({ request })
    const inventory = await inspectLinuxHost({ request, runner: readRunner, storageProbe })
    if (mode === "inspect")
      return response(2, inventory.missing.length ? "inventory_blocked" : "inventory_observed_not_accepted", {
        requestSha256: inventory.requestSha256,
        contextFingerprint: inventory.contextFingerprint,
        missing: inventory.missing,
      })
    if (mode === "plan-preparation") {
      const available = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(
        await readControllerJson(args.artifacts!),
      ) as readonly PreparationArtifact[]
      const plan = planLinuxPreparation({ request, inventory, catalogue: evaluationCatalogue(), available })
      const file = path.join(args.root!, `preparation-${plan.planSha256}.json`)
      await publishImmutable(file, canonicalJson(plan))
      return response(2, "preparation_requires_separate_approval", {
        planSha256: plan.planSha256,
        ready: plan.ready,
        missing: plan.missing,
        maxDiskBytes: plan.maxDiskBytes,
      })
    }
    if (!manifest) return response(2, "manifest_required")
    const approval = decodeEngineApproval(await readControllerJson(args.approval!)),
      opened = openLinuxSession({ manifest, approval, inventory })
    if (opened.kind !== "ready") return response(2, opened.code, { missing: opened.missing })
    const session = opened.value
    await verifyControllerIdentity(manifest)
    if (mode === "verify") {
      // Dynamic runtime inspection verifies browser/font/config/dependency identities without executing them.
      const { openLinuxRuntime } = await import("./runtime")
      const runtime = await openLinuxRuntime(session)
      await runtime.guard()
      const result = await verifyLinuxReadiness({ root: args.root!, manifest, session })
      return result.kind === "ready"
        ? response(0, "ready", { engine_verified: true, capabilities_verified: true, corpus_engine_ready: true })
        : response(2, result.code, { missing: result.missing })
    }
    if (mode === "prepare") {
      if (manifest.phase !== "prepare") return response(2, "prepare_manifest_required")
      const plan = (await readControllerJson(args.plan!)) as PreparationPlan
      const runner = makeDockerRunner({
        request,
        session,
        guard: async () => {
          await revalidateSession(session)
        },
      })
      const images = await prepareLinuxArtifacts({
        session,
        approval,
        plan,
        runner,
        guard: async () => {
          await revalidateSession(session)
          await verifyControllerIdentity(manifest)
        },
      })
      await publishImmutable(
        path.join(args.root!, `dependencies-${sha256Text(canonicalJson(images))}.json`),
        canonicalJson(images),
      )
      return response(2, "artifacts_prepared_acceptance_not_run", { taskCount: images.tasks.length })
    }
    if (manifest.phase !== "accept") return response(2, "accept_manifest_required")
    const { openLinuxRuntime } = await import("./runtime"),
      runtime = await openLinuxRuntime(session)
    if (mode === "accept") {
      const result = await runtime.accept()
      return result.status === "passed"
        ? response(2, "engine_and_capabilities_verified_calibration_not_run", {
            engine_verified: true,
            capabilities_verified: true,
          })
        : response(result.status === "failed" ? 1 : 2, "acceptance_" + result.status, {
            checks: result.checks.map((c) => ({ id: c.id, status: c.status, code: c.code })),
          })
    }
    const report = await runtime.calibrate()
    if (!report.corpusEngineReady)
      return response(1, "calibration_incomplete", {
        realEvaluations: report.realEvaluations,
        unobservedCount: report.unobservedRequiredChecks.length,
      })
    const result = await publishLinuxReadiness({ root: args.root!, manifest, session })
    return result.kind === "ready"
      ? response(0, "ready", {
          engine_verified: true,
          capabilities_verified: true,
          corpus_engine_ready: true,
          realEvaluations: 120,
        })
      : response(2, result.code, { missing: result.missing })
  } catch (error) {
    return response(
      2,
      error instanceof TypeError && /^TASK24_[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "explicit_inputs_or_environment_not_verified",
    )
  }
}
