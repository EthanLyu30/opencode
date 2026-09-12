import { createHash } from "node:crypto"
import type { PriceBook } from "./pricing"
import { conservativeInputTokens, authorizeRequest, BrokerRequestError } from "./policy"
import { BrokerLedger, type Service as LedgerService } from "./ledger"
import { grantSha256, mintGrant } from "./grant"
import { observeProviderStream } from "./stream"

type ProviderKeys = Readonly<{ kimi: string; deepseek: string }>

export interface StartBrokerOptions {
  readonly database: string
  readonly campaignID: string
  readonly runID: string
  readonly expiresAt: number
  readonly maximumCalls: number
  readonly ceilings: Readonly<{ CNY: bigint; USD: bigint }>
  readonly prices: PriceBook
  readonly providerKeys: ProviderKeys
  readonly upstream: (request: Request) => Promise<Response>
}

export interface RunningBroker extends AsyncDisposable {
  readonly origin: string
  readonly grant: string
  readonly database: string
  readonly ledger: LedgerService
}

const routes = new Set(["/v1/kimi/chat/completions", "/v1/deepseek/responses"])
const maximumRequestBytes = 8 * 1024 * 1024

export async function startBroker(options: StartBrokerOptions): Promise<RunningBroker> {
  validateSecret(options.providerKeys.kimi)
  validateSecret(options.providerKeys.deepseek)
  const ledger = BrokerLedger.open({ database: options.database, prices: options.prices, ceilings: options.ceilings })
  const minted = mintGrant({
    campaignID: options.campaignID,
    runID: options.runID,
    expiresAt: options.expiresAt,
    maximumCalls: options.maximumCalls,
    allowed: [
      { provider: "kimi", model: "kimi-k3", protocol: "chat_completions" },
      { provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses" },
      { provider: "deepseek", model: "deepseek-v4-flash", protocol: "responses" },
    ],
  })
  ledger.registerGrant(minted.authority)
  let disposed = false
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => handle(request, options, ledger),
    })
  } catch (cause) {
    ledger.revokeGrant(minted.authority.grantSha256)
    ledger.close()
    throw cause
  }
  return Object.freeze({
    origin: `http://127.0.0.1:${server.port}`,
    grant: minted.grant,
    database: options.database,
    ledger,
    async [Symbol.asyncDispose]() {
      if (disposed) return
      disposed = true
      await server.stop(true)
      ledger.revokeGrant(grantSha256(minted.grant))
      ledger.close()
    },
  })
}

async function handle(request: Request, options: StartBrokerOptions, ledger: LedgerService): Promise<Response> {
  let reservedRequestID: string | undefined
  try {
    const url = new URL(request.url)
    if (!routes.has(url.pathname)) throw new BrokerRequestError(404, "BROKER_ROUTE_NOT_FOUND")
    if (request.method !== "POST") throw new BrokerRequestError(405, "BROKER_METHOD_NOT_ALLOWED")
    const grant = bearer(request.headers.get("authorization"))
    if (!grant) throw new BrokerRequestError(401, "BROKER_GRANT_REQUIRED")
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (bytes.byteLength > maximumRequestBytes) throw new BrokerRequestError(413, "BROKER_REQUEST_TOO_LARGE")
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new BrokerRequestError(400, "BROKER_REQUEST_JSON_INVALID")
    }
    const authorized = authorizeRequest(url.pathname, body)
    try {
      ledger.authorizeGrant({
        grant,
        route: authorized,
        campaignID: options.campaignID,
        runID: options.runID,
        now: Date.now(),
      })
    } catch {
      throw new BrokerRequestError(401, "BROKER_GRANT_INVALID")
    }
    const requestID = crypto.randomUUID()
    reservedRequestID = requestID
    ledger.reserve({
      requestID,
      campaignID: options.campaignID,
      runID: options.runID,
      provider: authorized.provider,
      model: authorized.model,
      protocol: authorized.protocol,
      route: authorized.route,
      requestBytes: bytes.byteLength,
      requestSha256: digest(bytes),
      inputTokenBound: conservativeInputTokens(bytes.byteLength),
      maximumOutputTokens: authorized.maximumOutputTokens,
      priceSha256: options.prices[authorized.provider].sha256,
      at: new Date().toISOString(),
    })
    let upstream: Response
    try {
      upstream = await options.upstream(
        new Request(upstreamUrl(authorized.provider), {
          method: "POST",
          headers: upstreamHeaders(request.headers, options.providerKeys[authorized.provider]),
          body: bytes,
        }),
      )
    } catch {
      ledger.settle({
        requestID,
        resultClass: "upstream_error",
        responseBytes: 0,
        responseSha256: digest(new Uint8Array()),
        at: new Date().toISOString(),
      })
      return safeError(502, "BROKER_UPSTREAM_UNAVAILABLE")
    }
    if (!upstream.body) {
      ledger.settle({
        requestID,
        resultClass: upstream.ok ? "malformed" : "upstream_error",
        responseBytes: 0,
        responseSha256: digest(new Uint8Array()),
        at: new Date().toISOString(),
      })
      return new Response(null, { status: upstream.status, headers: responseHeaders(upstream.headers) })
    }
    const stream = observeProviderStream({
      body: upstream.body,
      protocol: authorized.protocol,
      successful: upstream.ok,
      onFinish(observation) {
        ledger.settle({ requestID, ...observation, at: new Date().toISOString() })
      },
    })
    return new Response(stream, { status: upstream.status, headers: responseHeaders(upstream.headers) })
  } catch (cause) {
    if (reservedRequestID) {
      try {
        ledger.settle({
          requestID: reservedRequestID,
          resultClass: "failed",
          responseBytes: 0,
          responseSha256: digest(new Uint8Array()),
          at: new Date().toISOString(),
        })
      } catch {
        // The original boundary failure remains authoritative.
      }
    }
    if (cause instanceof BrokerRequestError) return safeError(cause.status, cause.code)
    if (cause instanceof Error && cause.message === "BUDGET_RESERVATION_EXCEEDED") {
      return safeError(402, "BUDGET_RESERVATION_EXCEEDED")
    }
    return safeError(500, "BROKER_INTERNAL_ERROR")
  }
}

function bearer(value: string | null): string | undefined {
  if (!value?.startsWith("Bearer ")) return undefined
  const grant = value.slice(7)
  return grant.length > 0 && !/\s/.test(grant) ? grant : undefined
}

function upstreamHeaders(source: Headers, key: string): Headers {
  const result = new Headers({ authorization: `Bearer ${key}`, "content-type": "application/json" })
  for (const name of ["accept", "user-agent"] as const) {
    const value = source.get(name)
    if (value) result.set(name, value)
  }
  return result
}

function responseHeaders(source: Headers): Headers {
  const result = new Headers()
  const contentType = source.get("content-type")
  if (contentType) result.set("content-type", contentType)
  return result
}

function upstreamUrl(provider: "kimi" | "deepseek"): string {
  return provider === "kimi" ? "https://api.moonshot.cn/v1/chat/completions" : "https://api.deepseek.com/responses"
}

function safeError(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status })
}

function validateSecret(value: string): void {
  if (!value.startsWith("sk-") || /\s/.test(value)) throw new TypeError("BROKER_PROVIDER_KEY_INVALID")
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}
