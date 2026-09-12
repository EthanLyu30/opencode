import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { assertReferenceFiles, assertRunRoots, buildLaunchEnvironment } from "./environment"
import type { ArmInput, ArmRoute, WorkflowArmLaunch } from "./types"
import { assertBinaryForArm } from "./upstream"

const sealedRoutes = [
  { role: "design", provider: "kimi", model: "kimi-k3", protocol: "chat_completions", effort: "max" },
  { role: "decompose", provider: "kimi", model: "kimi-k3", protocol: "chat_completions", effort: "high" },
  { role: "implement", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "max" },
  { role: "test", provider: "deepseek", model: "deepseek-v4-flash", protocol: "responses", effort: "high" },
  { role: "visual_review", provider: "kimi", model: "kimi-k3", protocol: "chat_completions", effort: "max" },
  { role: "repair", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "max" },
  { role: "deliver", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "high" },
] as const satisfies readonly ArmRoute[]

export function workflowRoutes(): readonly ArmRoute[] {
  return sealedRoutes.map((route) => Object.freeze({ ...route }))
}

export async function prepareWorkflowArm(input: ArmInput): Promise<WorkflowArmLaunch> {
  if (input.armID !== "A") throw new TypeError("TASK24_WORKFLOW_ARM_INVALID")
  const roots = assertRunRoots(input.roots)
  const binary = assertBinaryForArm(input.armID, input.binary)
  validate(input)
  await assertReferenceFiles(roots, input.referenceFiles)
  const transportFile = path.join(roots.data, "benchmark-transport.json")
  const profile = {
    schemaVersion: 1,
    campaignID: input.campaignID,
    runID: input.runID,
    brokerOrigin: input.brokerOrigin,
    providerPaths: { kimi: "/v1/kimi", deepseek: "/v1/deepseek" },
    expiresAt: input.grantExpiresAt,
    grant: input.brokerGrant,
  }
  await writeStable(transportFile, canonicalJson(profile) + "\n")
  const environment = Object.freeze({
    ...buildLaunchEnvironment({ roots, mode: "workflow", brokerGrant: input.brokerGrant }),
    OPENCODE_BENCHMARK_TRANSPORT_FILE: transportFile,
    OPENCODE_BENCHMARK_RUN_DATA_ROOT: roots.data,
    OPENCODE_BENCHMARK_CAMPAIGN_ID: input.campaignID,
    OPENCODE_BENCHMARK_RUN_ID: input.runID,
  })
  return Object.freeze({
    executable: binary.executable,
    args: Object.freeze(["workflow", "run", input.prompt, "--format", "json"]),
    cwd: roots.repo,
    environment,
    transportFile,
    snapshot: Object.freeze({
      schemaVersion: 1,
      armID: input.armID,
      runtime: binary.runtime,
      mode: "workflow",
      executable: binary.executable,
      executableSha256: binary.sha256,
      version: binary.version,
      cwd: roots.repo,
      roots,
      promptSha256: sha256Text(input.prompt),
      referenceFiles: Object.freeze([...input.referenceFiles]),
      routes: Object.freeze(workflowRoutes()),
      budget: Object.freeze({ ...input.budget }),
      brokerOrigin: input.brokerOrigin,
      brokerGrantSha256: sha256Text(input.brokerGrant),
      expectedOutput: path.join(roots.output, "workflow.json"),
    }),
  })
}

export function collectWorkflowOutput(
  stdout: string,
  evidence: { readonly observedRoutes: readonly ArmRoute[]; readonly deliveryArtifactSha256: string },
): { readonly workflowID: string; readonly responseID: string; readonly artifactSha256: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    throw new TypeError("TASK24_WORKFLOW_OUTPUT_INVALID")
  }
  if (
    !isObject(parsed) ||
    !isObject(parsed.workflow) ||
    !isObject(parsed.response) ||
    !Array.isArray(parsed.artifacts)
  ) {
    throw new TypeError("TASK24_WORKFLOW_OUTPUT_INVALID")
  }
  const workflowID = stringField(parsed.workflow, "id")
  const responseID = stringField(parsed.response, "id")
  if (
    parsed.workflow.status !== "succeeded" ||
    parsed.response.status !== "completed" ||
    parsed.response.workflowID !== workflowID ||
    !parsed.artifacts.some((artifact) => isObject(artifact) && artifact.kind === "workflow.delivery")
  ) {
    throw new TypeError("TASK24_WORKFLOW_NOT_SUCCESSFUL")
  }
  if (!/^[a-f0-9]{64}$/.test(evidence.deliveryArtifactSha256)) {
    throw new TypeError("TASK24_WORKFLOW_ARTIFACT_INVALID")
  }
  const expected = workflowRoutes().map(routeKey).toSorted()
  const observed = evidence.observedRoutes.map(routeKey).toSorted()
  if (canonicalJson(expected) !== canonicalJson(observed)) throw new TypeError("TASK24_WORKFLOW_STAGE_ROUTE_MISMATCH")
  return Object.freeze({ workflowID, responseID, artifactSha256: evidence.deliveryArtifactSha256 })
}

function routeKey(route: ArmRoute): string {
  return `${route.role}/${route.provider}/${route.model}/${route.protocol}/${route.effort}`
}

function validate(input: ArmInput): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.campaignID) || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.runID)) {
    throw new TypeError("TASK24_ARM_IDENTITY_INVALID")
  }
  if (input.prompt.length === 0 || input.brokerGrant.length < 32 || input.grantExpiresAt <= Date.now()) {
    throw new TypeError("TASK24_ARM_AUTHORITY_INVALID")
  }
  for (const value of Object.values(input.budget)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("TASK24_ARM_BUDGET_INVALID")
  }
  const parsed = new URL(input.brokerOrigin)
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port.length === 0 ||
    parsed.origin !== input.brokerOrigin
  ) {
    throw new TypeError("TASK24_BROKER_ORIGIN_INVALID")
  }
}

async function writeStable(file: string, content: string): Promise<void> {
  try {
    await fs.writeFile(file, content, { encoding: "utf8", flag: "wx" })
  } catch (cause) {
    const code = cause !== null && typeof cause === "object" ? Reflect.get(cause, "code") : undefined
    if (code !== "EEXIST" || (await fs.readFile(file, "utf8")) !== content) throw cause
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function stringField(value: Record<string, unknown>, key: string): string {
  const result = value[key]
  if (typeof result !== "string" || result.length === 0) throw new TypeError("TASK24_WORKFLOW_OUTPUT_INVALID")
  return result
}
