import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

export type BrokerProvider = "kimi" | "deepseek"
export type BrokerProtocol = "chat_completions" | "responses"

export interface GrantRoute {
  readonly provider: BrokerProvider
  readonly model: "kimi-k3" | "deepseek-v4-pro" | "deepseek-v4-flash"
  readonly protocol: BrokerProtocol
}

export interface GrantAuthority {
  readonly schemaVersion: 1
  readonly campaignID: string
  readonly runID: string
  readonly grantSha256: string
  readonly allowed: readonly GrantRoute[]
  readonly expiresAt: number
  readonly maximumCalls: number
  readonly status: "active" | "revoked"
}

const identityPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/

export function mintGrant(input: {
  readonly campaignID: string
  readonly runID: string
  readonly allowed: readonly GrantRoute[]
  readonly expiresAt: number
  readonly maximumCalls: number
}): { readonly grant: string; readonly authority: GrantAuthority } {
  if (!identityPattern.test(input.campaignID) || !identityPattern.test(input.runID)) {
    throw new TypeError("BROKER_GRANT_IDENTITY_INVALID")
  }
  if (input.allowed.length === 0 || !Number.isSafeInteger(input.maximumCalls) || input.maximumCalls <= 0) {
    throw new TypeError("BROKER_GRANT_POLICY_INVALID")
  }
  const allowed = input.allowed.map(validateRoute)
  if (new Set(allowed.map(routeKey)).size !== allowed.length) throw new TypeError("BROKER_GRANT_ROUTE_DUPLICATE")
  const grant = randomBytes(32).toString("base64url")
  const authority = deepFreeze({
    schemaVersion: 1 as const,
    campaignID: input.campaignID,
    runID: input.runID,
    grantSha256: grantSha256(grant),
    allowed,
    expiresAt: input.expiresAt,
    maximumCalls: input.maximumCalls,
    status: "active" as const,
  })
  return Object.freeze({ grant, authority })
}

export function verifyGrant(authority: GrantAuthority, grant: string, now: number, route: GrantRoute): boolean {
  if (authority.status !== "active" || authority.expiresAt <= now) return false
  const expected = Buffer.from(authority.grantSha256, "hex")
  const observed = Buffer.from(grantSha256(grant), "hex")
  if (expected.byteLength !== observed.byteLength || !timingSafeEqual(expected, observed)) return false
  return authority.allowed.some((candidate) => routeKey(candidate) === routeKey(route))
}

export function revokeGrant(authority: GrantAuthority): GrantAuthority {
  return deepFreeze({
    ...authority,
    status: "revoked" as const,
    allowed: authority.allowed.map((route) => ({ ...route })),
  })
}

export function grantSha256(grant: string): string {
  return createHash("sha256").update(grant, "utf8").digest("hex")
}

export function routeKey(route: GrantRoute): string {
  return `${route.provider}/${route.model}/${route.protocol}`
}

function validateRoute(route: GrantRoute): GrantRoute {
  const valid =
    (route.provider === "kimi" && route.model === "kimi-k3" && route.protocol === "chat_completions") ||
    (route.provider === "deepseek" &&
      (route.model === "deepseek-v4-pro" || route.model === "deepseek-v4-flash") &&
      route.protocol === "responses")
  if (!valid) throw new TypeError("BROKER_GRANT_ROUTE_INVALID")
  return Object.freeze({ ...route })
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value)
    Object.freeze(input)
  }
  return input
}
