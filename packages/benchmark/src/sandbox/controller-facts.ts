import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { freeze, safePath, type EvaluationOracle } from "../corpus/evaluation-profile"
import type { EvaluationFacts } from "../evaluator/independent/result"
import type { FunctionalFacts } from "../evaluator/independent/functional"
import type { VisualFacts } from "../evaluator/independent/visual"
import type { BuildObservation } from "../evaluator/independent/host"
import type { EvaluateInput } from "../evaluator/independent"
import { publishImmutable } from "../offline/atomic"
import { bindEvidenceFile } from "../evaluator/evidence"
import { sha256Text } from "../hash"
import type { OperationReceipt } from "./receipt"
import { requireLinuxAuthority, type LinuxAuthority } from "./evaluation-host"
import { evaluatePolicy } from "../evaluator/policy"
import { verifyEvidenceFile, type EvidenceReference } from "../evaluator/evidence"

const PolicyObservation = Schema.Struct({
  events: Schema.Array(Schema.Struct({ code: Schema.String })),
  observed: Schema.Array(Schema.String),
  humanEdits: Schema.Int,
  processEnded: Schema.Boolean,
})
export function validatePolicyObservation(input: unknown, required: readonly string[]) {
  const value = Schema.decodeUnknownSync(PolicyObservation)(input, { onExcessProperty: "error" })
  if (!value.processEnded || value.humanEdits < 0 || canonicalJson(value.observed) !== canonicalJson(required))
    throw new TypeError("TASK24_POLICY_UNOBSERVED")
  const events = value.events.map((e) => ({
    code: e.code as Parameters<typeof evaluatePolicy>[0]["events"][number]["code"],
  }))
  return { ...value, events }
}

const Plan = Schema.Union([
  Schema.Struct({ id: Schema.NonEmptyString, kind: Schema.Literal("case"), caseID: Schema.NonEmptyString }),
  Schema.Struct({
    id: Schema.NonEmptyString,
    kind: Schema.Literal("dom"),
    selector: Schema.NonEmptyString,
    count: Schema.Int,
    text: Schema.String,
    visible: Schema.Boolean,
  }),
  Schema.Struct({ id: Schema.NonEmptyString, kind: Schema.Literal("interaction"), name: Schema.NonEmptyString }),
  Schema.Struct({
    id: Schema.NonEmptyString,
    kind: Schema.Literal("file"),
    path: Schema.NonEmptyString,
    contains: Schema.String,
  }),
])
export type RequirementProbePlan = typeof Plan.Type
export type InteractionAssertion = Readonly<{ id: string; observation: string; value: unknown }>
export function compareInteractionAssertions(
  plans: readonly InteractionAssertion[],
  captures: readonly { viewport: string; values: Readonly<Record<string, unknown>> }[],
) {
  if (
    captures.length !== 3 ||
    new Set(captures.map((c) => c.viewport)).size !== 3 ||
    ["mobile", "tablet", "desktop"].some((v) => !captures.some((c) => c.viewport === v))
  )
    throw new TypeError("TASK24_INTERACTION_COVERAGE")
  return plans.map((p) => ({
    id: p.id,
    passed: captures.every(
      (c) =>
        Object.hasOwn(c.values, p.observation) && canonicalJson(c.values[p.observation]) === canonicalJson(p.value),
    ),
  }))
}
type Assertions = EvaluationOracle["requirements"]
export function decodeRequirementPlans(value: unknown, requirements: Assertions): readonly RequirementProbePlan[] {
  const plans = Schema.decodeUnknownSync(Schema.Array(Plan))(value, { onExcessProperty: "error" })
  if (plans.length !== requirements.length || plans.some((p, i) => p.id !== requirements[i]?.id))
    throw new TypeError("TASK24_REQUIREMENT_MAPPING")
  for (const p of plans) if (p.kind === "file") safePath(p.path)
  return freeze(plans)
}
export type RequirementObservations = Readonly<{
  cases: readonly { id: string; passed: boolean }[]
  dom: readonly { selector: string; count: number; text: string; visible: boolean }[]
  interactions: readonly { name: string; passed: boolean }[]
  files: readonly { path: string; text: string }[]
}>
export function compareRequirementPlans(
  plans: readonly RequirementProbePlan[],
  requirements: Assertions,
  observed: RequirementObservations,
) {
  decodeRequirementPlans(plans, requirements)
  return plans.map((p, i) => {
    let passed: boolean
    if (p.kind === "case") {
      const found = observed.cases.find((c) => c.id === p.caseID)
      if (!found) throw new TypeError("TASK24_REQUIREMENT_UNOBSERVED")
      passed = found.passed
    } else if (p.kind === "interaction") {
      const found = observed.interactions.find((c) => c.name === p.name)
      if (!found) throw new TypeError("TASK24_REQUIREMENT_UNOBSERVED")
      passed = found.passed
    } else if (p.kind === "dom") {
      const found = observed.dom.find((c) => c.selector === p.selector)
      if (!found) throw new TypeError("TASK24_REQUIREMENT_UNOBSERVED")
      passed = found.count === p.count && found.text === p.text && found.visible === p.visible
    } else {
      const found = observed.files.find((c) => c.path === p.path)
      if (!found) throw new TypeError("TASK24_REQUIREMENT_UNOBSERVED")
      passed = found.text.includes(p.contains)
    }
    return { ...requirements[i]!, passed }
  })
}
export type ControllerFacts = Pick<EvaluationFacts, "requirements" | "quality" | "policy" | "runtime">
export type ControllerObservationInput = Readonly<{
  input: Omit<EvaluateInput, "facts">
  build: BuildObservation
  functional: FunctionalFacts | null
  visual: VisualFacts | null
  receipts: readonly OperationReceipt[]
}>
export type ControllerFactsObserver = Readonly<{ observe(input: ControllerObservationInput): Promise<ControllerFacts> }>
const issued = new WeakSet<object>()
export function requireControllerFacts(facts: ControllerFacts) {
  if (!issued.has(facts)) throw new TypeError("TASK24_CONTROLLER_FACTS_AUTHORITY")
}
export function makeControllerFactsObserver(options: {
  requirementPlans: Readonly<Record<string, readonly RequirementProbePlan[]>>
  authority: LinuxAuthority
  evidenceRoot: string
  browser: {
    observations(
      identity: ControllerObservationInput["input"]["identity"],
    ): Promise<Omit<RequirementObservations, "cases" | "files">>
  }
  policyObserver?: {
    observe(input: ControllerObservationInput): Promise<{ record: unknown; evidence: readonly EvidenceReference[] }>
  }
  interactionAssertions?: Readonly<Record<string, readonly InteractionAssertion[]>>
}): ControllerFactsObserver {
  requireLinuxAuthority(options.authority)
  return {
    async observe(value) {
      requireLinuxAuthority(options.authority)
      const { input, build, functional, visual } = value,
        plans = decodeRequirementPlans(
          options.requirementPlans[input.bundle.profile.taskID],
          input.bundle.oracle.requirements,
        )
      const cases = functional?.assertions.map((a) => ({ id: a.id, passed: a.passed })) ?? []
      const source = []
      for (const p of plans)
        if (p.kind === "file") {
          const entry = input.snapshot.entries.find((f) => f.path === p.path)
          if (!entry || entry.size > 1048576) throw new TypeError("TASK24_REQUIREMENT_SOURCE")
          source.push({ path: p.path, text: await fs.readFile(path.join(input.snapshot.sourceRoot, p.path), "utf8") })
        }
      const browser =
        input.bundle.profile.kind === "primary" && visual
          ? await options.browser.observations(input.identity)
          : { dom: [], interactions: [] }
      let interactionPassed = true
      if (input.bundle.profile.kind === "primary" && visual) {
        const declarations = options.interactionAssertions?.[input.identity.taskID]
        if (
          !declarations ||
          [
            "keyboard.tabFocusMoved",
            "keyboard.focusVisible",
            "keyboard.enterActivated",
            "keyboard.spaceActivated",
            "consoleErrors",
            "pageErrors",
          ].some((name) => !declarations.some((p) => p.observation === name))
        )
          throw new TypeError("TASK24_INTERACTION_COVERAGE")
        const captures = []
        for (const ref of visual.evidence.filter((e) => e.kind === "browser-capture")) {
          verifyEvidenceFile(input.evidenceRoot, ref)
          const raw = JSON.parse(await fs.readFile(path.join(input.evidenceRoot, ref.relativePath), "utf8")) as {
            viewportID: string
            keyboard: Record<string, unknown>
            consoleErrors: unknown
            pageErrors: unknown
          }
          captures.push({
            viewport: raw.viewportID,
            values: {
              ...Object.fromEntries(Object.entries(raw.keyboard).map(([k, v]) => ["keyboard." + k, v])),
              consoleErrors: raw.consoleErrors,
              pageErrors: raw.pageErrors,
            },
          })
        }
        interactionPassed = compareInteractionAssertions(declarations, captures).every((p) => p.passed)
      }
      cases.push({ id: "$all-mandatory", passed: !!functional && functional.mandatoryPassed && interactionPassed })
      const assertions =
        build.kind === "candidate_failure"
          ? input.bundle.oracle.requirements.map((r) => ({ ...r, passed: false }))
          : compareRequirementPlans(plans, input.bundle.oracle.requirements, { cases, files: source, ...browser })
      if (
        !value.receipts.length ||
        value.receipts.some(
          (r) =>
            r.assurance !== "linux-attested" ||
            r.truncated ||
            !r.started ||
            r.binding?.candidateSha256 !== input.identity.candidateSha256,
        )
      )
        throw new TypeError("TASK24_CONTROLLER_RECEIPTS")
      const checks = (["typecheck", "lint", "structure", "dependency-policy"] as const).map((id) => {
        const ran = build.kind === "ok" ? build.commands.find((c) => c.id === id) : undefined
        return {
          id,
          status:
            id === "structure" || id === "dependency-policy"
              ? ("passed" as const)
              : ran
                ? ran.exitCode === 0
                  ? ("passed" as const)
                  : ("failed" as const)
                : ("not_available" as const),
        }
      })
      if (!options.policyObserver) throw new TypeError("TASK24_POLICY_UNOBSERVED")
      const policyRecord = await options.policyObserver.observe(value),
        policy = validatePolicyObservation(policyRecord.record, input.bundle.oracle.policy)
      if (!policyRecord.evidence.length) throw new TypeError("TASK24_POLICY_UNOBSERVED")
      for (const ref of policyRecord.evidence) {
        verifyEvidenceFile(options.evidenceRoot, ref)
        const stored: unknown = JSON.parse(await fs.readFile(path.join(options.evidenceRoot, ref.relativePath), "utf8"))
        if (canonicalJson(stored) !== canonicalJson({ identity: input.identity, ...policy }))
          throw new TypeError("TASK24_POLICY_EVIDENCE")
      }
      evaluatePolicy({ events: policy.events, evidence: policyRecord.evidence })
      const body = {
        schemaVersion: 2,
        kind: "controller-facts",
        identity: input.identity,
        requirements: { assertions, artifacts: [] },
        quality: { checks },
        policy: { events: policy.events, checks: policy.observed.map((id) => ({ id, observed: true })) },
        runtime: {
          ceilingsPassed: value.receipts.every((r) => r.exitCode !== 124 && r.exitCode !== 130),
          humanEdited: policy.humanEdits !== 0,
        },
      }
      const file = path.join(options.evidenceRoot, `controller-${sha256Text(canonicalJson(body))}.json`)
      await publishImmutable(file, canonicalJson(body))
      const evidence = [bindEvidenceFile(options.evidenceRoot, file, "controller-facts")]
      const facts = freeze({
        requirements: { ...body.requirements, evidence },
        quality: { ...body.quality, evidence },
        policy: { ...body.policy, evidence },
        runtime: { ...body.runtime, evidence },
      })
      issued.add(facts)
      return facts
    },
  }
}
