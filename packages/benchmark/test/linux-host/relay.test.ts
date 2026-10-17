import { expect, test } from "bun:test"
import {
  decodeRelayFrame,
  encodeRelayFrame,
  validateRelayRequest,
  validateRelayResponse,
  relayLimits,
} from "../../src/sandbox/relay-protocol"
import { relayWorkerSource } from "../../src/sandbox/relay-worker"
import { sessionFixture } from "./fixture"
import { makeProcessRunner } from "../../src/sandbox/docker"

test("relay binary framing and headers have exact inclusive byte ceilings and no ambiguous HTTP framing", () => {
  const policy = { methods: ["GET", "POST"], paths: ["/api"] }
  const request = {
    method: "POST",
    path: "/api",
    headers: [["content-type", "application/octet-stream"]] as readonly (readonly [string, string])[],
    body: new Uint8Array(relayLimits.requestBytes),
  }
  const frame = encodeRelayFrame(request, relayLimits.requestBytes)
  expect(decodeRelayFrame(frame, relayLimits.requestBytes)).toEqual(request)
  validateRelayRequest(request, policy)
  for (const path of ["/%2e%2e/api", "/api%2f..", "http://canary/api", "//canary/api", "/api\\x", "/other"])
    expect(() => validateRelayRequest({ ...request, path }, policy)).toThrow()
  for (const headers of [
    [
      ["content-length", "1"],
      ["transfer-encoding", "chunked"],
    ],
    [
      ["x-test", "a"],
      ["X-Test", "b"],
    ],
    [["host", "evil"]],
    [["authorization", "key"]],
    [["x", "a\r\nb"]],
    [["upgrade", "websocket"]],
  ] as const)
    expect(() => validateRelayRequest({ ...request, headers }, policy)).toThrow()
  expect(() => validateRelayRequest({ ...request, method: "CONNECT" }, policy)).toThrow()
  expect(() =>
    validateRelayRequest({ ...request, body: new Uint8Array(relayLimits.requestBytes + 1) }, policy),
  ).toThrow()
  expect(() => decodeRelayFrame(Buffer.concat([frame, Buffer.from("x")]), relayLimits.requestBytes)).toThrow()
  validateRelayResponse({ status: 200, headers: [], body: new Uint8Array(relayLimits.responseBytes) })
  expect(() =>
    validateRelayResponse({ status: 200, headers: [], body: new Uint8Array(relayLimits.responseBytes + 1) }),
  ).toThrow()
  expect(() =>
    validateRelayResponse({
      status: 200,
      headers: [["x", "a".repeat(relayLimits.headerBytes)]],
      body: new Uint8Array(),
    }),
  ).toThrow()
})

test("actual own HTTP fixture crosses framed stdin with binary POST and same-origin redirect enforcement", async () => {
  const f = await sessionFixture()
  let hits = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(r) {
      hits++
      const p = new URL(r.url).pathname
      if (p === "/cross") return new Response(null, { status: 302, headers: { location: "http://example.invalid/" } })
      if (p.startsWith("/hop"))
        return new Response(null, { status: 302, headers: { location: `/hop${Number(p.slice(4)) + 1}` } })
      return new Response(await r.arrayBuffer(), { headers: { "content-type": "application/octet-stream" } })
    },
  })
  try {
    const runner = makeProcessRunner({
      executable: process.execPath,
      argvPrefix: ["--no-env-file"],
      cwd: f.root,
      env: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
      ),
    })
    const run = (path: string, body = Buffer.from([0, 255, 1])) =>
      runner.execute({
        argv: ["-e", relayWorkerSource(), String(server.port)],
        stdin: encodeRelayFrame({ method: "POST", path, headers: [], body }, relayLimits.requestBytes),
        timeoutMs: 10000,
        maxStdoutBytes: relayLimits.responseBytes + relayLimits.headerBytes + 4,
        maxStderrBytes: 65536,
        signal: new AbortController().signal,
      })
    const r = await run("/echo")
    expect(r.exitCode).toBe(0)
    expect(decodeRelayFrame(r.stdout, relayLimits.responseBytes).body).toEqual(Buffer.from([0, 255, 1]))
    expect((await run("/cross")).exitCode).not.toBe(0)
    expect((await run("/hop0")).exitCode).not.toBe(0)
    expect(hits).toBe(6)
  } finally {
    server.stop(true)
    await f.dispose()
  }
})
