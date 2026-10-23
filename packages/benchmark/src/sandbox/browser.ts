import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text, sha256Bytes } from "../hash"
import { decodeEvaluationIdentity, type EvaluationIdentityV2 } from "../corpus/evaluation-profile"
import { directRoot } from "../corpus/evaluation-bundle"
import { loadBrowserRelease, type BrowserRelease, type BrowserRuntimeCaptureInput } from "../evaluator/browser-runtime"
import type { PublishedEvidence } from "../evaluator/capture"
import type { ProbeRequest } from "../evaluator/independent/host"
import { decodeProbeResponse } from "../evaluator/independent/probe"
import { isAdmittedLinuxBrowserURL, validateBrowserProbe, validateBrowserAdmission } from "./browser-contracts"
export {
  isAdmittedLinuxBrowserURL,
  validateBrowserProbe,
  validateBrowserAdmission,
  dataFrameWasBlocked,
} from "./browser-contracts"
import type { PreviewLease } from "./preview"
import { requireBrowserIsolationRunner } from "./capability"
import { fileIdentity } from "./storage"
import type { FileIdentity, DockerRunner } from "./contracts"
import type { RequirementProbePlan, RequirementObservations } from "./controller-facts"
import { publishImmutable } from "../offline/atomic"
import { bindEvidenceFile, type EvidenceReference } from "../evaluator/evidence"
export type BrowserTrace = Readonly<{
  identity: EvaluationIdentityV2
  previewID: string
  browserSha256: string
  fontSha256: string
  helperSha256: string
  resultSha256: string
  evidence: EvidenceReference
}>
const traces = new WeakMap<object, BrowserTrace>()
export function loadLinuxBrowserRelease(root: string, expectedSha256: string) {
  const release = loadBrowserRelease(root, { readOnly: true })
  if (release.buildSha256 !== expectedSha256) throw new TypeError("TASK24_RUNTIME_BROWSER")
  return release
}
export async function verifyBrowserFileInventory(files: readonly FileIdentity[]) {
  for (const file of files)
    if (canonicalJson(await fileIdentity(file.path)) !== canonicalJson(file))
      throw new TypeError("TASK24_BROWSER_FILE_DRIFT")
}
export function requireBrowserTrace(value: object, identity: EvaluationIdentityV2) {
  const trace = traces.get(value)
  if (!trace || canonicalJson(trace.identity) !== canonicalJson(identity))
    throw new TypeError("TASK24_BROWSER_TRACE_AUTHORITY")
  return trace
}
export type LinuxBrowserRelease = Readonly<{ base: BrowserRelease; helper: FileIdentity; fontSha256: string }>
export type LinuxPreviewRegistry = Readonly<{ get(identity: EvaluationIdentityV2): PreviewLease }>
export function makeLinuxBrowser(input: {
  release: LinuxBrowserRelease
  previewRegistry: LinuxPreviewRegistry
  roots: { temp: string; evidence: string; references: string }
  env: Readonly<Record<string, string>>
  requirementPlans: Readonly<Record<string, readonly RequirementProbePlan[]>>
  runner?: (lease: PreviewLease) => Promise<DockerRunner>
}) {
  const observations = new Map<string, Omit<RequirementObservations, "cases" | "files">>()
  const registered = new Map<string, PreviewLease>(),
    identitiesByPreview = new Map<string, EvaluationIdentityV2>()
  const get = (identity: EvaluationIdentityV2) =>
    registered.get(canonicalJson(identity)) ?? input.previewRegistry.get(identity)
  async function execute(
    identity: EvaluationIdentityV2,
    operation: "capture" | "probe" | "admission",
    data: unknown,
    signal: AbortSignal,
  ) {
    input.release.base.verify()
    if (canonicalJson(await fileIdentity(input.release.helper.path)) !== canonicalJson(input.release.helper))
      throw new TypeError("TASK24_BROWSER_HELPER_DRIFT")
    const lease = get(identity),
      paths = lease.assets.map((f) => "/" + f.path)
    await directRoot(input.roots.temp)
    await directRoot(input.roots.evidence)
    if (!input.runner) throw new TypeError("TASK24_BROWSER_OS_ISOLATION_REQUIRED")
    const runner = await input.runner(lease)
    requireBrowserIsolationRunner(runner)
    const result = await runner.execute({
      argv: [input.release.helper.path],
      stdin: Buffer.from(
        canonicalJson({
          schemaVersion: 2,
          operation,
          identity,
          base: lease.url,
          previewID: lease.previewID,
          paths,
          browser: input.release.base.browserExecutable,
          temp: input.roots.temp,
          evidence: input.roots.evidence,
          plans: input.requirementPlans[identity.taskID] ?? [],
          data,
        }),
      ),
      timeoutMs: 30000,
      maxStdoutBytes: 2097152,
      maxStderrBytes: 65536,
      signal,
    })
    input.release.base.verify()
    if (!result.started || result.exitCode !== 0 || result.truncated) throw new TypeError("TASK24_BROWSER_V2_TRANSPORT")
    if (canonicalJson(await fileIdentity(input.release.helper.path)) !== canonicalJson(input.release.helper))
      throw new TypeError("TASK24_BROWSER_HELPER_DRIFT")
    const reply = Schema.decodeUnknownSync(
      Schema.Struct({
        identity: Schema.Unknown,
        previewID: Schema.String,
        operation: Schema.String,
        result: Schema.Unknown,
        observations: Schema.Unknown,
      }),
    )(JSON.parse(Buffer.from(result.stdout).toString("utf8")), { onExcessProperty: "error" })
    if (
      canonicalJson(reply.identity) !== canonicalJson(identity) ||
      reply.previewID !== lease.previewID ||
      reply.operation !== operation
    )
      throw new TypeError("TASK24_BROWSER_V2_IDENTITY")
    const observed = Schema.decodeUnknownSync(
      Schema.Struct({
        dom: Schema.Array(
          Schema.Struct({ selector: Schema.String, count: Schema.Int, text: Schema.String, visible: Schema.Boolean }),
        ),
        interactions: Schema.Array(Schema.Struct({ name: Schema.String, passed: Schema.Boolean })),
      }),
    )(reply.observations, { onExcessProperty: "error" })
    observations.set(canonicalJson(identity), observed)
    if (!reply.result || typeof reply.result !== "object") throw new TypeError("TASK24_BROWSER_V2_RESULT")
    const body = {
      identity,
      previewID: lease.previewID,
      browserSha256: input.release.base.buildSha256,
      fontSha256: input.release.fontSha256,
      helperSha256: input.release.helper.sha256,
      resultSha256: sha256Text(canonicalJson(reply.result)),
    }
    const file = path.join(input.roots.evidence, "browser-trace-" + sha256Text(canonicalJson(body)) + ".json")
    await publishImmutable(file, canonicalJson(body))
    traces.set(reply.result, { ...body, evidence: bindEvidenceFile(input.roots.evidence, file, "browser-trace") })
    return reply.result
  }
  return {
    referenceRoot: input.roots.references,
    evidenceRoot: input.roots.evidence,
    browserSha256: input.release.base.buildSha256,
    fontSha256: input.release.fontSha256,
    runtime: {
      async capture(r: BrowserRuntimeCaptureInput): Promise<PublishedEvidence> {
        const identities = identitiesByPreview.get(r.previewID)
        if (
          !identities ||
          r.runID !== identities.runID ||
          !isAdmittedLinuxBrowserURL(
            r.previewURL,
            get(identities).url,
            get(identities).assets.map((f) => "/" + f.path),
          )
        )
          throw new TypeError("TASK24_BROWSER_CAPTURE_BINDING")
        const { signal, ...capture } = r
        const raw = await execute(identities, "capture", capture, signal)
        const value = Schema.decodeUnknownSync(
          Schema.Struct({
            root: Schema.String,
            screenshot: Schema.String,
            evidence: Schema.String,
            screenshotSha256: Schema.String,
            evidenceSha256: Schema.String,
            screenshotBytes: Schema.Int,
          }),
        )(raw, { onExcessProperty: "error" })
        for (const file of [value.screenshot, value.evidence])
          if (!file.startsWith(input.roots.evidence + path.sep)) throw new TypeError("TASK24_BROWSER_CAPTURE_ROOT")
        const png = await fs.readFile(value.screenshot),
          json = await fs.readFile(value.evidence)
        if (
          sha256Bytes(png) !== value.screenshotSha256 ||
          sha256Bytes(json) !== value.evidenceSha256 ||
          png.length !== value.screenshotBytes
        )
          throw new TypeError("TASK24_BROWSER_CAPTURE_HASH")
        traces.set(value, requireBrowserTrace(raw as object, identities))
        return value
      },
    },
    register(identity: EvaluationIdentityV2, lease: PreviewLease) {
      registered.set(canonicalJson(identity), lease)
      identitiesByPreview.set(lease.previewID, decodeEvaluationIdentity(identity))
    },
    async probe(request: ProbeRequest) {
      validateBrowserProbe(request)
      const raw = await execute(request.identity, "probe", request, new AbortController().signal),
        response = decodeProbeResponse(Buffer.from(canonicalJson(raw)))
      traces.set(response, requireBrowserTrace(raw as object, request.identity))
      return response
    },
    async admission(identity: EvaluationIdentityV2, data: ReturnType<typeof validateBrowserAdmission>) {
      const raw = await execute(identity, "admission", validateBrowserAdmission(data), new AbortController().signal)
      const result = Schema.decodeUnknownSync(
        Schema.Struct({
          networkBlocked: Schema.Boolean,
          websocketBlocked: Schema.Boolean,
          fileBlocked: Schema.Boolean,
          dataBlocked: Schema.Boolean,
          crossCapabilityBlocked: Schema.Boolean,
          blockedRequests: Schema.Int,
          deniedCanaryAttempts: Schema.optionalKey(Schema.Int),
        }),
      )(raw, { onExcessProperty: "error" })
      traces.set(result, requireBrowserTrace(raw, identity))
      return result
    },
    async observations(identity: EvaluationIdentityV2) {
      const found = observations.get(canonicalJson(identity))
      if (!found) throw new TypeError("TASK24_BROWSER_REQUIREMENTS_UNOBSERVED")
      return found
    },
  }
}
export type LinuxBrowser = ReturnType<typeof makeLinuxBrowser>
