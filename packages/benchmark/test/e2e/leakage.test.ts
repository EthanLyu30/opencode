import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { compilePriceBook } from "../../src/broker/pricing"
import { runSecurityAcceptance, scanDurableText } from "../../src/offline/security"
import { Task24Root } from "../../src/root"
import { priceFixture } from "../broker/price-fixture"

const cleanup: string[] = []
afterEach(async () => {
  while (cleanup.length > 0) await fs.rm(cleanup.pop()!, { recursive: true, force: true })
})

describe("Task24 offline security and leakage acceptance", () => {
  const exactSecurity = process.env.TASK24_EXACT_BINARY_SECURITY === "1" ? test : test.skip
  exactSecurity(
    "verifies real binary terminal/network rejection and records empty logs without invalid references",
    async () => {
      const layout = Task24Root.ensure()
      const candidate = await Bun.file(path.join(layout.runs, "preregistration.candidate.json")).json()
      const evidenceRoot = path.join(layout.runs, `test-security-exact-${crypto.randomUUID()}`)
      cleanup.push(evidenceRoot)
      const result = await runSecurityAcceptance(layout, compilePriceBook(candidate.pricing), {
        modified: {
          ...candidate.binaries.modified,
          runtime: "modified",
          executable: "D:\\OpenCode-Local\\bin\\opencode-local.exe",
        },
        upstream: {
          ...candidate.binaries.upstream,
          runtime: "upstream",
          executable: path.join(layout.toolchain, "upstream", "opencode.exe"),
        },
        evidenceRoot,
      })
      expect(result.exactBinaryChecks).toEqual([
        "exact_binary_incomplete",
        "exact_binary_failed",
        "exact_binary_external_network",
      ])
      expect(result.leaks).toBe(0)
      const evidence = await Bun.file(result.evidenceFile).json()
      expect(evidence.emptyLogs.length).toBeGreaterThan(0)
      expect(
        evidence.emptyLogs.every(
          (log: { bytes: number; sha256: string }) =>
            log.bytes === 0 && log.sha256 === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        ),
      ).toBe(true)
      expect(evidence.retainedEvidence.every((file: { bytes: number }) => file.bytes > 0)).toBe(true)
    },
    180_000,
  )

  test("rejects transport, traversal, replay, forged usage, oversized input, and evaluator mutation attacks", async () => {
    const result = await runSecurityAcceptance(Task24Root.ensure(), compilePriceBook(priceFixture))
    expect(result.leaks).toBe(0)
    expect(result.checks).toEqual([
      "remote_endpoint_injection",
      "public_transport_override",
      "external_network_tools",
      "workspace_traversal",
      "hidden_gold_access",
      "symlink_reparse_escape",
      "grant_replay",
      "fake_usage",
      "redaction_helper",
      "evaluator_mutation",
      "oversized_input_output",
    ])
  })

  test("scans durable text recursively and rejects keys or caller canaries", async () => {
    const root = path.join(Task24Root.ensure().tmp, `leakage-${crypto.randomUUID()}`)
    cleanup.push(root)
    await fs.mkdir(root)
    await fs.writeFile(path.join(root, "safe.json"), '{"status":"ok"}\n')
    await scanDurableText([root], ["PRIVATE_CANARY"])
    await fs.writeFile(path.join(root, "leak.log"), "sk-THIS_IS_A_FAKE_SECRET_KEY")
    await expect(scanDurableText([root], ["PRIVATE_CANARY"])).rejects.toThrow("TASK24_DURABLE_SECRET_LEAK")
  })

  test("scans individual process logs as well as directories", async () => {
    const root = path.join(Task24Root.ensure().tmp, `leakage-${crypto.randomUUID()}`)
    cleanup.push(root)
    await fs.mkdir(root)
    const log = path.join(root, "stdout.log")
    await fs.writeFile(log, "workflow completed\n")
    await scanDurableText([log], ["PRIVATE_CANARY"])
    await fs.writeFile(log, "PRIVATE_CANARY")
    await expect(scanDurableText([log], ["PRIVATE_CANARY"])).rejects.toThrow("TASK24_DURABLE_CANARY_LEAK")
    await fs.writeFile(log, "sk-THIS_IS_A_FAKE_SECRET_KEY")
    await expect(scanDurableText([log], [])).rejects.toThrow("TASK24_DURABLE_SECRET_LEAK")
  })
})
