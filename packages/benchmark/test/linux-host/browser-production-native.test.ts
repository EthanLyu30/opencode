import { expect, test } from "bun:test"
import { browserLaunchPolicy } from "../../src/sandbox/browser-helper"
import { enforcedDataFrameViolation, dataFrameWasBlocked } from "../../src/sandbox/browser-contracts"

test("data admission accepts enforced browser CSP evidence, not synthetic or unrelated violations", () => {
  const accepts = enforcedDataFrameViolation
  expect(typeof accepts).toBe("function")
  const event = {
    isTrusted: true,
    disposition: "enforce",
    effectiveDirective: "frame-src",
    blockedURI: "",
    originalPolicy: "default-src 'self'; frame-src 'none'; object-src 'none'",
  }
  expect(accepts(event)).toBe(true)
  expect(accepts({ ...event, blockedURI: "data" })).toBe(true)
  expect(accepts({ ...event, isTrusted: false })).toBe(false)
  expect(accepts({ ...event, disposition: "report" })).toBe(false)
  expect(accepts({ ...event, effectiveDirective: "connect-src" })).toBe(false)
  expect(accepts({ ...event, originalPolicy: "frame-src 'self'" })).toBe(false)
  expect(accepts({ ...event, originalPolicy: "frame-src 'self'; frame-src 'none'" })).toBe(false)
  expect(accepts({ ...event, blockedURI: "https://elsewhere.invalid" })).toBe(false)
  expect(dataFrameWasBlocked({ executed: false, closed: true, frameURL: "", cspDenied: false })).toBe(false)
})

test("production Chromium children retain the exact private executable spelling used by native policy", () => {
  const browser = "D:\\OpenCode-Benchmark\\Task24\\tmp\\own\\browser\\chrome.exe"
  expect(browserLaunchPolicy(browser).args).toContain("--browser-subprocess-path=" + browser)
  expect(browserLaunchPolicy(browser).chromiumSandbox).toBe(true)
  expect(browserLaunchPolicy(browser).args).not.toContain("--no-sandbox")
})

test("production browser supervisor rejects outside-D storage before any native process", async () => {
  const module = await import("../../src/sandbox/host-isolation/windows")
  const run = Reflect.get(module, "runWindowsBrowserProtocol")
  expect(typeof run).toBe("function")
  await expect(run({ root: "C:\\forbidden" })).rejects.toThrow("TASK24_BROWSER_ISOLATION_INPUT")
})
