import { afterAll, describe, expect, test } from "bun:test"
import { WorkflowVisualReviewArtifact } from "@opencode-ai/core/workflow/artifacts/visual-review"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { WorkflowSchema as Workflow } from "@opencode-ai/core/workflow"
import { DateTime, Effect, Scope } from "effect"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { EvidenceLedger } from "../src/workflow/evidence-ledger"

const testRoot = "D:\\OpenCode-Local\\tmp\\workflow-evidence-ledger-tests"
const workflowID = Workflow.ID.make("wfl_evidence_ledger")

afterAll(async () => {
  await removeTestRoot(testRoot)
})

describe("EvidenceLedger durable staging", () => {
  test("persists a capturing intent before bytes and fences a foreign restart owner", async () => {
    await using temp = await taskTemp()
    const coordinates = await evidenceCoordinates("wfs_evidence_capture")
    const first = EvidenceLedger.open(temp.path)
    expect(await first.beginCapture({ coordinates, ownerNonce: "a".repeat(64), now: 1 })).toEqual({
      status: "acquired",
    })
    await first.close()

    const restored = EvidenceLedger.open(temp.path)
    expect(await restored.beginCapture({ coordinates, ownerNonce: "b".repeat(64), now: 2 })).toEqual({
      status: "ambiguous",
    })
    expect(await restored.used(String(workflowID))).toBe(0)
    await expect(restored.clearCapture({ coordinates, ownerNonce: "b".repeat(64) })).rejects.toThrow()
    expect(await restored.clearCapture({ coordinates, ownerNonce: "a".repeat(64) })).toBe(true)
    await restored.close()
  })

  test("atomically completes one exact owner capture and returns validated bytes after restart", async () => {
    await using temp = await taskTemp()
    const coordinates = await evidenceCoordinates("wfs_evidence_complete")
    const bytes = WorkflowVisualHost.deterministicPng(coordinates.viewport)
    const image = WorkflowVisualHost.capturedImage(coordinates, bytes)
    const ledger = EvidenceLedger.open(temp.path)
    expect(await ledger.beginCapture({ coordinates, ownerNonce: "c".repeat(64), now: 1 })).toEqual({
      status: "acquired",
    })
    const completed = await ledger.completeCapture({
      receipt: image.receipt,
      bytes,
      ownerNonce: "c".repeat(64),
      now: 2,
      limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
    })
    expect(completed).toMatchObject({ state: "staged", receipt: image.receipt })
    expect(completed.bytes).toEqual(bytes)
    await ledger.close()

    const restored = EvidenceLedger.open(temp.path)
    const loaded = await restored.get(coordinates)
    expect(loaded).toMatchObject({ state: "staged", receipt: image.receipt })
    expect(loaded?.bytes).toEqual(bytes)
    expect(await restored.used(String(workflowID))).toBe(bytes.byteLength)
    expect(await restored.beginCapture({ coordinates, ownerNonce: "d".repeat(64), now: 3 })).toMatchObject({
      status: "existing",
      item: { state: "staged" },
    })
    await restored.close()
  })

  test("keeps quota plus item completion atomic at the exact aggregate boundary", async () => {
    await using temp = await taskTemp()
    const firstKey = await evidenceCoordinates("wfs_evidence_quota_a")
    const secondKey = await evidenceCoordinates("wfs_evidence_quota_b")
    const bytes = WorkflowVisualHost.deterministicPng(firstKey.viewport)
    const ledger = EvidenceLedger.open(temp.path)
    expect(
      await ledger.reserve(
        String(workflowID),
        WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES - bytes.byteLength,
        WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
      ),
    ).toBe(true)
    expect(await ledger.beginCapture({ coordinates: firstKey, ownerNonce: "e".repeat(64), now: 1 })).toEqual({
      status: "acquired",
    })
    const first = WorkflowVisualHost.capturedImage(firstKey, bytes)
    await expect(
      ledger.completeCapture({
        receipt: first.receipt,
        bytes,
        ownerNonce: "e".repeat(64),
        now: 2,
        limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
      }),
    ).resolves.toMatchObject({ state: "staged" })

    expect(await ledger.beginCapture({ coordinates: secondKey, ownerNonce: "f".repeat(64), now: 3 })).toEqual({
      status: "acquired",
    })
    const second = WorkflowVisualHost.capturedImage(secondKey, bytes)
    await expect(
      ledger.completeCapture({
        receipt: second.receipt,
        bytes,
        ownerNonce: "f".repeat(64),
        now: 4,
        limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
      }),
    ).rejects.toMatchObject({ code: "workflow_evidence_limit_exceeded" })
    expect(await ledger.used(String(workflowID))).toBe(WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES)
    expect(await ledger.get(secondKey)).toMatchObject({ state: "capturing" })
    await ledger.close()
  })

  test("binds commit and release to the complete durable screenshot artifact and is exact/idempotent", async () => {
    await using temp = await taskTemp()
    const key = await evidenceCoordinates("wfs_evidence_binding")
    const bytes = WorkflowVisualHost.deterministicPng(key.viewport)
    const image = WorkflowVisualHost.capturedImage(key, bytes)
    const artifact = screenshotArtifact(image, "wfa_evidence_binding")
    const ledger = EvidenceLedger.open(temp.path)
    await ledger.beginCapture({ coordinates: key, ownerNonce: "1".repeat(64), now: 1 })
    await ledger.completeCapture({
      receipt: image.receipt,
      bytes,
      ownerNonce: "1".repeat(64),
      now: 2,
      limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
    })

    const committed = await ledger.commit({ receipt: image.receipt, artifact }, 3)
    expect(await ledger.commit({ receipt: image.receipt, artifact }, 4)).toEqual(committed)
    const changedTime = Object.freeze({ ...artifact, timeCreated: DateTime.makeUnsafe(2) })
    await expect(ledger.commit({ receipt: image.receipt, artifact: changedTime }, 5)).rejects.toThrow()
    const wrong = Object.freeze({ ...artifact, id: Workflow.ArtifactID.make("wfa_evidence_wrong") })
    await expect(ledger.release({ receipt: image.receipt, artifact: wrong }, 6)).rejects.toThrow()
    const released = await ledger.release({ receipt: image.receipt, artifact }, 7)
    expect(released).toMatchObject({ state: "released" })
    expect(released.bytes).toBeUndefined()
    expect(await ledger.release({ receipt: image.receipt, artifact }, 8)).toEqual(released)
    expect(await ledger.used(String(workflowID))).toBe(bytes.byteLength)
    expect(await ledger.beginCapture({ coordinates: key, ownerNonce: "2".repeat(64), now: 9 })).toMatchObject({
      status: "terminal",
      item: { state: "released" },
    })
    await ledger.close()
  })

  test("abandons only from exact durable terminal authority and retains historical accounting", async () => {
    await using temp = await taskTemp()
    const key = await evidenceCoordinates("wfs_evidence_abandoned")
    const bytes = WorkflowVisualHost.deterministicPng(key.viewport)
    const image = WorkflowVisualHost.capturedImage(key, bytes)
    const ledger = EvidenceLedger.open(temp.path)
    await ledger.beginCapture({ coordinates: key, ownerNonce: "3".repeat(64), now: 1 })
    await ledger.completeCapture({
      receipt: image.receipt,
      bytes,
      ownerNonce: "3".repeat(64),
      now: 2,
      limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
    })
    const terminal = {
      workflowID,
      stageID: key.stageID,
      status: "failed" as const,
      authorityID: "workflow.stage.failed:event-1",
    }
    const abandoned = await ledger.abandon({ receipt: image.receipt, terminal }, 3)
    expect(abandoned).toMatchObject({ state: "abandoned", abandonment: terminal })
    expect(abandoned.bytes).toBeUndefined()
    expect(await ledger.abandon({ receipt: image.receipt, terminal }, 4)).toEqual(abandoned)
    expect(await ledger.used(String(workflowID))).toBe(bytes.byteLength)
    expect(await ledger.beginCapture({ coordinates: key, ownerNonce: "4".repeat(64), now: 5 })).toMatchObject({
      status: "terminal",
      item: { state: "abandoned" },
    })
    await ledger.close()
  })

  test("probes ACL only around each public operation while cheap guards catch a same-path database replacement", async () => {
    await using temp = await taskTemp()
    let probes = 0
    let replace = false
    const ledger = EvidenceLedger.open(temp.path, {
      rootPolicy: () => {
        probes++
      },
      onBoundary: ({ operation, phase }) => {
        if (!replace || operation !== "select-get" || phase !== "before") return
        const databasePath = path.join(temp.path, "evidence.sqlite")
        fsSync.renameSync(databasePath, path.join(temp.path, "evidence-original.sqlite"))
        fsSync.writeFileSync(databasePath, Buffer.alloc(0), { flag: "wx" })
      },
    })
    const afterOpen = probes
    expect(await ledger.used(String(workflowID))).toBe(0)
    expect(probes - afterOpen).toBe(2)
    const afterUsed = probes
    expect(await ledger.reserve(String(workflowID), 1, WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES)).toBe(true)
    expect(probes - afterUsed).toBe(2)
    replace = true
    await expect(ledger.used(String(workflowID))).rejects.toThrow()
    await expect(ledger.used(String(workflowID))).rejects.toThrow(/closed/i)
  })

  test("lets a fatal post-operation database identity failure override an earlier validation error", async () => {
    await using temp = await taskTemp()
    let armed = false
    let operationProbes = 0
    const ledger = EvidenceLedger.open(temp.path, {
      rootPolicy: () => {
        if (!armed || ++operationProbes !== 2) return
        const databasePath = path.join(temp.path, "evidence.sqlite")
        fsSync.linkSync(databasePath, path.join(temp.path, "evidence-second-owner.sqlite"))
      },
    })
    armed = true

    await expect(
      ledger.reserve(String(workflowID), -1, WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES),
    ).rejects.toThrow(/link|identity|owned/i)
    await expect(ledger.used(String(workflowID))).rejects.toThrow(/closed/i)
  })

  test("fails closed when any durable coordinate, receipt, state, or PNG BLOB field is corrupted", async () => {
    const corruptions: readonly {
      readonly name: string
      readonly mutate: (database: Database, image: WorkflowVisualHost.CapturedImage) => void
    }[] = [
      {
        name: "coordinate",
        mutate: (database) => database.run("UPDATE workflow_evidence_item SET stage_id = 'wfs_conflicting_owner'"),
      },
      {
        name: "receipt",
        mutate: (database, image) =>
          database.run("UPDATE workflow_evidence_item SET receipt_json = ?", [
            JSON.stringify({ ...image.receipt, pngSha256: "0".repeat(64) }),
          ]),
      },
      {
        name: "state",
        mutate: (database) => {
          database.run("PRAGMA ignore_check_constraints = ON")
          database.run("UPDATE workflow_evidence_item SET state = 'forged'")
        },
      },
      {
        name: "blob",
        mutate: (database, image) =>
          database.run("UPDATE workflow_evidence_item SET png_blob = ?", [
            Uint8Array.from(image.bytes, (value, index) => (index === image.bytes.length - 1 ? value ^ 1 : value)),
          ]),
      },
      {
        name: "oversized-blob",
        mutate: (database) =>
          database.run("UPDATE workflow_evidence_item SET png_blob = ?", [
            new Uint8Array(WorkflowVisualHost.MAX_IMAGE_BYTES + 1),
          ]),
      },
    ]

    for (const corruption of corruptions) {
      await using temp = await taskTemp()
      const coordinates = await evidenceCoordinates(`wfs_evidence_corrupt_${corruption.name}`)
      const bytes = WorkflowVisualHost.deterministicPng(coordinates.viewport)
      const image = WorkflowVisualHost.capturedImage(coordinates, bytes)
      const ownerNonce = "9".repeat(64)
      const seeded = EvidenceLedger.open(temp.path)
      await seeded.beginCapture({ coordinates, ownerNonce, now: 1 })
      await seeded.completeCapture({
        receipt: image.receipt,
        bytes,
        ownerNonce,
        now: 2,
        limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
      })
      await seeded.close()
      const database = new Database(path.join(temp.path, "evidence.sqlite"), { create: false, readwrite: true })
      corruption.mutate(database, image)
      database.close()

      let restored: EvidenceLedger.Service
      try {
        restored = EvidenceLedger.open(temp.path)
      } catch (cause) {
        expect(cause).toBeInstanceOf(Error)
        continue
      }
      await expect(restored.get(coordinates)).rejects.toThrow()
      await expect(restored.get(coordinates)).rejects.toThrow(/closed/i)
    }
  })

  test("rejects an oversized BLOB length before reading the BLOB column", async () => {
    await using temp = await taskTemp()
    const coordinates = await evidenceCoordinates("wfs_evidence_blob_bound")
    const bytes = WorkflowVisualHost.deterministicPng(coordinates.viewport)
    const image = WorkflowVisualHost.capturedImage(coordinates, bytes)
    const seeded = EvidenceLedger.open(temp.path)
    await seeded.beginCapture({ coordinates, ownerNonce: "8".repeat(64), now: 1 })
    await seeded.completeCapture({
      receipt: image.receipt,
      bytes,
      ownerNonce: "8".repeat(64),
      now: 2,
      limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
    })
    await seeded.close()
    const database = new Database(path.join(temp.path, "evidence.sqlite"), { create: false, readwrite: true })
    database.run("UPDATE workflow_evidence_item SET png_blob = ?", [
      new Uint8Array(WorkflowVisualHost.MAX_IMAGE_BYTES + 1),
    ])
    database.close()
    let blobReads = 0
    const restored = EvidenceLedger.open(temp.path, {
      onBoundary: ({ operation, phase }) => {
        if (operation === "select-blob" && phase === "before") blobReads++
      },
    })

    await expect(restored.get(coordinates)).rejects.toThrow()
    expect(blobReads).toBe(0)
    await restored.close().catch(() => undefined)
  })

  test("reconcile classifies active evidence without reading any BLOB column", async () => {
    await using temp = await taskTemp()
    const coordinates = await evidenceCoordinates("wfs_evidence_reconcile_no_blob")
    const bytes = WorkflowVisualHost.deterministicPng(coordinates.viewport)
    const image = WorkflowVisualHost.capturedImage(coordinates, bytes)
    let blobReads = 0
    const ledger = EvidenceLedger.open(temp.path, {
      onBoundary: ({ operation, phase }) => {
        if (operation === "select-blob" && phase === "before") blobReads++
      },
    })
    await ledger.beginCapture({ coordinates, ownerNonce: "7".repeat(64), now: 1 })
    await ledger.completeCapture({
      receipt: image.receipt,
      bytes,
      ownerNonce: "7".repeat(64),
      now: 2,
      limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
    })
    blobReads = 0

    const result = await ledger.reconcile({ workflowID, active: [coordinates], committed: [], abandoned: [] }, 3)

    expect(result.active).toHaveLength(1)
    expect(blobReads).toBe(0)
    await ledger.close()
  })

  test.each(["missing", "lowered"] as const)(
    "fails closed on reopen when the %s aggregate is below durable item history",
    async (mode) => {
      await using temp = await taskTemp()
      const coordinates = await evidenceCoordinates(`wfs_evidence_aggregate_${mode}`)
      const bytes = WorkflowVisualHost.deterministicPng(coordinates.viewport)
      const image = WorkflowVisualHost.capturedImage(coordinates, bytes)
      const seeded = EvidenceLedger.open(temp.path)
      await seeded.beginCapture({ coordinates, ownerNonce: "6".repeat(64), now: 1 })
      await seeded.completeCapture({
        receipt: image.receipt,
        bytes,
        ownerNonce: "6".repeat(64),
        now: 2,
        limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
      })
      await seeded.close()
      const database = new Database(path.join(temp.path, "evidence.sqlite"), { create: false, readwrite: true })
      database.run(
        mode === "missing"
          ? "DELETE FROM workflow_evidence WHERE workflow_id = ?"
          : "UPDATE workflow_evidence SET evidence_bytes = 0 WHERE workflow_id = ?",
        [String(workflowID)],
      )
      database.close()

      let restored: EvidenceLedger.Service | undefined
      let failure: unknown
      try {
        restored = EvidenceLedger.open(temp.path)
      } catch (cause) {
        failure = cause
      }
      await restored?.close()
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).toMatch(/total|aggregate|history/i)
    },
  )

  test("fails closed when aggregate corruption appears before a quota mutation", async () => {
    await using temp = await taskTemp()
    const coordinates = await evidenceCoordinates("wfs_evidence_aggregate_race")
    const bytes = WorkflowVisualHost.deterministicPng(coordinates.viewport)
    const image = WorkflowVisualHost.capturedImage(coordinates, bytes)
    const ledger = EvidenceLedger.open(temp.path)
    await ledger.beginCapture({ coordinates, ownerNonce: "5".repeat(64), now: 1 })
    await ledger.completeCapture({
      receipt: image.receipt,
      bytes,
      ownerNonce: "5".repeat(64),
      now: 2,
      limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
    })
    const database = new Database(path.join(temp.path, "evidence.sqlite"), { create: false, readwrite: true })
    database.run("DELETE FROM workflow_evidence WHERE workflow_id = ?", [String(workflowID)])
    database.close()

    const failure = await ledger
      .reserve(String(workflowID), 1, WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES)
      .catch((cause) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toMatch(/total|aggregate|history/i)
    await expect(ledger.used(String(workflowID))).rejects.toThrow(/closed/i)
    await ledger.close().catch(() => undefined)
  })

  test("reconciles only full active, terminal, and artifact authority and preserves unknown staging", async () => {
    await using temp = await taskTemp()
    const ledger = EvidenceLedger.open(temp.path)
    const staged = async (stage: string, nonce: string) => {
      const coordinates = await evidenceCoordinates(stage)
      const bytes = WorkflowVisualHost.deterministicPng(coordinates.viewport)
      const image = WorkflowVisualHost.capturedImage(coordinates, bytes)
      await ledger.beginCapture({ coordinates, ownerNonce: nonce, now: 1 })
      await ledger.completeCapture({
        receipt: image.receipt,
        bytes,
        ownerNonce: nonce,
        now: 2,
        limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
      })
      return image
    }
    const active = await staged("wfs_evidence_reconcile_active", "1".repeat(64))
    const committed = await staged("wfs_evidence_reconcile_committed", "2".repeat(64))
    const abandoned = await staged("wfs_evidence_reconcile_abandoned", "3".repeat(64))
    const unknown = await staged("wfs_evidence_reconcile_unknown", "4".repeat(64))
    const capturing = await evidenceCoordinates("wfs_evidence_reconcile_capturing")
    await ledger.beginCapture({ coordinates: capturing, ownerNonce: "5".repeat(64), now: 3 })
    const artifact = screenshotArtifact(committed, "wfa_evidence_reconcile")
    const terminal = {
      workflowID,
      stageID: abandoned.receipt.coordinates.stageID,
      status: "cancelled" as const,
      authorityID: "workflow.stage.cancelled:event-2",
    }

    const result = await ledger.reconcile(
      {
        workflowID,
        active: [active.receipt.coordinates],
        abandoned: [{ receipt: abandoned.receipt, terminal }],
        committed: [{ receipt: committed.receipt, artifact, release: true }],
      },
      4,
    )

    expect(result.active.map((item) => item.evidenceID)).toEqual([active.evidenceID])
    expect(result.released.map((item) => item.evidenceID)).toEqual([committed.evidenceID])
    expect(result.abandoned.map((item) => item.evidenceID)).toEqual([abandoned.evidenceID])
    expect(result.ambiguous.map((item) => item.evidenceID).toSorted()).toEqual(
      [unknown.evidenceID, WorkflowVisualHost.evidenceID(capturing)].toSorted(),
    )
    expect(await ledger.get(unknown.receipt.coordinates)).toMatchObject({ state: "staged" })
    expect(await ledger.get(capturing)).toMatchObject({ state: "capturing" })
    await ledger.close()
  })

  test("rejects duplicate committed authority with conflicting release parity", async () => {
    await using temp = await taskTemp()
    const coordinates = await evidenceCoordinates("wfs_evidence_reconcile_duplicate")
    const bytes = WorkflowVisualHost.deterministicPng(coordinates.viewport)
    const image = WorkflowVisualHost.capturedImage(coordinates, bytes)
    const artifact = screenshotArtifact(image, "wfa_evidence_reconcile_duplicate")
    const ledger = EvidenceLedger.open(temp.path)
    await ledger.beginCapture({ coordinates, ownerNonce: "4".repeat(64), now: 1 })
    await ledger.completeCapture({
      receipt: image.receipt,
      bytes,
      ownerNonce: "4".repeat(64),
      now: 2,
      limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
    })

    const failure = await ledger
      .reconcile(
        {
          workflowID,
          active: [],
          abandoned: [],
          committed: [
            { receipt: image.receipt, artifact, release: false },
            { receipt: image.receipt, artifact, release: true },
          ],
        },
        3,
      )
      .catch((cause) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toMatch(/authority conflicts/i)
    expect(await ledger.get(coordinates)).toMatchObject({ state: "staged" })
    await ledger.close()
  })

  test("uses exactly two ACL probes for put, get, commit, release, and reconcile public operations", async () => {
    await using temp = await taskTemp()
    let probes = 0
    const ledger = EvidenceLedger.open(temp.path, { rootPolicy: () => probes++ })
    const coordinates = await evidenceCoordinates("wfs_evidence_probe_matrix")
    const bytes = WorkflowVisualHost.deterministicPng(coordinates.viewport)
    const image = WorkflowVisualHost.capturedImage(coordinates, bytes)
    const artifact = screenshotArtifact(image, "wfa_evidence_probe_matrix")
    const ownerNonce = "6".repeat(64)
    const measured = async (operation: () => Promise<unknown>) => {
      const before = probes
      await operation()
      expect(probes - before).toBe(2)
    }

    await measured(() => ledger.beginCapture({ coordinates, ownerNonce, now: 1 }))
    await measured(() =>
      ledger.completeCapture({
        receipt: image.receipt,
        bytes,
        ownerNonce,
        now: 2,
        limit: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES,
      }),
    )
    await measured(() => ledger.get(coordinates))
    await measured(() => ledger.commit({ receipt: image.receipt, artifact }, 3))
    await measured(() => ledger.release({ receipt: image.receipt, artifact }, 4))
    await measured(() =>
      ledger.reconcile(
        {
          workflowID,
          active: [],
          abandoned: [],
          committed: [{ receipt: image.receipt, artifact, release: true }],
        },
        5,
      ),
    )
    await ledger.close()
  })
})

async function evidenceCoordinates(stage: string): Promise<WorkflowVisualHost.EvidenceCoordinates> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope
        const hostID = WorkflowVisualHost.HostID.make(createHash("sha256").update(stage).digest("hex"))
        const preview = WorkflowVisualHost.preparedPreview({
          hostID,
          url: `http://127.0.0.1:4173/${hostID}/`,
          workflowID,
          kind: "reference",
          revision: 0,
          configSha256: "a".repeat(64),
          sourceSha256: "b".repeat(64),
          readySelectorSha256: createHash("sha256").update("#ready").digest("hex"),
          scope,
        })
        return WorkflowVisualHost.evidenceCoordinates({
          preview,
          stageID: Workflow.StageID.make(stage),
          viewport: { name: "desktop", width: 64, height: 64 },
        })
      }),
    ),
  )
}

function screenshotArtifact(
  image: WorkflowVisualHost.CapturedImage,
  artifactID: string,
): WorkflowVisualHost.BindEvidenceInput["artifact"] {
  const receipt = image.receipt
  const captured = WorkflowVisualReviewArtifact.capturedImage({
    workflowID: receipt.coordinates.workflowID,
    kind: receipt.coordinates.kind,
    viewport: receipt.coordinates.viewport.name,
    revision: receipt.coordinates.revision,
    bytes: image.bytes,
    evidenceReceipt: receipt,
  })
  return Object.freeze({
    id: Workflow.ArtifactID.make(artifactID),
    workflowID: receipt.coordinates.workflowID,
    stageID: receipt.coordinates.stageID,
    ...WorkflowVisualReviewArtifact.commitScreenshot(captured),
    timeCreated: DateTime.makeUnsafe(1),
  }) as WorkflowVisualHost.BindEvidenceInput["artifact"]
}

async function taskTemp() {
  await fs.mkdir(testRoot, { recursive: true })
  const directory = await fs.realpath(await fs.mkdtemp(path.join(testRoot, "case-")))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await removeTestRoot(directory)
    },
  }
}

async function removeTestRoot(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.rm(directory, { recursive: true, force: true })
      return
    } catch (cause) {
      if (cause === null || typeof cause !== "object" || Reflect.get(cause, "code") !== "EBUSY" || attempt === 9) {
        throw cause
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}
