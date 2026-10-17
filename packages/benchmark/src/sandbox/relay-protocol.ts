import { Schema } from "effect"
export const relayLimits = Object.freeze({
  requestBytes: 1048576,
  responseBytes: 8388608,
  headerBytes: 32768,
  timeoutMs: 30000,
  redirects: 3,
})
export type RelayPolicy = Readonly<{ methods: readonly string[]; paths: readonly string[] }>
export type RelayHeaders = readonly (readonly [string, string])[]
export type RelayRequest = Readonly<{ method: string; path: string; headers: RelayHeaders; body: Uint8Array }>
export type BoundedHttpResponse = Readonly<{ status: number; headers: RelayHeaders; body: Uint8Array }>
const Headers = Schema.Array(Schema.Tuple([Schema.String, Schema.String]))
const Header = Schema.Union([
  Schema.Struct({ method: Schema.String, path: Schema.String, headers: Headers, bodyBytes: Schema.Int }),
  Schema.Struct({ status: Schema.Int, headers: Headers, bodyBytes: Schema.Int }),
])
export function safeRelayPath(value: string) {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\x00-\x20\x7f#]/.test(value) ||
    /%(?:2e|2f|5c|00|0[ad]|25)/i.test(value) ||
    value.split(/[/?]/).some((p) => p === ".." || p === ".")
  )
    throw new TypeError("TASK24_RELAY_PATH")
  return value
}
function headers(entries: RelayHeaders) {
  const seen = new Set<string>()
  if (Buffer.byteLength(JSON.stringify(entries)) > relayLimits.headerBytes)
    throw new TypeError("TASK24_RELAY_HEADERS_SIZE")
  for (const [name, value] of entries) {
    const key = name.toLowerCase()
    if (
      !/^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(name) ||
      /[\x00-\x1f\x7f]/.test(value) ||
      seen.has(key) ||
      [
        "host",
        "authorization",
        "proxy-authorization",
        "cookie",
        "set-cookie",
        "connection",
        "upgrade",
        "transfer-encoding",
        "content-length",
        "te",
        "trailer",
        "proxy-connection",
        "forwarded",
      ].includes(key) ||
      key.startsWith("x-forwarded-")
    )
      throw new TypeError("TASK24_RELAY_HEADERS")
    seen.add(key)
  }
}
export function validateRelayRequest(value: RelayRequest, policy: RelayPolicy) {
  safeRelayPath(value.path)
  headers(value.headers)
  if (!["GET", "HEAD", "POST"].includes(value.method) || !policy.methods.includes(value.method))
    throw new TypeError("TASK24_RELAY_METHOD")
  if (!policy.paths.includes(value.path)) throw new TypeError("TASK24_RELAY_PATH")
  if (
    value.body.byteLength > relayLimits.requestBytes ||
    ((value.method === "GET" || value.method === "HEAD") && value.body.length)
  )
    throw new TypeError("TASK24_RELAY_BODY")
}
export function validateRelayResponse(value: BoundedHttpResponse) {
  headers(value.headers)
  if (
    !Number.isInteger(value.status) ||
    value.status < 200 ||
    value.status > 599 ||
    value.body.byteLength > relayLimits.responseBytes
  )
    throw new TypeError("TASK24_RELAY_RESPONSE")
}
export function encodeRelayFrame(value: RelayRequest | BoundedHttpResponse, maxBody: number) {
  if (value.body.byteLength > maxBody) throw new TypeError("TASK24_RELAY_BODY")
  const { body, ...head } = value
  const header = Buffer.from(JSON.stringify({ ...head, bodyBytes: body.byteLength }))
  if (header.length > relayLimits.headerBytes) throw new TypeError("TASK24_RELAY_HEADERS_SIZE")
  const size = Buffer.alloc(4)
  size.writeUInt32BE(header.length)
  return Buffer.concat([size, header, body])
}
export function decodeRelayFrame(bytes: Uint8Array, maxBody: number): RelayRequest | BoundedHttpResponse {
  const data = Buffer.from(bytes)
  if (data.length < 4) throw new TypeError("TASK24_RELAY_FRAME")
  const size = data.readUInt32BE(0)
  if (size > relayLimits.headerBytes || data.length < size + 4 || data.length > size + 4 + maxBody)
    throw new TypeError("TASK24_RELAY_FRAME")
  const { bodyBytes, ...head } = Schema.decodeUnknownSync(Header)(
    JSON.parse(data.subarray(4, 4 + size).toString("utf8")),
    { onExcessProperty: "error" },
  )
  if (bodyBytes !== data.length - size - 4) throw new TypeError("TASK24_RELAY_FRAME")
  return { ...head, body: data.subarray(4 + size) }
}
