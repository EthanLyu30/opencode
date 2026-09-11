import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {
  assertRecordedStaticImplementationCapability,
  type RecordedStaticImplementationCapability,
} from "./lib/workflow-production-runtime"

const hex = (value: string) => value.repeat(64).slice(0, 64)

function expectedCapability(): RecordedStaticImplementationCapability {
  return {
    revision: 2,
    configurationSha256: hex("a"),
    sourceSha256: hex("b"),
    previewLease: {
      workflowID: "wrk_recorded_static_capability" as never,
      stageID: "stg_recorded_static_capability" as never,
      attempt: 3,
      leaseOwner: "worker-recorded-static-capability",
      leaseExpiresAt: 90_000,
    },
  }
}

async function fixture(input: { readonly manifest: boolean }) {
  const root = path.join(
    "D:\\OpenCode-Local\\tmp\\workflow-host\\acceptance",
    `production-runtime-${crypto.randomUUID()}`,
  )
  const hostID = hex("c")
  const directory = path.join(root, hostID)
  await fs.mkdir(directory, { recursive: true })
  const expected = expectedCapability()
  const manifest = path.join(directory, ".host.json")
  if (input.manifest) {
    await fs.writeFile(
      manifest,
      JSON.stringify({
        hostID,
        createdAt: 80_000,
        kind: "static",
        purpose: "implementation",
        revision: expected.revision,
        configurationSha256: expected.configurationSha256,
        sourceSha256: expected.sourceSha256,
        claimKey: hex("d"),
        claimGeneration: hex("e"),
        claimSha256: hex("f"),
        workflowID: expected.previewLease.workflowID,
        stageID: expected.previewLease.stageID,
        attempt: expected.previewLease.attempt,
        leaseOwner: expected.previewLease.leaseOwner,
        leaseExpiresAt: expected.previewLease.leaseExpiresAt + 5_000,
        nonce: hex("1"),
      }),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    )
  }
  return {
    root,
    hostID,
    expected,
    async cleanup() {
      if (input.manifest) await fs.unlink(manifest)
      await fs.rmdir(directory)
      await fs.rmdir(root)
    },
  }
}

test("binds a recorded static implementation URL to its exact host manifest", async () => {
  const item = await fixture({ manifest: true })
  try {
    await expect(assertRecordedStaticImplementationCapability(item.root, item.hostID, item.expected)).resolves.toBe(
      undefined,
    )
    await expect(
      assertRecordedStaticImplementationCapability(item.root, item.hostID, {
        ...item.expected,
        revision: item.expected.revision + 1,
      }),
    ).rejects.toThrow("implementation capability manifest")
  } finally {
    await item.cleanup()
  }
})

test("rejects an arbitrary static implementation host ID without owned manifest authority", async () => {
  const item = await fixture({ manifest: false })
  try {
    await expect(assertRecordedStaticImplementationCapability(item.root, item.hostID, item.expected)).rejects.toThrow(
      "implementation capability manifest",
    )
  } finally {
    await item.cleanup()
  }
})
