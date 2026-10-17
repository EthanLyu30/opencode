import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../campaign/canonical"
import {
  directRoot,
  loadEvaluationBundle,
  ordinaryFiles,
  exportPublicTask,
  type ValidatedEvaluationBundle,
} from "../../corpus/evaluation-bundle"
import { decodeEvaluationIdentity, freeze, type EvaluationIdentityV2 } from "../../corpus/evaluation-profile"
import { sha256Text } from "../../hash"
import { publishImmutable } from "../../offline/atomic"
import { bindEvidenceFile, verifyEvidenceFile, type EvidenceReference } from "../evidence"
import { evaluateFunctional } from "./functional"
import { makeProbeRequest, type ProbeResponse } from "./probe"
import {
  makeUnavailableEvaluationHost,
  validateObservation,
  type BuildRequest,
  type CandidateReference,
  type EvaluationHost,
} from "./host"
import { scoreIndependentEvaluation, type EvaluationFacts, type IndependentResult } from "./result"
import { disjoint, verifyCandidate, type CandidateSnapshot } from "./snapshot"
import { evaluateVisual, type IndependentBrowser } from "./visual"
import { evaluateLinux, type LinuxEvaluateInput } from "../../sandbox/linux-evaluator"
import type { ControllerFactsObserver } from "../../sandbox/controller-facts"

export type EvaluateInput = Readonly<{
  bundle: ValidatedEvaluationBundle
  snapshot: CandidateSnapshot
  identity: EvaluationIdentityV2
  evidenceRoot: string
  facts: Pick<EvaluationFacts, "requirements" | "quality" | "policy" | "runtime">
}>
export type EvaluationOutcome =
  | Readonly<{ kind: "evaluated"; result: IndependentResult }>
  | Readonly<{ kind: "blocked"; reason: string }>
  | Readonly<{ kind: "harness_error"; code: string }>
const contexts = new WeakMap<object, EvaluateInput | LinuxEvaluateInput>()
export function evaluationContext(outcome: EvaluationOutcome): EvaluateInput | LinuxEvaluateInput {
  const context = contexts.get(outcome)
  if (outcome.kind !== "evaluated" || !context) throw new TypeError("TASK24_OUTCOME_UNVALIDATED")
  return context
}
export async function verifyEvaluationContext(input: Omit<EvaluateInput, "facts">): Promise<void> {
  exportPublicTask(input.bundle)
  await verifyCandidate(input.snapshot)
  const current = await loadEvaluationBundle(input.bundle.root)
  if (current.bundleSha256 !== input.bundle.bundleSha256) throw new TypeError("TASK24_BUNDLE_DRIFT")
  await ordinaryFiles(input.evidenceRoot)
}
export function makeIndependentEvaluator(options: {
  host?: EvaluationHost
  browser?: IndependentBrowser
  controllerFactsObserver?: ControllerFactsObserver
}): {
  evaluate(input: EvaluateInput | LinuxEvaluateInput): Promise<EvaluationOutcome>
} {
  return {
    async evaluate(input) {
      if ("dependency" in input) {
        const outcome = await evaluateLinux(input, options)
        if (outcome.kind === "evaluated") contexts.set(outcome, input)
        return outcome
      }
      try {
        if (Object.keys(input).some((k) => !["bundle", "snapshot", "identity", "evidenceRoot", "facts"].includes(k)))
          throw new TypeError("TASK24_EVALUATE_INPUT_INVALID")
        const identity = decodeEvaluationIdentity(input.identity),
          { bundle, snapshot } = input
        if (
          identity.taskID !== bundle.profile.taskID ||
          identity.profileSha256 !== bundle.profileSha256 ||
          identity.oracleSha256 !== bundle.oracleSha256 ||
          identity.seedSha256 !== bundle.seedSha256 ||
          identity.candidateSha256 !== snapshot.candidateSha256
        )
          throw new TypeError("TASK24_EVALUATE_IDENTITY_INVALID")
        await directRoot(input.evidenceRoot)
        for (const root of [snapshot.sourceRoot, snapshot.workRoot, bundle.root])
          if (!disjoint(input.evidenceRoot, root)) throw new TypeError("TASK24_EVIDENCE_ROOT_OVERLAP")
        await verifyEvaluationContext(input)
        const required = bundle.oracle.requirements
        if (
          input.facts.requirements.artifacts.length ||
          required.length !== input.facts.requirements.assertions.length ||
          required.some((r, i) => {
            const observed = input.facts.requirements.assertions[i]
            return (
              !observed || r.id !== observed.id || r.mandatory !== observed.mandatory || r.weight !== observed.weight
            )
          })
        )
          throw new TypeError("TASK24_REQUIREMENT_COVERAGE_INVALID")
        if (bundle.oracle.quality.some((id) => !input.facts.quality.checks.some((c) => c.id === id)))
          throw new TypeError("TASK24_QUALITY_COVERAGE_INVALID")
        const policyChecks =
          (input.facts.policy as typeof input.facts.policy & { checks?: readonly { id: string; observed: boolean }[] })
            .checks ?? []
        if (
          bundle.oracle.policy.length !== policyChecks.length ||
          bundle.oracle.policy.some((id, i) => policyChecks[i]?.id !== id || policyChecks[i]?.observed !== true)
        )
          throw new TypeError("TASK24_POLICY_COVERAGE_INVALID")
        for (const protectedPath of bundle.profile.protectedPaths) {
          const publicFile = bundle.profile.publicInputs.find((f) => f.path === `public/${protectedPath}`),
            file = snapshot.entries.find((f) => f.path === protectedPath)
          if (!publicFile || file?.sha256 !== publicFile.sha256) throw new TypeError("TASK24_PROTECTED_FILE_DRIFT")
        }
        for (const name of ["requirements", "quality", "policy", "runtime"] as const) {
          const { evidence, ...observed } = input.facts[name]
          if (!evidence.length) throw new TypeError("TASK24_CONTROLLER_EVIDENCE_REQUIRED")
          for (const ref of evidence) {
            verifyEvidenceFile(input.evidenceRoot, ref)
            const record = JSON.parse(
              await fs.readFile(path.join(input.evidenceRoot, ref.relativePath), "utf8"),
            ) as Record<string, unknown>
            if (
              record.schemaVersion !== 2 ||
              record.kind !== "controller-facts" ||
              canonicalJson(record.identity) !== canonicalJson(identity) ||
              canonicalJson(record[name]) !== canonicalJson(observed)
            )
              throw new TypeError("TASK24_CONTROLLER_EVIDENCE_IDENTITY_INVALID")
          }
        }
        if (bundle.profile.dependency.kind !== "none") return { kind: "blocked", reason: "DEPENDENCY_UNRESOLVED" }
        if (!options.host) return { kind: "blocked", reason: "EVALUATION_HOST_UNAVAILABLE" }
        const host = options.host ?? makeUnavailableEvaluationHost()
        const candidate: CandidateReference = {
          archiveFile: snapshot.archiveFile,
          archiveSha256: snapshot.archiveSha256,
          candidateSha256: snapshot.candidateSha256,
          configSha256: snapshot.configSha256,
        }
        const common = { identity, candidate, profileSha256: bundle.profileSha256, timeoutMs: 30000 }
        const request: BuildRequest = { ...common, commands: bundle.profile.checks, dependency: { kind: "none" } }
        const built = await host.build(freeze(request))
        validateObservation(request, built)
        if (built.kind === "unavailable") return { kind: "blocked", reason: "EVALUATION_HOST_UNAVAILABLE" }
        await verifyEvaluationContext(input)
        async function record(label: string, value: unknown): Promise<readonly EvidenceReference[]> {
          const file = path.join(input.evidenceRoot, `${label}.json`)
          await publishImmutable(
            file,
            canonicalJson({ identity, assurance: "fixture", ...(value as Record<string, unknown>) }),
          )
          return [bindEvidenceFile(input.evidenceRoot, file, label)]
        }
        const buildEvidence = await record("build-receipt", {
          receiptSha256: built.hostReceiptSha256,
          kind: built.kind,
        })
        const quality = {
          ...input.facts.quality,
          checks: input.facts.quality.checks.map((check) => {
            if (check.id !== "typecheck" && check.id !== "lint") return check
            const ran = built.kind === "ok" ? built.commands.find((c) => c.id === check.id) : undefined
            return {
              ...check,
              status: ran
                ? ran.exitCode === 0
                  ? ("passed" as const)
                  : ("failed" as const)
                : ("not_available" as const),
            }
          }),
        }
        let facts: EvaluationFacts
        if (built.kind === "candidate_failure")
          facts = {
            ...input.facts,
            quality,
            kind: bundle.profile.kind,
            identity,
            assurance: "fixture",
            source: candidate,
            build: { status: "candidate_failure", proof: built, evidence: buildEvidence },
            functional: null,
            visual: null,
          }
        else {
          if (
            canonicalJson(built.commands.map((c) => c.id)) !== canonicalJson(request.commands.map((c) => c.id)) ||
            request.commands.some((c, i) => c.required && built.commands[i]?.exitCode !== 0) ||
            built.build.dependencySha256 !== sha256Text(canonicalJson(request.dependency))
          )
            throw new TypeError("TASK24_BUILD_COMMAND_INVALID")
          const responses: ProbeResponse["cases"][number][] = []
          const probeEvidence: EvidenceReference[] = []
          for (const module of bundle.profile.probeModules) {
            const cases = bundle.oracle.cases.filter((c) => c.module === module)
            if (!cases.length) continue
            const probe = makeProbeRequest({
              identity,
              profile: bundle.profile,
              inputs: {
                candidate,
                module,
                cases: cases.map((c) => ({
                  id: c.id,
                  operations: c.operations,
                  ...(c.fixtures ? { fixtures: c.fixtures } : {}),
                })),
              },
            })
            const observed = await host.probe(probe)
            validateObservation(probe, observed)
            if (observed.kind === "unavailable") return { kind: "blocked", reason: "PROBE_CAPABILITY_UNAVAILABLE" }
            if (observed.kind !== "ok") return { kind: "harness_error", code: "PROBE_EXECUTION_INCOMPLETE" }
            responses.push(...observed.response.cases)
            probeEvidence.push(
              ...(await record(`probe-${sha256Text(module).slice(0, 16)}`, {
                receiptSha256: observed.hostReceiptSha256,
                responseSha256: sha256Text(canonicalJson(observed.response)),
                cases: observed.response.cases.length,
              })),
            )
          }
          const ordered = bundle.oracle.cases.map((c) => responses.find((r) => r.id === c.id))
          if (responses.length !== ordered.length || ordered.some((c) => !c))
            throw new TypeError("TASK24_PROBE_COVERAGE_INVALID")
          const functional = evaluateFunctional({
            oracle: bundle.oracle,
            observation: { cases: ordered },
            evidence: probeEvidence,
          })
          let visual = null
          if (bundle.profile.kind === "primary") {
            if (!options.browser) return { kind: "blocked", reason: "BROWSER_CAPABILITY_UNAVAILABLE" }
            if (!bundle.profile.preview || !bundle.oracle.visual)
              return { kind: "blocked", reason: "REFERENCE_CAPABILITY_UNAVAILABLE" }
            if (bundle.profile.preview.requiredCapabilities.length)
              return { kind: "blocked", reason: "PREVIEW_CAPABILITY_UNAVAILABLE" }
            const previewRequest = { ...common, build: built.build, preview: bundle.profile.preview }
            const preview = await host.preview(previewRequest)
            validateObservation(previewRequest, preview)
            if (preview.kind === "unavailable") return { kind: "blocked", reason: "PREVIEW_CAPABILITY_UNAVAILABLE" }
            if (preview.kind === "candidate_failure")
              facts = {
                ...input.facts,
                quality,
                kind: "primary",
                identity,
                assurance: "fixture",
                source: candidate,
                build: { status: "candidate_failure", proof: preview, evidence: buildEvidence },
                functional: null,
                visual: null,
              }
            else
              visual = await evaluateVisual({
                identity,
                profile: bundle.profile,
                oracle: bundle.oracle,
                build: built.build,
                preview,
                browser: options.browser,
              })
          }
          facts ??= {
            ...input.facts,
            quality,
            kind: bundle.profile.kind,
            identity,
            assurance: "fixture",
            source: candidate,
            build: { status: "passed", manifest: built.build, evidence: buildEvidence },
            functional,
            visual,
          }
        }
        await verifyEvaluationContext(input)
        const result = scoreIndependentEvaluation(facts)
        for (const ref of result.evidence) verifyEvidenceFile(input.evidenceRoot, ref)
        const outcome = freeze({ kind: "evaluated" as const, result })
        contexts.set(outcome, input)
        return outcome
      } catch (error) {
        // Never surface driver stdout, hidden inputs, file paths or credential-like text.
        const message =
          error instanceof TypeError && /^TASK24_[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "EVALUATION_DRIVER_FAILURE"
        return { kind: "harness_error", code: message }
      }
    },
  }
}
