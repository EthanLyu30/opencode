#!/usr/local/bin/bun

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

const input = parse(Bun.argv.slice(2))
const listen = endpoint(input.listen, false)
const target = endpoint(input.target, true)
if (listen.host !== "0.0.0.0" || listen.port !== 18_080) fail("listen endpoint is not approved")
if (!/^ocp-[a-f0-9]{48}$/.test(target.host) || target.port !== 18_080) fail("target endpoint is not approved")

const server = Bun.serve({
  hostname: listen.host,
  port: listen.port,
  fetch: async (request) => {
    if (request.headers.get("upgrade") !== null) return new Response("WebSocket relay is unavailable", { status: 426 })
    const source = new URL(request.url)
    if (source.hostname !== "127.0.0.1") return new Response("Preview ingress is unavailable", { status: 421 })
    const destination = new URL(`${source.pathname}${source.search}`, `http://${target.host}:${target.port}`)
    const headers = filteredHeaders(request.headers)
    headers.set("host", "127.0.0.1")
    headers.set("x-forwarded-host", source.host)
    headers.set("x-forwarded-proto", "http")
    try {
      const response = await fetch(destination, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      })
      const responseHeaders = filteredHeaders(response.headers)
      const location = responseHeaders.get("location")
      if (location !== null) {
        const redirect = new URL(location, destination)
        if (redirect.origin === destination.origin) {
          responseHeaders.set("location", `${source.origin}${redirect.pathname}${redirect.search}${redirect.hash}`)
        }
      }
      return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    } catch {
      return new Response("Preview target is unavailable", { status: 503 })
    }
  },
  error: () => new Response("Preview ingress failed", { status: 502 }),
})

const stop = async () => {
  await server.stop(true)
  process.exit(0)
}
process.once("SIGINT", () => void stop())
process.once("SIGTERM", () => void stop())
await new Promise(() => undefined)

function parse(argv: readonly string[]) {
  if (
    argv.length !== 4 ||
    argv[0] !== "--listen" ||
    argv[2] !== "--target" ||
    argv[1] === undefined ||
    argv[3] === undefined
  ) {
    fail("usage: opencode-preview-ingress --listen HOST:PORT --target HOST:PORT")
  }
  return { listen: argv[1], target: argv[3] }
}

function endpoint(value: string, hostname: boolean) {
  const expression = hostname ? /^([a-z0-9-]+):(\d{1,5})$/ : /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/
  const match = expression.exec(value)
  const port = Number(match?.[2])
  if (match === null || !Number.isSafeInteger(port) || port < 1 || port > 65_535) fail("invalid endpoint")
  return { host: match[1], port }
}

function filteredHeaders(input: Headers) {
  const output = new Headers()
  input.forEach((value, name) => {
    if (name.toLowerCase() !== "host" && !hopByHopHeaders.has(name.toLowerCase())) output.append(name, value)
  })
  return output
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(64)
}
