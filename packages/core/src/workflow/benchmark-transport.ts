export * as WorkflowBenchmarkTransport from "./benchmark-transport"

import { Workflow } from "@opencode-ai/schema/workflow"
import { Context, Data, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { WorkflowBusinessArtifact } from "./artifacts/business"
import { WorkflowSecretGuard } from "./secret-guard"

export const KIND = "workflow.benchmark-transport.v1"
export const RESERVED_INPUT_KEY = KIND

const exact = { parseOptions: { onExcessProperty: "error" as const } }
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const sha256Pattern = /^[a-f0-9]{64}$/

const Identity = Schema.String.check(Schema.isPattern(identityPattern))
const Sha256 = Schema.String.check(Schema.isPattern(sha256Pattern))

const ProviderPaths = Schema.Struct({
  kimi: Schema.Literal("/v1/kimi"),
  deepseek: Schema.Literal("/v1/deepseek"),
}).annotate({ identifier: "WorkflowBenchmarkTransport.ProviderPaths", ...exact })

const ProfileEnvelope = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  campaignID: Identity,
  runID: Identity,
  brokerOrigin: Schema.String,
  providerPaths: ProviderPaths,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  grant: Schema.String.check(Schema.isMinLength(32), Schema.isMaxLength(4_096)),
}).annotate({ identifier: "WorkflowBenchmarkTransport.Profile", ...exact })

const BindingEnvelope = Schema.Struct({
  kind: Schema.Literal(KIND),
  campaignID: Identity,
  runID: Identity,
  brokerOrigin: Schema.String,
  providerPaths: ProviderPaths,
  expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  grantSha256: Sha256,
  bindingSha256: Sha256,
}).annotate({ identifier: "WorkflowBenchmarkTransport.Binding", ...exact })

export interface Binding {
  readonly kind: typeof KIND
  readonly campaignID: string
  readonly runID: string
  readonly brokerOrigin: string
  readonly providerPaths: Readonly<{ readonly kimi: "/v1/kimi"; readonly deepseek: "/v1/deepseek" }>
  readonly expiresAt: number
  readonly grantSha256: string
  readonly bindingSha256: string
}

export class Invalid extends Data.TaggedError("WorkflowBenchmarkTransport.Invalid")<{
  readonly code:
    | "invalid_profile"
    | "invalid_binding"
    | "campaign_mismatch"
    | "run_mismatch"
    | "expired"
    | "missing_grant"
    | "grant_mismatch"
  readonly message: string
}> {}

export interface Interface {
  readonly binding?: Binding
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/WorkflowBenchmarkTransport") {}

export const layerWith = (binding?: Binding) =>
  Layer.succeed(Service, Service.of(binding === undefined ? {} : { binding }))

export const node = makeGlobalNode({ service: Service, layer: layerWith(), deps: [] })

export function freezeProfile(input: {
  readonly authority: "server"
  readonly profile: unknown
  readonly expectedCampaignID: string
  readonly expectedRunID: string
  readonly now?: number
}): Binding {
  if (input.authority !== "server") throw invalid("invalid_profile", "Trusted server authority is required")
  const profile = decodeProfile(input.profile)
  if (profile.campaignID !== input.expectedCampaignID)
    throw invalid("campaign_mismatch", "Benchmark campaign identity does not match the trusted server configuration")
  if (profile.runID !== input.expectedRunID)
    throw invalid("run_mismatch", "Benchmark run identity does not match the trusted server configuration")
  validateOrigin(profile.brokerOrigin, "invalid_profile")
  assertFresh(profile.expiresAt, input.now ?? Date.now())
  if (profile.grant.trim() !== profile.grant)
    throw invalid("invalid_profile", "Benchmark grant must not contain surrounding whitespace")

  const providerPaths = Object.freeze({ ...profile.providerPaths })
  const authority = Object.freeze({
    kind: KIND,
    campaignID: profile.campaignID,
    runID: profile.runID,
    brokerOrigin: profile.brokerOrigin,
    providerPaths,
    expiresAt: profile.expiresAt,
    grantSha256: sha256(profile.grant),
  })
  return validateBinding(
    { ...authority, bindingSha256: WorkflowBusinessArtifact.hash(authority) },
    input.now ?? Date.now(),
  )
}

export function decodeBinding(input: unknown, now?: number): Binding {
  return validateBinding(input, now)
}

export function withBinding(
  input: Readonly<Record<string, unknown>>,
  binding: Binding,
): Readonly<Record<string, unknown>> {
  if (Object.hasOwn(input, RESERVED_INPUT_KEY)) throw invalid("invalid_binding", "Benchmark transport is already bound")
  const trusted = validateBinding(binding)
  return Object.freeze({ ...input, [RESERVED_INPUT_KEY]: trusted })
}

export function fromWorkflow(workflow: Workflow.Info, now = Date.now()): Binding | undefined {
  if (!Object.hasOwn(workflow.input, RESERVED_INPUT_KEY)) return undefined
  if (workflow.type !== "visual-build")
    throw invalid("invalid_binding", "Benchmark transport can only be attached to a visual-build workflow")
  return validateBinding(workflow.input[RESERVED_INPUT_KEY], now)
}

export function baseURL(binding: Binding, providerID: "kimi" | "deepseek", now = Date.now()): string {
  const trusted = validateBinding(binding, now)
  return `${trusted.brokerOrigin}${trusted.providerPaths[providerID]}`
}

export function verifyGrant(binding: Binding, grant: string | undefined, now = Date.now()): asserts grant is string {
  const trusted = validateBinding(binding, now)
  if (grant === undefined) throw invalid("missing_grant", "Persisted benchmark transport grant is missing")
  if (sha256(grant) !== trusted.grantSha256)
    throw invalid("grant_mismatch", "Persisted benchmark transport grant does not match its workflow binding")
}

function decodeProfile(input: unknown): typeof ProfileEnvelope.Type {
  try {
    return Schema.decodeUnknownSync(ProfileEnvelope)(input)
  } catch {
    throw invalid("invalid_profile", "Benchmark transport profile is malformed")
  }
}

function validateBinding(input: unknown, now?: number): Binding {
  try {
    const decoded = Schema.decodeUnknownSync(BindingEnvelope)(input)
    validateOrigin(decoded.brokerOrigin, "invalid_binding")
    if (now !== undefined) assertFresh(decoded.expiresAt, now)
    const providerPaths = Object.freeze({ ...decoded.providerPaths })
    const authority = Object.freeze({
      kind: decoded.kind,
      campaignID: decoded.campaignID,
      runID: decoded.runID,
      brokerOrigin: decoded.brokerOrigin,
      providerPaths,
      expiresAt: decoded.expiresAt,
      grantSha256: decoded.grantSha256,
    })
    if (decoded.bindingSha256 !== WorkflowBusinessArtifact.hash(authority))
      throw invalid("invalid_binding", "Benchmark transport binding fingerprint does not match its authority")
    const binding = Object.freeze({ ...authority, bindingSha256: decoded.bindingSha256 })
    WorkflowSecretGuard.assertSafe(binding)
    return binding
  } catch (cause) {
    if (cause instanceof Invalid) throw cause
    throw invalid("invalid_binding", "Persisted benchmark transport binding is malformed")
  }
}

function validateOrigin(origin: string, code: "invalid_profile" | "invalid_binding"): void {
  try {
    const parsed = new URL(origin)
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.port.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.origin !== origin
    ) {
      throw invalid(code, "Benchmark broker origin must be an exact 127.0.0.1 HTTP origin with an explicit port")
    }
  } catch (cause) {
    if (cause instanceof Invalid) throw cause
    throw invalid(code, "Benchmark broker origin is not a valid URL")
  }
}

function assertFresh(expiresAt: number, now: number): void {
  if (expiresAt <= now) throw invalid("expired", "Benchmark transport grant has expired")
}

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex")
}

function invalid(code: Invalid["code"], message: string): Invalid {
  return new Invalid({ code, message })
}
