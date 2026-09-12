import { describe, expect, test } from "bun:test"
import { sealFairnessFingerprint, verifyFairnessFingerprint } from "../../src/campaign/fairness"

const sha = (digit: string) => digit.repeat(64)

function fixture() {
  return {
    schemaVersion: 1 as const,
    capturedAt: "2026-09-12T12:00:00.000Z",
    roots: {
      task24: "D:\\OpenCode-Benchmark\\Task24",
      bun: "D:\\OpenCode-Toolchain\\bun-1.3.14\\bun-windows-x64\\bun.exe",
      browserRuntime:
        "D:\\OpenCode-Benchmark\\Task24\\toolchain\\browser\\2b1d4571560f5ce2772a46246070649c47bcdd77a634ab70dbf68bd35f5a967e",
      upstreamSource: "D:\\OpenCode-Benchmark\\Task24\\toolchain\\upstream-src",
    },
    runtime: {
      bunVersion: "1.3.14",
      nodeVersion: "24.18.0",
      playwrightVersion: "1.59.1",
      chromiumRevision: "chromium-1234567",
      operatingSystem: "Windows 10 10.0.26200",
      locale: "zh-CN",
      timeZone: "Asia/Shanghai",
    },
    docker: {
      engineVersion: "29.5.3",
      imageDigest: `sha256:${sha("6")}`,
    },
    fonts: [
      { name: "Segoe UI", path: "C:\\Windows\\Fonts\\segoeui.ttf", sha256: sha("8") },
      { name: "Consolas", path: "C:\\Windows\\Fonts\\consola.ttf", sha256: sha("9") },
    ],
    viewports: {
      mobile: { width: 390, height: 844, deviceScaleFactor: 1 },
      tablet: { width: 768, height: 1024, deviceScaleFactor: 1 },
      desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
    },
    evaluatorCommands: ["bun test --timeout 30000", "bun run typecheck"],
    allowedDependencyMirrors: [] as string[],
    externalNetworkPolicy: "deny-except-approved-provider-broker",
  }
}

describe("Task24 fairness fingerprint", () => {
  test("seals every fixed runtime and fairness input deterministically", () => {
    const first = sealFairnessFingerprint(fixture())
    const second = sealFairnessFingerprint(fixture())

    expect(first).toEqual(second)
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(verifyFairnessFingerprint(first)).toEqual({ ok: true, fingerprint: first })
  })

  test("rejects mutable container identities and non-D benchmark/tool roots", () => {
    expect(() =>
      sealFairnessFingerprint({ ...fixture(), docker: { ...fixture().docker, imageDigest: "oven/bun:latest" } }),
    ).toThrow(/sha256|fingerprint/i)
    expect(() =>
      sealFairnessFingerprint({ ...fixture(), roots: { ...fixture().roots, browserRuntime: "C:\\runtime" } }),
    ).toThrow(/fingerprint/i)
    expect(() =>
      sealFairnessFingerprint({
        ...fixture(),
        fonts: [{ name: "Unsafe", path: "C:\\Users\\Public\\unsafe.ttf", sha256: sha("8") }],
      }),
    ).toThrow(/fingerprint/i)
    expect(() =>
      sealFairnessFingerprint({
        ...fixture(),
        fonts: [{ name: "Relative", path: "fonts\\relative.ttf", sha256: sha("8") }],
      }),
    ).toThrow(/fingerprint/i)
  })

  test("detects post-seal mutation", () => {
    const sealed = sealFairnessFingerprint(fixture())
    expect(verifyFairnessFingerprint({ ...sealed, evaluatorCommands: ["bun test changed"] })).toEqual({
      ok: false,
      reason: "FAIRNESS_FINGERPRINT_HASH_MISMATCH",
    })
  })
})
