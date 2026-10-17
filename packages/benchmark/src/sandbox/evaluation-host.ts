import { canonicalJson } from "../campaign/canonical"
import { freeze, type DependencyResolution, type EvaluationIdentityV2 } from "../corpus/evaluation-profile"
import type { HostManifest } from "./contracts"
import { requireEngineReceipt, type EngineReceipt } from "./engine-evidence"
import { verifyOperationReceipt, requireOperationReceipt, type OperationReceipt } from "./receipt"
import { sha256Text } from "../hash"
import type { LinuxBackend, RawBuild, RawProbe } from "./linux-backend"
import { requireBrowserTrace, type BrowserTrace, type LinuxBrowser } from "./browser"
import { startLinuxPreview, type PreviewLease } from "./preview"
import type {
  EvaluationHost,
  BuildObservation,
  ProbeObservation,
  PreviewObservation,
  CommonRequest,
} from "../evaluator/independent/host"
import type { EvaluationFacts } from "../evaluator/independent/result"
import { requireControllerFacts, type ControllerFacts } from "./controller-facts"
import { verifyEvidenceFile } from "../evaluator/evidence"
import { readFileSync } from "node:fs"
import path from "node:path"

export type LinuxAuthority = Readonly<{ manifestSha256: string; engineReceiptSha256: string }>
const authorities = new WeakMap<
  LinuxAuthority,
  { manifest: HostManifest; engineReceipt: EngineReceipt; evidenceRoot: string }
>()
export function authorizeLinuxHost(input: {
  manifest: HostManifest
  engineReceipt: EngineReceipt
  evidenceRoot: string
}): LinuxAuthority {
  requireEngineReceipt(input.engineReceipt, input.manifest)
  for (const c of input.engineReceipt.checks)
    verifyOperationReceipt({ receipt: c.receipt, manifest: input.manifest, evidenceRoot: input.evidenceRoot })
  const authority = freeze({
    manifestSha256: sha256Text(canonicalJson(input.manifest)),
    engineReceiptSha256: input.engineReceipt.receiptSha256,
  })
  authorities.set(authority, input)
  return authority
}
export function requireLinuxAuthority(authority: LinuxAuthority) {
  const state = authorities.get(authority)
  if (!state) throw new TypeError("TASK24_LINUX_AUTHORITY")
  requireEngineReceipt(state.engineReceipt, state.manifest)
  for (const c of state.engineReceipt.checks)
    verifyOperationReceipt({ receipt: c.receipt, manifest: state.manifest, evidenceRoot: state.evidenceRoot })
  return state
}
const observations = new WeakMap<
  object,
  {
    authority: LinuxAuthority
    request: CommonRequest
    receipts: readonly OperationReceipt[]
    browserTrace?: BrowserTrace
  }
>()
const hosts = new WeakMap<EvaluationHost, { authority: LinuxAuthority; backend: LinuxBackend }>()
export function requireLinuxHost(host: EvaluationHost) {
  const state = hosts.get(host)
  if (!state) throw new TypeError("TASK24_LINUX_HOST_AUTHORITY")
  requireLinuxAuthority(state.authority)
  return state
}
export function requireLinuxObservation(observation: object) {
  const binding = observations.get(observation)
  if (!binding) throw new TypeError("TASK24_LINUX_OBSERVATION_AUTHORITY")
  const state = requireLinuxAuthority(binding.authority)
  for (const receipt of binding.receipts) {
    requireOperationReceipt(receipt)
    verifyOperationReceipt({ receipt, manifest: state.manifest, evidenceRoot: state.evidenceRoot })
    if (
      receipt.assurance !== "linux-attested" ||
      receipt.binding?.candidateSha256 !== binding.request.candidate.candidateSha256 ||
      receipt.binding.configSha256 !== binding.request.candidate.configSha256 ||
      receipt.binding.profileSha256 !== binding.request.profileSha256 ||
      receipt.owner.runID !== binding.request.identity.runID ||
      receipt.owner.attemptID !== binding.request.identity.attemptID ||
      receipt.owner.leaseGeneration !== binding.request.identity.leaseGeneration
    )
      throw new TypeError("TASK24_LINUX_OBSERVATION_BINDING")
  }
  return binding
}
export function makeLinuxEvaluationHost(input: {
  backend: LinuxBackend
  authority: LinuxAuthority
  browser: LinuxBrowser
}): EvaluationHost & { receipts(): readonly OperationReceipt[]; dispose(): Promise<void> } {
  const state = requireLinuxAuthority(input.authority),
    leases = new Map<string, PreviewLease>(),
    builds = new Map<string, BuildObservation>()
  if (state.manifest.phase !== "accept") throw new TypeError("TASK24_LINUX_HOST_PHASE")
  if (
    input.backend.session.manifestSha256 !== input.authority.manifestSha256 ||
    input.browser.browserSha256 !== state.manifest.artifacts.find((a) => a.id === "browser")?.sha256 ||
    input.browser.fontSha256 !== state.manifest.artifacts.find((a) => a.id === "fonts")?.sha256
  )
    throw new TypeError("TASK24_LINUX_HOST_RUNTIME")
  function bind<
    T extends
      | RawBuild["payload"]
      | RawProbe["payload"]
      | {
          kind: "ok"
          handle: string
          buildSha256: string
          browserSha256: string
          fontSha256: string
          previewID: string
        },
  >(request: CommonRequest, payload: T, receipts: readonly OperationReceipt[], browserTrace?: BrowserTrace) {
    const result = freeze({
      ...payload,
      identity: request.identity,
      candidate: request.candidate,
      profileSha256: request.profileSha256,
      assurance: "linux-attested" as const,
      hostReceiptSha256: sha256Text(
        canonicalJson({
          engine: input.authority.engineReceiptSha256,
          receipts: receipts.map((r) => r.receiptSha256),
          payload,
        }),
      ),
    })
    observations.set(result, {
      authority: input.authority,
      request,
      receipts,
      ...(browserTrace ? { browserTrace } : {}),
    })
    requireLinuxObservation(result)
    return result
  }
  const host = {
    async build(request: Parameters<EvaluationHost["build"]>[0]) {
      const raw = await input.backend.build(request)
      const value = bind(request, raw.payload, [raw.receipt])
      builds.set(canonicalJson(request.identity), value)
      return value
    },
    async probe(request: Parameters<EvaluationHost["probe"]>[0]) {
      const mode = input.backend.probeMode(request)
      if (mode === "browser") {
        const profile = input.backend.describe(request),
          built = builds.get(canonicalJson(request.identity))
        if (!profile.preview || !built || built.kind !== "ok") throw new TypeError("TASK24_LINUX_PROBE_BUILD_REQUIRED")
        if (!leases.has(canonicalJson(request.identity)))
          await host.preview({ ...request, build: built.build, preview: profile.preview })
        const response = await input.browser.probe(request)
        const trace = requireBrowserTrace(response, request.identity)
        if (trace.browserSha256 !== input.browser.browserSha256 || trace.fontSha256 !== input.browser.fontSha256)
          throw new TypeError("TASK24_BROWSER_TRACE_RUNTIME")
        return bind(
          request,
          { kind: "ok" as const, response },
          input.backend
            .receipts()
            .filter(
              (r) => r.owner.runID === request.identity.runID && r.owner.attemptID === request.identity.attemptID,
            ),
          trace,
        )
      }
      const raw = await input.backend.probe(request)
      return bind(request, raw.payload, [raw.receipt])
    },
    async preview(request: Parameters<EvaluationHost["preview"]>[0]): Promise<PreviewObservation> {
      const source = await input.backend.previewSource(request),
        lease = await startLinuxPreview({
          source,
          policy: { methods: ["GET", "HEAD", "POST"], paths: source.files.map((f) => "/" + f.path) },
          guard: async () => {
            requireLinuxAuthority(input.authority)
          },
          signal: new AbortController().signal,
        })
      leases.set(canonicalJson(request.identity), lease)
      input.browser.register(request.identity, lease)
      return bind(
        request,
        {
          kind: "ok",
          handle: lease.url + request.preview.entry,
          previewID: lease.previewID,
          buildSha256: request.build.buildSha256,
          browserSha256: input.browser.browserSha256,
          fontSha256: input.browser.fontSha256,
        },
        input.backend.receipts().filter((r) => r.binding?.candidateSha256 === request.candidate.candidateSha256),
      )
    },
    receipts: input.backend.receipts,
    async dispose() {
      for (const lease of leases.values()) await lease.stop()
      await input.backend.dispose()
    },
  }
  hosts.set(host, { authority: input.authority, backend: input.backend })
  return host
}
export type LinuxResultProof = Readonly<{
  manifestSha256: string
  engineReceiptSha256: string
  operations: readonly OperationReceipt[]
  browserOperations: readonly BrowserTrace[]
}>
const factsIssued = new WeakMap<EvaluationFacts, { authority: LinuxAuthority; proof: LinuxResultProof }>()
const resultAuthorities = new WeakMap<object, LinuxAuthority>()
export function bindLinuxEvaluationFacts(
  facts: EvaluationFacts,
  authority: LinuxAuthority,
  controller: ControllerFacts,
  observed: readonly (BuildObservation | ProbeObservation | PreviewObservation)[],
) {
  requireLinuxAuthority(authority)
  requireControllerFacts(controller)
  if (facts.assurance !== "linux-attested" || !observed.length) throw new TypeError("TASK24_LINUX_FACTS_AUTHORITY")
  for (const observation of observed) {
    const binding = requireLinuxObservation(observation)
    if (binding.authority !== authority || canonicalJson(binding.request.identity) !== canonicalJson(facts.identity))
      throw new TypeError("TASK24_LINUX_FACTS_IDENTITY")
  }
  const value = freeze(facts)
  const operations = [
    ...new Map(observed.flatMap((o) => requireLinuxObservation(o).receipts).map((r) => [r.receiptSha256, r])).values(),
  ]
  const browserOperations = observed.flatMap((o) => {
    const trace = requireLinuxObservation(o).browserTrace
    return trace ? [trace] : []
  })
  factsIssued.set(value, {
    authority,
    proof: freeze({
      manifestSha256: authority.manifestSha256,
      engineReceiptSha256: authority.engineReceiptSha256,
      operations,
      browserOperations,
    }),
  })
  return value
}
export function requireLinuxFacts(facts: EvaluationFacts) {
  const state = factsIssued.get(facts)
  if (!state) throw new TypeError("TASK24_LINUX_FACTS_AUTHORITY")
  requireLinuxAuthority(state.authority)
  return state
}
export function linuxFactsProof(facts: EvaluationFacts) {
  return requireLinuxFacts(facts).proof
}
export function bindLinuxResult(result: object, facts: EvaluationFacts) {
  resultAuthorities.set(result, requireLinuxFacts(facts).authority)
}
export function linuxResultAuthority(result: object) {
  const authority = resultAuthorities.get(result)
  if (!authority) throw new TypeError("TASK24_LINUX_RESULT_AUTHORITY")
  return authority
}
export function verifyLinuxResultProof(
  proof: LinuxResultProof,
  authority: LinuxAuthority | undefined,
  identity: EvaluationIdentityV2,
) {
  if (!authority) throw new TypeError("TASK24_LINUX_RESULT_AUTHORITY")
  const state = requireLinuxAuthority(authority)
  if (
    proof.manifestSha256 !== authority.manifestSha256 ||
    proof.engineReceiptSha256 !== authority.engineReceiptSha256 ||
    !proof.operations.length ||
    new Set(proof.operations.map((r) => r.receiptSha256)).size !== proof.operations.length
  )
    throw new TypeError("TASK24_LINUX_RESULT_PROOF")
  for (const r of proof.operations) {
    verifyOperationReceipt({ receipt: r, manifest: state.manifest, evidenceRoot: state.evidenceRoot })
    if (
      r.assurance !== "linux-attested" ||
      r.owner.runID !== identity.runID ||
      r.owner.attemptID !== identity.attemptID ||
      r.owner.leaseGeneration !== identity.leaseGeneration ||
      r.binding?.candidateSha256 !== identity.candidateSha256 ||
      r.binding.profileSha256 !== identity.profileSha256
    )
      throw new TypeError("TASK24_LINUX_RESULT_PROOF")
  }
  for (const trace of proof.browserOperations) {
    verifyEvidenceFile(state.evidenceRoot, trace.evidence)
    const { evidence, ...body } = trace
    if (
      canonicalJson(JSON.parse(readFileSync(path.join(state.evidenceRoot, evidence.relativePath), "utf8"))) !==
        canonicalJson(body) ||
      canonicalJson(trace.identity) !== canonicalJson(identity)
    )
      throw new TypeError("TASK24_LINUX_BROWSER_PROOF")
  }
}
export type LinuxProof = Readonly<{ authority: LinuxAuthority; receipts: readonly OperationReceipt[] }>
