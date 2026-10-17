import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import type { FileEntry } from "../corpus/manifest"
import { freeze, safePath } from "../corpus/evaluation-profile"
import { directRoot } from "../corpus/evaluation-bundle"
import { fileIdentity } from "./storage"
import type { AuthorityGuard } from "./contracts"
import {
  relayLimits,
  validateRelayRequest,
  validateRelayResponse,
  safeRelayPath,
  type RelayRequest,
  type BoundedHttpResponse,
  type RelayPolicy,
} from "./relay-protocol"

export type PreviewSource = Readonly<{
  root: string
  files: readonly FileEntry[]
  buildSha256: string
  exchange?: (request: RelayRequest, signal: AbortSignal) => Promise<BoundedHttpResponse>
  stop(): Promise<void>
}>
export type PreviewLease = Readonly<{
  capability: string
  previewID: string
  url: string
  buildSha256: string
  assets: readonly FileEntry[]
  stop(): Promise<void>
}>
const leases = new WeakMap<
  PreviewLease,
  { source: PreviewSource; policy: RelayPolicy; guard: AuthorityGuard; controller: AbortController }
>()
const response = (status: number): BoundedHttpResponse => ({ status, headers: [], body: new Uint8Array() })
export async function relayHttp(input: {
  lease: PreviewLease
  request: RelayRequest & { capability: string; previewID: string }
}): Promise<BoundedHttpResponse> {
  const state = leases.get(input.lease),
    r = input.request
  if (
    !state ||
    state.controller.signal.aborted ||
    r.capability !== input.lease.capability ||
    r.previewID !== input.lease.previewID
  )
    return response(404)
  if (!["GET", "HEAD", "POST"].includes(r.method)) return response(405)
  try {
    await state.guard()
    validateRelayRequest(r, state.policy)
  } catch {
    return response(404)
  }
  try {
    if (state.source.exchange) {
      const value = await state.source.exchange(r, state.controller.signal)
      validateRelayResponse(value)
      if (state.controller.signal.aborted) return response(404)
      return value
    }
    if (!["GET", "HEAD"].includes(r.method)) return response(405)
    const relative = safePath(r.path.slice(1)),
      file = state.source.files.find((f) => f.path === relative)
    if (!file) return response(404)
    const target = path.join(state.source.root, relative),
      before = await fileIdentity(target)
    if (before.sha256 !== file.sha256) return response(502)
    const body = await fs.readFile(target)
    if (
      body.length !== file.size ||
      body.length > relayLimits.responseBytes ||
      (await fileIdentity(target)).sha256 !== before.sha256
    )
      return response(502)
    const type = relative.endsWith(".html")
      ? "text/html; charset=utf-8"
      : relative.endsWith(".js") || relative.endsWith(".mjs")
        ? "text/javascript"
        : relative.endsWith(".css")
          ? "text/css"
          : relative.endsWith(".png")
            ? "image/png"
            : relative.endsWith(".pdf")
              ? "application/pdf"
              : "application/octet-stream"
    return { status: 200, headers: [["content-type", type]], body: r.method === "HEAD" ? new Uint8Array() : body }
  } catch {
    return response(502)
  }
}
export async function startLinuxPreview(input: {
  source: PreviewSource
  policy: RelayPolicy
  guard: AuthorityGuard
  signal: AbortSignal
}): Promise<PreviewLease> {
  await input.guard()
  await directRoot(input.source.root)
  if (input.signal.aborted || !/^[a-f0-9]{64}$/.test(input.source.buildSha256))
    throw new TypeError("TASK24_PREVIEW_BINDING")
  for (const p of input.policy.paths) safeRelayPath(p)
  const controller = new AbortController(),
    capability = randomBytes(32).toString("hex"),
    previewID = randomBytes(32).toString("hex")
  let stopped: Promise<void> | undefined
  let lease: PreviewLease
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: relayLimits.requestBytes,
    async fetch(r) {
      const url = new URL(r.url)
      if (r.headers.get("host") !== `127.0.0.1:${server.port}` || !url.pathname.startsWith(`/${capability}/`))
        return new Response(null, { status: 404 })
      const body = await r.bytes()
      const allowed = ["accept", "content-type", "cache-control"]
      const headers = Array.from(r.headers).filter(([k]) => allowed.includes(k))
      if (["authorization", "cookie", "upgrade", "transfer-encoding"].some((k) => r.headers.has(k)))
        return new Response(null, { status: 404 })
      const result = await relayHttp({
        lease,
        request: {
          capability,
          previewID,
          method: r.method,
          path: url.pathname.slice(capability.length + 1) + url.search,
          headers,
          body,
        },
      })
      return new Response(new Uint8Array(result.body).buffer, {
        status: result.status,
        headers: {
          ...Object.fromEntries(result.headers),
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'",
        },
      })
    },
  })
  const stop = () =>
    (stopped ??= (async () => {
      controller.abort()
      server.stop(true)
      await input.source.stop()
    })())
  const abort = () => {
    void stop().catch(() => {})
  }
  input.signal.addEventListener("abort", abort, { once: true })
  lease = freeze({
    capability,
    previewID,
    url: `http://127.0.0.1:${server.port}/${capability}/`,
    buildSha256: input.source.buildSha256,
    assets: structuredClone(input.source.files),
    async stop() {
      input.signal.removeEventListener("abort", abort)
      await stop()
    },
  })
  leases.set(lease, {
    source: input.source,
    policy: freeze(structuredClone(input.policy)),
    guard: input.guard,
    controller,
  })
  return lease
}
