import { Schema } from "effect"
import { sha256Text } from "../hash"
import {
  CampaignInput as CampaignInputSchema,
  SealedCampaign as SealedCampaignSchema,
  type ArmDefinition,
  type CampaignInput,
  type SealedCampaign,
} from "../schema"
import { canonicalJson } from "./canonical"

const exactDecode = { onExcessProperty: "error" as const, errors: "all" as const }

type CampaignSealErrorCode =
  | "CAMPAIGN_TASK_COUNT_INVALID"
  | "CAMPAIGN_TASK_ID_DUPLICATE"
  | "CAMPAIGN_TASK_STRATA_INVALID"
  | "CAMPAIGN_ARM_MATRIX_INVALID"
  | "CAMPAIGN_PREREGISTRATION_INVALID"
  | "CAMPAIGN_PRICING_INVALID"
  | "CAMPAIGN_EXCHANGE_RATE_INVALID"
  | "CAMPAIGN_TIMESTAMP_INVALID"

export class CampaignSealError extends Error {
  readonly code: CampaignSealErrorCode

  constructor(code: CampaignSealErrorCode) {
    super(code)
    this.name = "CampaignSealError"
    this.code = code
  }
}

const expectedRoutes: Readonly<Record<"A" | "B" | "C" | "D" | "E", ArmDefinition>> = {
  A: {
    id: "A",
    runtime: "modified",
    mode: "workflow",
    routes: [
      { role: "design", provider: "kimi", model: "kimi-k3", protocol: "chat_completions", effort: "max" },
      { role: "decompose", provider: "kimi", model: "kimi-k3", protocol: "chat_completions", effort: "high" },
      { role: "implement", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "max" },
      { role: "test", provider: "deepseek", model: "deepseek-v4-flash", protocol: "responses", effort: "high" },
      { role: "visual_review", provider: "kimi", model: "kimi-k3", protocol: "chat_completions", effort: "max" },
      { role: "repair", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "max" },
      { role: "deliver", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "high" },
    ],
  },
  B: {
    id: "B",
    runtime: "modified",
    mode: "direct",
    routes: [{ role: "all", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "max" }],
  },
  C: {
    id: "C",
    runtime: "modified",
    mode: "direct",
    routes: [{ role: "all", provider: "kimi", model: "kimi-k3", protocol: "chat_completions", effort: "max" }],
  },
  D: {
    id: "D",
    runtime: "upstream",
    mode: "direct",
    routes: [{ role: "all", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "max" }],
  },
  E: {
    id: "E",
    runtime: "upstream",
    mode: "direct",
    routes: [{ role: "all", provider: "kimi", model: "kimi-k3", protocol: "chat_completions", effort: "max" }],
  },
}

function assertTimestamp(value: string) {
  if (!Number.isFinite(Date.parse(value))) throw new CampaignSealError("CAMPAIGN_TIMESTAMP_INVALID")
}

function exact(value: unknown, expected: unknown): boolean {
  return canonicalJson(value) === canonicalJson(expected)
}

function positiveDecimal(value: string): boolean {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
}

function validateCampaign(input: CampaignInput): void {
  const primary = input.tasks.filter((task) => task.kind === "primary")
  const guardrail = input.tasks.filter((task) => task.kind === "guardrail")
  if (input.tasks.length !== 16 || primary.length !== 12 || guardrail.length !== 4) {
    throw new CampaignSealError("CAMPAIGN_TASK_COUNT_INVALID")
  }

  if (new Set(input.tasks.map((task) => task.id)).size !== input.tasks.length) {
    throw new CampaignSealError("CAMPAIGN_TASK_ID_DUPLICATE")
  }

  const strata = new Map<string, number>()
  for (const task of primary) strata.set(task.stratum, (strata.get(task.stratum) ?? 0) + 1)
  if (
    strata.size !== 3 ||
    strata.get("private") !== 4 ||
    strata.get("design2code") !== 4 ||
    strata.get("swebench-multimodal") !== 4 ||
    guardrail.some((task) => task.stratum !== "guardrail")
  ) {
    throw new CampaignSealError("CAMPAIGN_TASK_STRATA_INVALID")
  }

  if (
    input.arms.length !== 5 ||
    new Set(input.arms.map((arm) => arm.id)).size !== 5 ||
    !input.arms.every((arm) => exact(arm, expectedRoutes[arm.id]))
  ) {
    throw new CampaignSealError("CAMPAIGN_ARM_MATRIX_INVALID")
  }

  const preregistration = input.preregistration
  if (
    preregistration.primaryTaskCount !== 12 ||
    preregistration.guardrailTaskCount !== 4 ||
    preregistration.primaryRepeats !== 2 ||
    preregistration.upstreamRepeats !== 1 ||
    preregistration.upstreamSecondPassThresholdPoints !== 5 ||
    preregistration.bootstrapResamples !== 10_000 ||
    preregistration.minimumEffectPoints !== 10 ||
    preregistration.visualQualifiedThreshold !== 75 ||
    preregistration.viewportFloor !== 65 ||
    preregistration.costRatioLimit !== 2
  ) {
    throw new CampaignSealError("CAMPAIGN_PREREGISTRATION_INVALID")
  }

  if (
    input.pricing.kimi.provider !== "kimi" ||
    input.pricing.kimi.currency !== "CNY" ||
    input.pricing.deepseek.provider !== "deepseek" ||
    input.pricing.deepseek.currency !== "USD" ||
    [input.pricing.kimi, input.pricing.deepseek].some((price) =>
      [
        price.inputMicrosPerMillion,
        price.cachedInputMicrosPerMillion,
        price.outputMicrosPerMillion,
        price.reasoningMicrosPerMillion,
      ].some((value) => !positiveDecimal(value)),
    )
  ) {
    throw new CampaignSealError("CAMPAIGN_PRICING_INVALID")
  }

  if (!positiveDecimal(input.exchangeRate.decimalRate)) {
    throw new CampaignSealError("CAMPAIGN_EXCHANGE_RATE_INVALID")
  }

  assertTimestamp(input.createdAt)
  assertTimestamp(input.pricing.kimi.capturedAt)
  assertTimestamp(input.pricing.deepseek.capturedAt)
  assertTimestamp(input.exchangeRate.capturedAt)

  if (
    !exact(input.evaluator.diagnosticWeights, {
      functional: 45,
      visual: 30,
      requirements: 10,
      quality: 10,
      accessibilityResponsive: 5,
    }) ||
    !exact(input.evaluator.visualWeights, {
      ssim: 35,
      pixelColor: 20,
      domGeometry: 25,
      typographyStyle: 10,
      responsiveInteraction: 10,
    })
  ) {
    throw new CampaignSealError("CAMPAIGN_PREREGISTRATION_INVALID")
  }
}

function decodeInput(value: unknown): CampaignInput {
  const decoded = Schema.decodeUnknownSync(CampaignInputSchema)(value, exactDecode)
  validateCampaign(decoded)
  return decoded
}

export function sealCampaign(value: unknown): SealedCampaign {
  const decoded = decodeInput(value)
  const sha256 = sha256Text(canonicalJson(decoded))
  return Schema.decodeUnknownSync(SealedCampaignSchema)({ ...decoded, sha256 }, exactDecode)
}

export type CampaignVerification =
  | { readonly ok: true; readonly campaign: SealedCampaign }
  | { readonly ok: false; readonly reason: "CAMPAIGN_INVALID" | "CAMPAIGN_HASH_MISMATCH" }

export function verifyCampaign(value: unknown): CampaignVerification {
  try {
    const decoded = Schema.decodeUnknownSync(SealedCampaignSchema)(value, exactDecode)
    const { sha256, ...input } = decoded
    if (sha256Text(canonicalJson(input)) !== sha256) return { ok: false, reason: "CAMPAIGN_HASH_MISMATCH" }
    validateCampaign(input)
    return { ok: true, campaign: decoded }
  } catch {
    return { ok: false, reason: "CAMPAIGN_INVALID" }
  }
}
