import { expect, test } from "bun:test"
import { isAdmittedLinuxBrowserURL, validateBrowserProbe } from "../../src/sandbox/browser"
import { identity, candidate } from "../independent/fixture"
import { makeProbeRequest } from "../../src/evaluator/independent/probe"
import { orchestratorFixture } from "../independent/fixture"
import { requireBrowserTrace } from "../../src/sandbox/browser"

test("browser admission requires its exact capability origin and paths; never attemptID, broker, WS or file", async () => {
  const base = "http://127.0.0.1:32123/" + "a".repeat(64) + "/",
    paths = ["/page.html", "/public/chart.js"]
  expect(isAdmittedLinuxBrowserURL(base + "page.html", base, paths)).toBe(true)
  expect(() => requireBrowserTrace({ identity: identity(), resultSha256: "a".repeat(64) }, identity())).toThrow()
  for (const url of [
    "file:///D:/private/key",
    "data:text/html,x",
    "ws://127.0.0.1:32123/",
    base.replace("a".repeat(64), identity().attemptID) + "page.html",
    base + "../broker",
    base + "%2e%2e/key",
    base.replace(":32123", ":32124") + "page.html",
    base + "private/oracle.json",
  ])
    expect(isAdmittedLinuxBrowserURL(url, base, paths)).toBe(false)
  const f = await orchestratorFixture()
  try {
    const request = makeProbeRequest({
      identity: identity(),
      profile: f.input.bundle.profile,
      inputs: {
        candidate,
        module: "src/math.js",
        cases: [{ id: "sum", operations: [{ kind: "call", target: "add", args: [2, 3] }] }],
      },
    })
    validateBrowserProbe(request)
    expect(() => validateBrowserProbe({ ...request, expected: 5 })).toThrow()
    expect(() =>
      validateBrowserProbe({
        ...request,
        operations: [{ id: "sum", steps: [{ kind: "eval", target: "add", args: [] }] }],
      }),
    ).toThrow()
    expect(() =>
      validateBrowserProbe({
        ...request,
        operations: [{ id: "sum", steps: [{ kind: "get", target: "constructor.prototype", args: [] }] }],
      }),
    ).toThrow()
    expect(() =>
      validateBrowserProbe({
        ...request,
        operations: [{ id: "sum", steps: [{ kind: "call", target: "add", args: [{ $ref: "__proto__.x" }] }] }],
      }),
    ).toThrow()
  } finally {
    await f.dispose()
  }
})
import { validateBrowserAdmission } from "../../src/sandbox/browser"
test("browser adversarial matrix accepts only an owned local canary and task-specific D fixture", () => {
  const data = {
    canaryURL: "http://127.0.0.1:12345/" + "a".repeat(64),
    fileURL: "file:///D:/OpenCode-Benchmark/Task24/tmp/own/canary.txt",
  }
  expect(() => validateBrowserAdmission(data)).not.toThrow()
  for (const c of [
    { ...data, canaryURL: "https://api.deepseek.com" },
    { ...data, fileURL: "file:///C:/Users/Administrator/.env" },
    { ...data, canaryURL: "http://127.0.0.1:12345/short" },
  ])
    expect(() => validateBrowserAdmission(c)).toThrow()
})
