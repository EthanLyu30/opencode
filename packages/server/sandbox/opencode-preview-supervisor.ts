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
const listen = endpoint(input.listen)
const target = endpoint(input.target)
if (listen.host !== "0.0.0.0" || listen.port !== 18_080) fail("listen endpoint is not approved")
if (target.host !== "127.0.0.1" || target.port !== 18_081) fail("target endpoint is not approved")

const runtime = [...input.runtime]
const child = Bun.spawn(runtime, {
  env: Object.freeze({ ...process.env }),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

const server = Bun.serve({
  hostname: listen.host,
  port: listen.port,
  fetch: async (request) => {
    if (request.headers.get("upgrade") !== null) return new Response("WebSocket relay is unavailable", { status: 426 })
    const source = new URL(request.url)
    if (source.hostname !== "127.0.0.1") return new Response("Preview host is unavailable", { status: 421 })
    const destination = new URL(`${source.pathname}${source.search}`, `http://${target.host}:${target.port}`)
    const headers = filteredHeaders(request.headers)
    headers.set("x-forwarded-host", source.host)
    headers.set("x-forwarded-proto", "http")
    const deadline = Date.now() + 30_000
    while (true) {
      try {
        const response = await fetch(destination, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          redirect: "manual",
          signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, deadline - Date.now()))),
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
        if (Date.now() >= deadline || child.exitCode !== null) {
          return new Response("Preview target is unavailable", { status: 503 })
        }
        await Bun.sleep(Math.min(50, Math.max(1, deadline - Date.now())))
      }
    }
  },
  error: () => new Response("Preview relay failed", { status: 502 }),
})

const forward = (signal: NodeJS.Signals) => {
  if (child.exitCode === null) child.kill(signal)
}
process.once("SIGINT", () => forward("SIGINT"))
process.once("SIGTERM", () => forward("SIGTERM"))

const exit = await child.exited
await server.stop(true)
process.exit(Number.isSafeInteger(exit) && exit >= 0 && exit <= 255 ? exit : 1)

function parse(argv: readonly string[]) {
  const divider = argv.indexOf("--")
  if (
    divider !== 4 ||
    argv[0] !== "--listen" ||
    argv[2] !== "--target" ||
    argv[1] === undefined ||
    argv[3] === undefined ||
    argv.length < 6
  ) {
    fail("usage: opencode-preview-supervisor --listen HOST:PORT --target HOST:PORT -- PROGRAM [ARG ...]")
  }
  return { listen: argv[1], target: argv[3], runtime: argv.slice(5) }
}

function endpoint(value: string) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value)
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
