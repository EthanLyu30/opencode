import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text, sha256Bytes } from "../hash"
import { decodeEvaluationIdentity, safePath, EvaluationIdentityV2 } from "../corpus/evaluation-profile"
import { directRoot } from "../corpus/evaluation-bundle"
import type { BrowserRelease, BrowserRuntimeCaptureInput } from "../evaluator/browser-runtime"
import type { PublishedEvidence } from "../evaluator/capture"
import type { ProbeRequest } from "../evaluator/independent/host"
import { decodeProbeResponse } from "../evaluator/independent/probe"
import { safeRelayPath } from "./relay-protocol"
import type { PreviewLease } from "./preview"
import { makeProcessRunner } from "./docker"
import { fileIdentity } from "./storage"
import type { FileIdentity } from "./contracts"
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
export function requireBrowserTrace(value: object, identity: EvaluationIdentityV2) {
  const trace = traces.get(value)
  if (!trace || canonicalJson(trace.identity) !== canonicalJson(identity))
    throw new TypeError("TASK24_BROWSER_TRACE_AUTHORITY")
  return trace
}

export function isAdmittedLinuxBrowserURL(value: string, base: string, paths: readonly string[]): boolean {
  try {
    const root = new URL(base),
      url = new URL(value)
    safeRelayPath(url.pathname)
    return (
      root.protocol === "http:" &&
      root.hostname === "127.0.0.1" &&
      /^\/[a-f0-9]{64}\/$/.test(root.pathname) &&
      !url.username &&
      !url.password &&
      url.origin === root.origin &&
      url.protocol === "http:" &&
      url.pathname.startsWith(root.pathname) &&
      paths.includes("/" + url.pathname.slice(root.pathname.length)) &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}
export function validateBrowserProbe(request: unknown): asserts request is ProbeRequest {
  const r = Schema.decodeUnknownSync(
    Schema.Struct({
      identity: EvaluationIdentityV2,
      candidate: Schema.Struct({
        archiveFile: Schema.String,
        archiveSha256: Schema.String,
        candidateSha256: Schema.String,
        configSha256: Schema.String,
      }),
      profileSha256: Schema.String,
      timeoutMs: Schema.Literal(30000),
      module: Schema.String,
      inputs: Schema.NonEmptyArray(
        Schema.Struct({
          id: Schema.String,
          fixtures: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
      operations: Schema.NonEmptyArray(
        Schema.Struct({
          id: Schema.String,
          steps: Schema.NonEmptyArray(
            Schema.Struct({
              kind: Schema.Literals(["call", "method", "get"]),
              target: Schema.String,
              args: Schema.Array(Schema.Unknown),
              store: Schema.optionalKey(Schema.String),
            }),
          ),
        }),
      ),
    }),
  )(request, { onExcessProperty: "error" })
  safePath(r.module)
  const target = (name: string) =>
    name.length <= 512 &&
    /^[A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|[0-9]+))*$/.test(name) &&
    !name.split(".").some((p) => ["__proto__", "prototype", "constructor"].includes(p))
  function refs(value: unknown): void {
    if (value && typeof value === "object") {
      if ("$ref" in value) {
        if (Object.keys(value).length !== 1 || typeof value.$ref !== "string" || !target(value.$ref))
          throw new TypeError("TASK24_BROWSER_PROBE_INPUT")
        return
      }
      for (const v of Object.values(value)) refs(v)
    }
  }
  for (const c of r.operations)
    for (const op of c.steps) {
      if (
        !target(op.target) ||
        (op.store !== undefined && (!target(op.store) || op.store.includes("."))) ||
        (op.kind === "get" && op.args.length)
      )
        throw new TypeError("TASK24_BROWSER_PROBE_INPUT")
      refs(op.args)
    }
  if (
    new Set(r.operations.map((c) => c.id)).size !== r.operations.length ||
    canonicalJson(r.inputs.map((c) => c.id)) !== canonicalJson(r.operations.map((c) => c.id))
  )
    throw new TypeError("TASK24_BROWSER_PROBE_INPUT")
  if (
    Buffer.byteLength(canonicalJson(r)) > 1048576 ||
    r.timeoutMs !== 30000 ||
    !r.module ||
    r.module.includes("..") ||
    r.module.startsWith("/") ||
    r.operations.length > 1000
  )
    throw new TypeError("TASK24_BROWSER_PROBE_INPUT")
}
export type LinuxBrowserRelease = Readonly<{ base: BrowserRelease; helper: FileIdentity; fontSha256: string }>
export type LinuxPreviewRegistry = Readonly<{ get(identity: EvaluationIdentityV2): PreviewLease }>
export function makeLinuxBrowser(input: {
  release: LinuxBrowserRelease
  previewRegistry: LinuxPreviewRegistry
  roots: { temp: string; evidence: string; references: string }
  env: Readonly<Record<string, string>>
  requirementPlans: Readonly<Record<string, readonly RequirementProbePlan[]>>
}) {
  const observations = new Map<string, Omit<RequirementObservations, "cases" | "files">>()
  const registered = new Map<string, PreviewLease>(),
    identitiesByPreview = new Map<string, EvaluationIdentityV2>()
  const get = (identity: EvaluationIdentityV2) =>
    registered.get(canonicalJson(identity)) ?? input.previewRegistry.get(identity)
  async function execute(
    identity: EvaluationIdentityV2,
    operation: "capture" | "probe",
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
    const runner = makeProcessRunner({
      executable: input.release.base.nodeExecutable,
      argvPrefix: [],
      cwd: input.roots.temp,
      env: { ...input.env, TEMP: input.roots.temp, TMP: input.roots.temp, NODE_DISABLE_COMPILE_CACHE: "1" },
    })
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
    async observations(identity: EvaluationIdentityV2) {
      const found = observations.get(canonicalJson(identity))
      if (!found) throw new TypeError("TASK24_BROWSER_REQUIREMENTS_UNOBSERVED")
      return found
    },
  }
}
export type LinuxBrowser = ReturnType<typeof makeLinuxBrowser>
