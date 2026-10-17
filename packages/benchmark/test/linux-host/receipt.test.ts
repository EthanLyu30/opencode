import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { recordOperationReceipt, verifyOperationReceipt } from "../../src/sandbox/receipt"
import { createOwnedContainer } from "../../src/sandbox/ownership"
import { sessionFixture } from "./fixture"
import { makeDockerRunner } from "../../src/sandbox/docker"

test("operation receipts bind inspect, manifest, evidence bytes and owner; fixture is not Linux assurance", async () => {
  const f = await sessionFixture()
  try {
    const owner = await createOwnedContainer({
      session: f.session,
      runner: f.runner,
      owner: f.owner,
      spec: { image: f.image, argv: ["/opt/task24/worker"] },
      guard: async () => {},
      signal: new AbortController().signal,
    })
    const receipt = await recordOperationReceipt({
      session: f.session,
      runner: f.runner,
      owner,
      operation: "create",
      binding: null,
      argv: ["container", "create"],
      inspect: f.inspect(),
      execution: { started: true, exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false },
      evidenceRoot: f.request.roots.evidence,
    })
    expect(receipt.assurance).toBe("fixture")
    await expect(
      recordOperationReceipt({
        session: f.session,
        runner: makeDockerRunner({ request: f.request }),
        owner,
        operation: "create",
        binding: null,
        argv: ["container", "create"],
        inspect: f.inspect(),
        execution: { started: true, exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false },
        evidenceRoot: f.request.roots.evidence,
      }),
    ).rejects.toThrow("TASK24_LINUX_EXECUTION_AUTHORITY")
    expect(
      verifyOperationReceipt({ receipt, manifest: f.manifest, evidenceRoot: f.request.roots.evidence }).owner
        .containerID,
    ).toBe(f.id)
    expect(() =>
      verifyOperationReceipt({
        receipt: { ...receipt, assurance: "linux-attested" },
        manifest: f.manifest,
        evidenceRoot: f.request.roots.evidence,
      }),
    ).toThrow()
    await fs.appendFile(path.join(f.request.roots.evidence, receipt.evidence.relativePath), "tampered")
    expect(() =>
      verifyOperationReceipt({ receipt, manifest: f.manifest, evidenceRoot: f.request.roots.evidence }),
    ).toThrow()
  } finally {
    await f.dispose()
  }
})
