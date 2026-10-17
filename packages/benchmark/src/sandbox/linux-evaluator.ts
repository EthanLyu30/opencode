import { canonicalJson } from "../campaign/canonical"
import { freeze, type DependencyResolution } from "../corpus/evaluation-profile"
import type { EvaluateInput, EvaluationOutcome } from "../evaluator/independent"
import { verifyEvaluationContext } from "../evaluator/independent"
import {
  validateObservation,
  type EvaluationHost,
  type BuildObservation,
  type ProbeObservation,
  type PreviewObservation,
} from "../evaluator/independent/host"
import { makeProbeRequest, type ProbeResponse } from "../evaluator/independent/probe"
import { evaluateFunctional } from "../evaluator/independent/functional"
import { evaluateVisual, type IndependentBrowser } from "../evaluator/independent/visual"
import { scoreIndependentEvaluation, type EvaluationFacts } from "../evaluator/independent/result"
import { requireLinuxHost, requireLinuxObservation, bindLinuxEvaluationFacts } from "./evaluation-host"
import { requireControllerFacts, type ControllerFactsObserver } from "./controller-facts"
import { sha256Text } from "../hash"

export type LinuxEvaluateInput = Omit<EvaluateInput, "facts"> & Readonly<{ dependency: DependencyResolution }>
export async function evaluateLinux(
  input: LinuxEvaluateInput,
  options: { host?: EvaluationHost; browser?: IndependentBrowser; controllerFactsObserver?: ControllerFactsObserver },
): Promise<EvaluationOutcome> {
  try {
    if (Object.keys(input).some((k) => !["bundle", "snapshot", "identity", "evidenceRoot", "dependency"].includes(k)))
      throw new TypeError("TASK24_EVALUATE_INPUT_INVALID")
    if (!options.host || !options.controllerFactsObserver) return { kind: "blocked", reason: "LINUX_OBSERVER_REQUIRED" }
    const { authority, backend } = requireLinuxHost(options.host),
      { bundle, snapshot, identity } = input
    if (
      identity.profileSha256 !== bundle.profileSha256 ||
      identity.oracleSha256 !== bundle.oracleSha256 ||
      identity.seedSha256 !== bundle.seedSha256 ||
      identity.taskID !== bundle.profile.taskID ||
      identity.candidateSha256 !== snapshot.candidateSha256
    )
      throw new TypeError("TASK24_EVALUATE_IDENTITY_INVALID")
    await verifyEvaluationContext(input)
    const required = bundle.profile.dependency,
      d = input.dependency
    if (
      required.kind === "locked" &&
      (d.kind !== "resolved" ||
        d.recipeSha256 !== required.recipeSha256 ||
        canonicalJson(d.lockfiles) !== canonicalJson(required.lockfiles))
    )
      return { kind: "blocked", reason: "DEPENDENCY_UNRESOLVED" }
    if (required.kind === "none" && d.kind !== "none") throw new TypeError("TASK24_DEPENDENCY_BINDING")
    const common = {
      identity,
      candidate: {
        archiveFile: snapshot.archiveFile,
        archiveSha256: snapshot.archiveSha256,
        candidateSha256: snapshot.candidateSha256,
        configSha256: snapshot.configSha256,
      },
      profileSha256: bundle.profileSha256,
      timeoutMs: 30000,
    }
    const observations: (BuildObservation | ProbeObservation | PreviewObservation)[] = []
    const request = { ...common, timeoutMs: 300000, commands: bundle.profile.checks, dependency: d },
      built = await options.host.build(request)
    validateObservation(request, built)
    requireLinuxObservation(built)
    observations.push(built)
    if (built.kind === "unavailable") return { kind: "blocked", reason: built.reason }
    const buildEvidence = requireLinuxObservation(built).receipts.map((r) => r.evidence)
    let functional = null,
      visual = null
    if (built.kind === "ok") {
      if (
        canonicalJson(built.commands.map((c) => c.id)) !== canonicalJson(bundle.profile.checks.map((c) => c.id)) ||
        built.build.dependencySha256 !== sha256Text(canonicalJson(d))
      )
        throw new TypeError("TASK24_BUILD_COMMAND_INVALID")
      const cases: ProbeResponse["cases"][number][] = [],
        evidence = []
      for (const module of bundle.profile.probeModules) {
        const subset = bundle.oracle.cases.filter((c) => c.module === module)
        if (!subset.length) continue
        const probe = makeProbeRequest({
            identity,
            profile: bundle.profile,
            inputs: {
              candidate: common.candidate,
              module,
              cases: subset.map((c) => ({ id: c.id, fixtures: c.fixtures, operations: c.operations })),
            },
          }),
          result = await options.host.probe(probe)
        validateObservation(probe, result)
        const bound = requireLinuxObservation(result)
        observations.push(result)
        if (result.kind === "unavailable") return { kind: "blocked", reason: result.reason }
        if (result.kind !== "ok") return { kind: "harness_error", code: "PROBE_EXECUTION_INCOMPLETE" }
        cases.push(...result.response.cases)
        evidence.push(...bound.receipts.map((r) => r.evidence))
      }
      const ordered = bundle.oracle.cases.map((c) => cases.find((r) => r.id === c.id))
      if (cases.length !== ordered.length || ordered.some((c) => !c))
        throw new TypeError("TASK24_PROBE_COVERAGE_INVALID")
      functional = evaluateFunctional({ oracle: bundle.oracle, observation: { cases: ordered }, evidence })
      if (bundle.profile.kind === "primary") {
        if (!options.browser || !bundle.profile.preview)
          return { kind: "blocked", reason: "BROWSER_CAPABILITY_UNAVAILABLE" }
        const previewRequest = { ...common, build: built.build, preview: bundle.profile.preview },
          preview = await options.host.preview(previewRequest)
        validateObservation(previewRequest, preview)
        requireLinuxObservation(preview)
        observations.push(preview)
        if (preview.kind !== "ok") return { kind: "blocked", reason: "PREVIEW_CAPABILITY_UNAVAILABLE" }
        visual = await evaluateVisual({
          identity,
          profile: bundle.profile,
          oracle: bundle.oracle,
          build: built.build,
          preview,
          browser: options.browser,
        })
      }
    }
    const controller = await options.controllerFactsObserver.observe({
      input,
      build: built,
      functional,
      visual,
      receipts: backend
        .receipts()
        .filter((r) => r.owner.runID === identity.runID && r.owner.attemptID === identity.attemptID),
    })
    requireControllerFacts(controller)
    const facts: EvaluationFacts = {
      ...controller,
      kind: bundle.profile.kind,
      identity,
      assurance: "linux-attested",
      source: common.candidate,
      build:
        built.kind === "ok"
          ? { status: "passed", manifest: built.build, evidence: buildEvidence }
          : { status: "candidate_failure", proof: built, evidence: buildEvidence },
      functional,
      visual,
    }
    await verifyEvaluationContext(input)
    return freeze({
      kind: "evaluated",
      result: scoreIndependentEvaluation(bindLinuxEvaluationFacts(facts, authority, controller, observations)),
    })
  } catch (error) {
    if (
      error instanceof TypeError &&
      [
        "TASK24_POLICY_UNOBSERVED",
        "TASK24_REQUIREMENT_MAPPING",
        "TASK24_REQUIREMENT_UNOBSERVED",
        "TASK24_INTERACTION_COVERAGE",
        "TASK24_LINUX_PROBE_MAPPING",
        "TASK24_DEPENDENCY_UNRESOLVED",
      ].includes(error.message)
    )
      return { kind: "blocked", reason: error.message }
    return {
      kind: "harness_error",
      code:
        error instanceof TypeError && /^TASK24_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "EVALUATION_DRIVER_FAILURE",
    }
  }
}
