const shaPattern = /^[a-f0-9]{64}$/
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const forbiddenFields = new Set([
  "apikey",
  "authorization",
  "prompt",
  "requestbody",
  "responsebody",
  "rawbody",
  "modeloutput",
  "grant",
  "secret",
  "password",
  "credential",
])

export interface ReportModel {
  readonly schemaVersion: 1
  readonly campaignID: string
  readonly generatedAt: string
  readonly decision:
    | "demonstrated"
    | "not demonstrated"
    | "promising but inconclusive"
    | "quality gain at disproportionate cost"
    | "incomplete"
  readonly decisionReasons: readonly string[]
  readonly armSummaries: readonly ArmReport[]
  readonly contrasts: readonly ContrastReport[]
  readonly familyChecks: readonly { readonly family: string; readonly effect: number }[]
  readonly guardrails: {
    readonly functionalRegression: number
    readonly securityIncidents: number
    readonly equalBudgets: boolean
  }
  readonly cost: {
    readonly kimiCnyMicros: string
    readonly deepseekUsdMicros: string
    readonly totalCnyMicros: string
    readonly costPerQualifiedSuccessCnyMicros: string | null
    readonly costRatio: number | null
  }
  readonly runs: readonly RunReport[]
  readonly metadata: Readonly<Record<MetadataKey, string>>
  readonly limitations: readonly string[]
  readonly exclusions: readonly string[]
  readonly harnessFailures: readonly string[]
  readonly evidenceHashes: readonly string[]
}

export interface ArmReport {
  readonly armID: "A" | "B" | "C" | "D" | "E"
  readonly runs: number
  readonly qualifiedSuccesses: number
  readonly qualifiedRate: number
  readonly functionalRate: number
  readonly meanDiagnosticScore: number
}

export interface ContrastReport {
  readonly label: "A-B" | "A-C" | "A-best-control"
  readonly estimate: number
  readonly lower95: number
  readonly upper95: number
}

export interface RunReport {
  readonly runID: string
  readonly taskID: string
  readonly family: string
  readonly armID: ArmReport["armID"]
  readonly qualifiedSuccess: boolean
  readonly functionalSuccess: boolean
  readonly firstPassFunctionalSuccess: boolean
  readonly firstPassVisualSuccess: boolean
  readonly diagnosticScore: number
  readonly visualComposite: number
  readonly durationMs: number
  readonly inputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
  readonly toolCalls: number
  readonly retries: number
  readonly revisionLoops: number
  readonly changedFiles: number
  readonly recoveryCount: number
  readonly costCnyMicros: string
  readonly failureCategory: string | null
}

type MetadataKey =
  | "campaignSha256"
  | "sourceSha256"
  | "modifiedBinarySha256"
  | "upstreamBinarySha256"
  | "evaluatorSha256"
  | "modelRevisionSha256"
  | "protocolRevisionSha256"
  | "priceRevisionSha256"
  | "exchangeRateSha256"

const topKeys = [
  "schemaVersion",
  "campaignID",
  "generatedAt",
  "decision",
  "decisionReasons",
  "armSummaries",
  "contrasts",
  "familyChecks",
  "guardrails",
  "cost",
  "runs",
  "metadata",
  "limitations",
  "exclusions",
  "harnessFailures",
  "evidenceHashes",
] as const

export function decodeReportModel(value: unknown): ReportModel {
  rejectSensitive(value)
  if (!record(value) || !exact(value, topKeys)) invalid()
  if (
    value.schemaVersion !== 1 ||
    !textID(value.campaignID) ||
    !isoTimestamp(value.generatedAt) ||
    !decision(value.decision) ||
    !stringArray(value.decisionReasons) ||
    !Array.isArray(value.armSummaries) ||
    !Array.isArray(value.contrasts) ||
    !Array.isArray(value.familyChecks) ||
    !Array.isArray(value.runs) ||
    !stringArray(value.limitations) ||
    !stringArray(value.exclusions) ||
    !stringArray(value.harnessFailures) ||
    !Array.isArray(value.evidenceHashes) ||
    !value.evidenceHashes.every((item) => typeof item === "string" && shaPattern.test(item))
  ) {
    invalid()
  }
  const armSummaries = decodeArms(value.armSummaries)
  const contrasts = decodeContrasts(value.contrasts)
  const familyChecks = decodeFamilies(value.familyChecks)
  const guardrails = decodeGuardrails(value.guardrails)
  const cost = decodeCost(value.cost)
  const runs = decodeRuns(value.runs)
  const metadata = decodeMetadata(value.metadata)
  const model: ReportModel = {
    schemaVersion: 1,
    campaignID: value.campaignID,
    generatedAt: value.generatedAt,
    decision: value.decision,
    decisionReasons: Object.freeze([...value.decisionReasons]),
    armSummaries,
    contrasts,
    familyChecks,
    guardrails,
    cost,
    runs,
    metadata,
    limitations: Object.freeze([...value.limitations]),
    exclusions: Object.freeze([...value.exclusions]),
    harnessFailures: Object.freeze([...value.harnessFailures]),
    evidenceHashes: Object.freeze(
      [...new Set(value.evidenceHashes)].toSorted((left, right) => left.localeCompare(right)),
    ),
  }
  return deepFreeze(model)
}

function decodeArms(values: readonly unknown[]): readonly ArmReport[] {
  if (values.length === 0 || values.length > 5) invalid()
  const ids = new Set<string>()
  return Object.freeze(
    values.map((value) => {
      if (
        !record(value) ||
        !exact(value, [
          "armID",
          "runs",
          "qualifiedSuccesses",
          "qualifiedRate",
          "functionalRate",
          "meanDiagnosticScore",
        ]) ||
        !armID(value.armID) ||
        ids.has(value.armID) ||
        !integer(value.runs, 1) ||
        !integer(value.qualifiedSuccesses, 0) ||
        value.qualifiedSuccesses > value.runs ||
        !fraction(value.qualifiedRate) ||
        !fraction(value.functionalRate) ||
        !bounded(value.meanDiagnosticScore, 0, 100)
      ) {
        invalid()
      }
      ids.add(value.armID)
      return Object.freeze({
        armID: value.armID,
        runs: value.runs,
        qualifiedSuccesses: value.qualifiedSuccesses,
        qualifiedRate: value.qualifiedRate,
        functionalRate: value.functionalRate,
        meanDiagnosticScore: value.meanDiagnosticScore,
      })
    }),
  )
}

function decodeContrasts(values: readonly unknown[]): readonly ContrastReport[] {
  const required = ["A-B", "A-C", "A-best-control"]
  if (values.length !== required.length) invalid()
  const result = values.map((value) => {
    if (
      !record(value) ||
      !exact(value, ["label", "estimate", "lower95", "upper95"]) ||
      !contrastLabel(value.label) ||
      !bounded(value.estimate, -1, 1) ||
      !bounded(value.lower95, -1, 1) ||
      !bounded(value.upper95, -1, 1) ||
      value.lower95 > value.upper95
    ) {
      invalid()
    }
    return Object.freeze({
      label: value.label,
      estimate: value.estimate,
      lower95: value.lower95,
      upper95: value.upper95,
    })
  })
  if (new Set(result.map((item) => item.label)).size !== required.length) invalid()
  return Object.freeze(result)
}

function decodeFamilies(values: readonly unknown[]) {
  if (values.length === 0 || values.length > 1_000) invalid()
  return Object.freeze(
    values.map((value) => {
      if (
        !record(value) ||
        !exact(value, ["family", "effect"]) ||
        !textID(value.family) ||
        !bounded(value.effect, -1, 1)
      ) {
        invalid()
      }
      return Object.freeze({ family: value.family, effect: value.effect })
    }),
  )
}

function decodeGuardrails(value: unknown): ReportModel["guardrails"] {
  if (
    !record(value) ||
    !exact(value, ["functionalRegression", "securityIncidents", "equalBudgets"]) ||
    !bounded(value.functionalRegression, -1, 1) ||
    !integer(value.securityIncidents, 0) ||
    typeof value.equalBudgets !== "boolean"
  ) {
    invalid()
  }
  return Object.freeze({
    functionalRegression: value.functionalRegression,
    securityIncidents: value.securityIncidents,
    equalBudgets: value.equalBudgets,
  })
}

function decodeCost(value: unknown): ReportModel["cost"] {
  if (
    !record(value) ||
    !exact(value, [
      "kimiCnyMicros",
      "deepseekUsdMicros",
      "totalCnyMicros",
      "costPerQualifiedSuccessCnyMicros",
      "costRatio",
    ]) ||
    !decimal(value.kimiCnyMicros) ||
    !decimal(value.deepseekUsdMicros) ||
    !decimal(value.totalCnyMicros) ||
    (value.costPerQualifiedSuccessCnyMicros !== null && !decimal(value.costPerQualifiedSuccessCnyMicros)) ||
    (value.costRatio !== null && !bounded(value.costRatio, 0, Number.MAX_SAFE_INTEGER))
  ) {
    invalid()
  }
  return Object.freeze({
    kimiCnyMicros: value.kimiCnyMicros,
    deepseekUsdMicros: value.deepseekUsdMicros,
    totalCnyMicros: value.totalCnyMicros,
    costPerQualifiedSuccessCnyMicros: value.costPerQualifiedSuccessCnyMicros,
    costRatio: value.costRatio,
  })
}

function decodeRuns(values: readonly unknown[]): readonly RunReport[] {
  if (values.length === 0 || values.length > 100_000) invalid()
  const ids = new Set<string>()
  return Object.freeze(
    values.map((value) => {
      if (
        !record(value) ||
        !exact(value, [
          "runID",
          "taskID",
          "family",
          "armID",
          "qualifiedSuccess",
          "functionalSuccess",
          "firstPassFunctionalSuccess",
          "firstPassVisualSuccess",
          "diagnosticScore",
          "visualComposite",
          "durationMs",
          "inputTokens",
          "cachedInputTokens",
          "outputTokens",
          "toolCalls",
          "retries",
          "revisionLoops",
          "changedFiles",
          "recoveryCount",
          "costCnyMicros",
          "failureCategory",
        ]) ||
        !textID(value.runID) ||
        ids.has(value.runID) ||
        !textID(value.taskID) ||
        !textID(value.family) ||
        !armID(value.armID) ||
        typeof value.qualifiedSuccess !== "boolean" ||
        typeof value.functionalSuccess !== "boolean" ||
        typeof value.firstPassFunctionalSuccess !== "boolean" ||
        typeof value.firstPassVisualSuccess !== "boolean" ||
        !bounded(value.diagnosticScore, 0, 100) ||
        !bounded(value.visualComposite, 0, 100) ||
        !integer(value.durationMs, 0) ||
        !integer(value.inputTokens, 0) ||
        !integer(value.cachedInputTokens, 0) ||
        value.cachedInputTokens > value.inputTokens ||
        !integer(value.outputTokens, 0) ||
        !integer(value.toolCalls, 0) ||
        !integer(value.retries, 0) ||
        !integer(value.revisionLoops, 0) ||
        !integer(value.changedFiles, 0) ||
        !integer(value.recoveryCount, 0) ||
        !decimal(value.costCnyMicros) ||
        (value.failureCategory !== null && !text(value.failureCategory, 1, 256))
      ) {
        invalid()
      }
      ids.add(value.runID)
      return Object.freeze({
        runID: value.runID,
        taskID: value.taskID,
        family: value.family,
        armID: value.armID,
        qualifiedSuccess: value.qualifiedSuccess,
        functionalSuccess: value.functionalSuccess,
        firstPassFunctionalSuccess: value.firstPassFunctionalSuccess,
        firstPassVisualSuccess: value.firstPassVisualSuccess,
        diagnosticScore: value.diagnosticScore,
        visualComposite: value.visualComposite,
        durationMs: value.durationMs,
        inputTokens: value.inputTokens,
        cachedInputTokens: value.cachedInputTokens,
        outputTokens: value.outputTokens,
        toolCalls: value.toolCalls,
        retries: value.retries,
        revisionLoops: value.revisionLoops,
        changedFiles: value.changedFiles,
        recoveryCount: value.recoveryCount,
        costCnyMicros: value.costCnyMicros,
        failureCategory: value.failureCategory,
      })
    }),
  )
}

function decodeMetadata(value: unknown): ReportModel["metadata"] {
  const keys: MetadataKey[] = [
    "campaignSha256",
    "sourceSha256",
    "modifiedBinarySha256",
    "upstreamBinarySha256",
    "evaluatorSha256",
    "modelRevisionSha256",
    "protocolRevisionSha256",
    "priceRevisionSha256",
    "exchangeRateSha256",
  ]
  if (!record(value) || !exact(value, keys) || !keys.every((key) => sha(value[key]))) {
    invalid()
  }
  return Object.freeze({
    campaignSha256: requireSha(value.campaignSha256),
    sourceSha256: requireSha(value.sourceSha256),
    modifiedBinarySha256: requireSha(value.modifiedBinarySha256),
    upstreamBinarySha256: requireSha(value.upstreamBinarySha256),
    evaluatorSha256: requireSha(value.evaluatorSha256),
    modelRevisionSha256: requireSha(value.modelRevisionSha256),
    protocolRevisionSha256: requireSha(value.protocolRevisionSha256),
    priceRevisionSha256: requireSha(value.priceRevisionSha256),
    exchangeRateSha256: requireSha(value.exchangeRateSha256),
  })
}

function requireSha(value: unknown): string {
  if (!sha(value)) invalid()
  return value
}

function sha(value: unknown): value is string {
  return typeof value === "string" && shaPattern.test(value)
}

function armID(value: unknown): value is ArmReport["armID"] {
  return value === "A" || value === "B" || value === "C" || value === "D" || value === "E"
}

function contrastLabel(value: unknown): value is ContrastReport["label"] {
  return value === "A-B" || value === "A-C" || value === "A-best-control"
}

function decision(value: unknown): value is ReportModel["decision"] {
  return (
    value === "demonstrated" ||
    value === "not demonstrated" ||
    value === "promising but inconclusive" ||
    value === "quality gain at disproportionate cost" ||
    value === "incomplete"
  )
}

function rejectSensitive(value: unknown, key?: string, seen = new WeakSet<object>()): void {
  if (key && forbiddenFields.has(key.replaceAll(/[_-]/g, "").toLowerCase())) {
    throw new TypeError("TASK24_REPORT_FIELD_FORBIDDEN")
  }
  if (typeof value === "string") {
    if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(value) || /authorization\s*:\s*bearer\s+\S+/i.test(value)) {
      throw new TypeError("TASK24_REPORT_SECRET_FORBIDDEN")
    }
    return
  }
  if (value === null || typeof value !== "object") return
  if (seen.has(value)) invalid()
  seen.add(value)
  if (Array.isArray(value)) for (const item of value) rejectSensitive(item, undefined, seen)
  else for (const [childKey, item] of Object.entries(value)) rejectSensitive(item, childKey, seen)
  seen.delete(value)
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...keys].toSorted())
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function textID(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value)
}

function text(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every((item) => text(item, 1, 2_048))
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
}

function bounded(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
}

function fraction(value: unknown): value is number {
  return bounded(value, 0, 1)
}

function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,30})$/.test(value)
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

function invalid(): never {
  throw new TypeError("TASK24_REPORT_MODEL_INVALID")
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
