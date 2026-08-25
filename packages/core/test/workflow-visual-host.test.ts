import { describe, expect, test } from "bun:test"
import { WorkflowDesignArtifact } from "@opencode-ai/core/workflow/artifacts/design"
import { WorkflowVisualReviewArtifact } from "@opencode-ai/core/workflow/artifacts/visual-review"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Workflow } from "@opencode-ai/schema/workflow"
import { DateTime, Effect, Scope } from "effect"
import { createHash } from "node:crypto"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"

const workflowID = Workflow.ID.make("wfl_visual_host")
const stageID = Workflow.StageID.make("wfs_visual_host")
const referenceApp = {
  entrypoint: "index.html",
  readySelector: "#ready",
  projectStack: ["HTML"],
  files: [{ path: "index.html", content: '<!doctype html><main id="ready">Reference</main>' }],
}

const capture = Effect.gen(function* () {
  const host = yield* WorkflowVisualHost.Service
  const preview = yield* host.materializeReference({ workflowID, referenceApp })
  const image = yield* host.capture({
    preview,
    stageID,
    viewport: { name: "desktop", width: 1440, height: 900 },
  })
  return { host, preview, image }
})

const implementationContract = Object.freeze({
  implementationSha256: "c".repeat(64),
  readySelector: "#ready",
})

describe("WorkflowVisualHost", () => {
  test("keeps the logical evidence helper independent from screenshot artifact codecs", async () => {
    const source = await fs.readFile(path.join(import.meta.dir, "../src/workflow/visual-evidence.ts"), "utf8")

    expect(source).not.toContain('from "./artifacts/')
    expect(WorkflowVisualHost.REFERENCE_SCREENSHOT_KIND).toBe(WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND)
    expect(WorkflowVisualHost.IMPLEMENTATION_SCREENSHOT_KIND).toBe(
      WorkflowVisualReviewArtifact.IMPLEMENTATION_SCREENSHOT_KIND,
    )
  })

  test("accepts only opaque loopback capability handles", () => {
    const capability = "a".repeat(64)
    expect(WorkflowVisualHost.validateHandle(`http://127.0.0.1:4173/${capability}/`)).toBe(true)
    for (const value of [
      `https://127.0.0.1:4173/${capability}/`,
      `http://localhost:4173/${capability}/`,
      `http://127.0.0.1:0/${capability}/`,
      `http://user:pass@127.0.0.1:4173/${capability}/`,
      `http://127.0.0.1:4173/${capability}/?url=https://example.com`,
      `http://2130706433:4173/${capability}/`,
      `http://0x7f000001:4173/${capability}/`,
      `http://017700000001:4173/${capability}/`,
      `http://127.1:4173/${capability}/`,
      `http://127.0.0.1.:4173/${capability}/`,
      `http://127.000.000.001:4173/${capability}/`,
      `http://127.0.0.1:04173/${capability}/`,
      `http://127.0.0.1:4173/ignored/../${capability}/`,
      `http://127.0.0.1:4173/ignored/%2e%2e/${capability}/`,
      `http://127.0.0.1:4173/${capability}/?`,
      `http://127.0.0.1:4173/${capability}/#`,
      `http://127%2e0%2e0%2e1:4173/${capability}/`,
      `http://127.0.0.1:4173/${"%61".repeat(64)}/`,
      ` HTTP://127.0.0.1:4173/${capability}/ `,
      `HTTP://127.0.0.1:4173/${capability}/`,
      `http://127.0.0.1:4173/${capability.toUpperCase()}/`,
      `http://127.0.0.1:4173/${capability.slice(1)}/`,
      "file:///D:/workspace/index.html",
      "https://example.com",
    ]) {
      expect(WorkflowVisualHost.validateHandle(value)).toBe(false)
    }
  })

  test("constructs prepared previews only from exact canonical URL text", async () => {
    const capability = "a".repeat(64)
    const hostID = WorkflowVisualHost.HostID.make(capability)
    const canonicalURL = `http://127.0.0.1:4173/${capability}/`
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope
          const valid = WorkflowVisualHost.preparedPreview({
            hostID,
            url: canonicalURL,
            workflowID,
            kind: "reference",
            revision: 0,
            configSha256: "b".repeat(64),
            sourceSha256: "c".repeat(64),
            readySelectorSha256: createHash("sha256").update("#ready").digest("hex"),
            scope,
          })
          const rejected = [
            `http://127.0.0.1:04173/${capability}/`,
            `http://127.0.0.1:4173/ignored/../${capability}/`,
            `http://127.0.0.1:4173/${capability}/?`,
            ` HTTP://127.0.0.1:4173/${capability}/ `,
          ].map((url) => {
            try {
              return WorkflowVisualHost.preparedPreview({
                hostID,
                url,
                workflowID,
                kind: "reference",
                revision: 0,
                configSha256: "b".repeat(64),
                sourceSha256: "c".repeat(64),
                readySelectorSha256: createHash("sha256").update("#ready").digest("hex"),
                scope,
              })
            } catch (error) {
              return error
            }
          })
          return { valid, rejected }
        }),
      ),
    )

    expect(String(result.valid.url)).toBe(canonicalURL)
    expect(result.valid.origin).toBe("http://127.0.0.1:4173")
    expect(result.rejected.every((value) => value instanceof WorkflowVisualHost.Failure)).toBe(true)
  })

  test("provides a deterministic scoped fake with exact PNG evidence", async () => {
    const released: WorkflowVisualHost.HostID[] = []
    const run = () =>
      Effect.runPromise(
        Effect.scoped(capture).pipe(
          Effect.provide(WorkflowVisualHost.fakeLayer({ onRelease: (id) => released.push(id) })),
        ),
      )

    const first = await run()
    const second = await run()

    expect(first.preview.hostID).toBe(second.preview.hostID)
    expect(first.preview.hostID).not.toContain(workflowID)
    expect(WorkflowVisualHost.validateHandle(first.preview.url)).toBe(true)
    expect(first.preview.origin).toBe("http://127.0.0.1:4173")
    expect(first.preview.revision).toBe(0)
    expect(first.image.viewport).toEqual({ name: "desktop", width: 1440, height: 900 })
    expect(first.image.width).toBe(1440)
    expect(first.image.height).toBe(900)
    expect(first.image.evidenceBytes).toBe(first.image.bytes.byteLength)
    expect(first.image.sha256).toBe(createHash("sha256").update(first.image.bytes).digest("hex"))
    expect(first.image.sha256).toBe(second.image.sha256)
    expect(() => WorkflowVisualReviewArtifact.assertPng(first.image.bytes)).not.toThrow()
    expect(released).toEqual([first.preview.hostID, second.preview.hostID])
  })

  test("prepares implementations only from a frozen plan and exposes no general URL method", async () => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "index.html"), "<!doctype html><main>Implementation</main>")
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(root.path) }),
      preview: { kind: "static", entrypoint: "index.html" },
    })
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          expect(Object.keys(host).toSorted()).toEqual(
            [
              "capture",
              "abandonEvidence",
              "commitEvidence",
              "lookupEvidence",
              "materializeReference",
              "prepareImplementation",
              "reconcileEvidence",
              "recoverExpired",
              "releaseEvidence",
            ].toSorted(),
          )
          return yield* host.prepareImplementation({
            workflowID,
            revision: 3,
            plan,
          })
        }),
      ).pipe(
        Effect.provide(WorkflowVisualHost.fakeLayer({ resolveImplementationContract: () => implementationContract })),
      ),
    )

    expect(result.revision).toBe(3)
    expect(result.configSha256).toBe(plan.configSha256)
    expect(WorkflowVisualHost.validateHandle(result.url)).toBe(true)
  })

  test("fails closed without a trusted implementation contract resolver and rejects legacy caller identity", async () => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "index.html"), "<!doctype html><main>Implementation</main>")
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(root.path) }),
      preview: { kind: "static", entrypoint: "index.html" },
    })
    const withoutResolver = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.prepareImplementation({ workflowID, revision: 1, plan })
        }),
      ).pipe(Effect.provide(WorkflowVisualHost.fakeLayer()), Effect.flip),
    )
    let resolverCalls = 0
    const legacyIdentity = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.prepareImplementation({
            workflowID,
            revision: 1,
            plan,
            implementationSha256: "0".repeat(64),
            readySelector: "#attacker",
          } as WorkflowVisualHost.PrepareImplementationInput)
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHost.fakeLayer({
            resolveImplementationContract: () => {
              resolverCalls++
              return implementationContract
            },
          }),
        ),
        Effect.flip,
      ),
    )

    expect(withoutResolver).toMatchObject({ code: "visual_host_unavailable" })
    expect(legacyIdentity).toMatchObject({ code: "invalid_preview_plan" })
    expect(resolverCalls).toBe(0)
  })

  test("rejects a shallow-frozen or hash-forged implementation plan", async () => {
    const forged = Object.freeze({
      kind: "script" as const,
      argv: ["bun", "run", "preview"],
      locationRoot: "D:\\workspace",
      cwd: "D:\\workspace",
      env: {},
      allowedOrigins: [],
      configFiles: [],
      configSha256: "b".repeat(64),
    })
    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.prepareImplementation({
            workflowID,
            revision: 0,
            plan: forged,
          })
        }),
      ).pipe(Effect.provide(WorkflowVisualHost.fakeLayer()), Effect.flip),
    )

    expect(failure).toMatchObject({ code: "invalid_preview_plan" })
  })

  test("rejects a deep-frozen plan carrying URL authority outside the contract", async () => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "index.html"), "<!doctype html>")
    const admitted = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(root.path) }),
      preview: { kind: "static", entrypoint: "index.html" },
    })
    const forged = Object.freeze({ ...admitted, url: "http://127.0.0.1:9999/forged/" })

    const failure = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          return yield* host.prepareImplementation({
            workflowID,
            revision: 0,
            plan: forged,
          })
        }),
      ).pipe(Effect.provide(WorkflowVisualHost.fakeLayer()), Effect.flip),
    )

    expect(failure).toMatchObject({ code: "invalid_preview_plan" })
  })

  test("fails with a typed error above the 8 MiB per-image cap", async () => {
    const failure = await Effect.runPromise(
      Effect.scoped(capture).pipe(
        Effect.provide(
          WorkflowVisualHost.fakeLayer({
            captureBytes: () => new Uint8Array(WorkflowVisualHost.MAX_IMAGE_BYTES + 1),
          }),
        ),
        Effect.flip,
      ),
    )

    expect(failure).toBeInstanceOf(WorkflowVisualHost.Failure)
    expect(failure).toMatchObject({ code: "image_evidence_limit_exceeded" })
  })

  test("fails before capture above the 128 MiB workflow evidence cap", async () => {
    let captureCalls = 0
    const failure = await Effect.runPromise(
      Effect.scoped(capture).pipe(
        Effect.provide(
          WorkflowVisualHost.fakeLayer({
            initialEvidenceBytes: { [workflowID]: WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES },
            captureBytes: (input) => {
              captureCalls++
              return WorkflowVisualHost.deterministicPng(input.viewport)
            },
          }),
        ),
        Effect.flip,
      ),
    )

    expect(captureCalls).toBe(0)
    expect(failure).toMatchObject({ code: "workflow_evidence_limit_exceeded" })
  })

  test("recovers only expired unleased fake handles and releases each once", async () => {
    const released: WorkflowVisualHost.HostID[] = []
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.materializeReference({ workflowID, referenceApp })
          yield* host.recoverExpired({ activeHostIDs: new Set([preview.hostID]), expiredBefore: 11 })
          const beforeRecovery = yield* host.capture({
            preview,
            stageID,
            viewport: { name: "mobile", width: 390, height: 844 },
          })
          yield* host.recoverExpired({ activeHostIDs: new Set(), expiredBefore: 11 })
          const afterRecovery = yield* host
            .capture({
              preview,
              stageID,
              viewport: { name: "mobile", width: 390, height: 844 },
            })
            .pipe(Effect.flip)
          return { preview, beforeRecovery, afterRecovery }
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHost.fakeLayer({
            now: () => 10,
            onRelease: (hostID) => released.push(hostID),
          }),
        ),
      ),
    )

    expect(result.beforeRecovery.viewport.name).toBe("mobile")
    expect(result.afterRecovery).toMatchObject({ code: "invalid_preview_handle" })
    expect(released).toEqual([result.preview.hostID])
  })

  test("restores one logical capture across host IDs without recapturing or charging twice", async () => {
    const evidenceStore = WorkflowVisualHost.makeFakeEvidenceStore()
    let captureCalls = 0
    const run = (salt: string) =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const host = yield* WorkflowVisualHost.Service
            const preview = yield* host.materializeReference({ workflowID, referenceApp })
            const image = yield* host.capture({
              preview,
              stageID,
              viewport: { name: "desktop", width: 1440, height: 900 },
            })
            return { preview, image }
          }),
        ).pipe(
          Effect.provide(
            WorkflowVisualHost.fakeLayer({
              evidenceStore,
              hostIDSalt: () => salt,
              captureBytes: (input) => {
                captureCalls++
                return WorkflowVisualHost.deterministicPng(input.viewport)
              },
            }),
          ),
        ),
      )

    const first = await run("first-host")
    const restored = await run("second-host")
    const snapshot = WorkflowVisualHost.inspectFakeEvidenceStore(evidenceStore)

    expect(first.preview.hostID).not.toBe(restored.preview.hostID)
    expect(restored.image.evidenceID).toBe(first.image.evidenceID)
    expect(restored.image.sha256).toBe(first.image.sha256)
    expect(restored.image.bytes).toEqual(first.image.bytes)
    expect(captureCalls).toBe(1)
    expect(snapshot.totalBytesByWorkflow[workflowID]).toBe(first.image.bytes.byteLength)
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]).toMatchObject({ state: "staged", evidenceID: first.image.evidenceID })
  })

  test("binds logical evidence identity to stage, host-minted preview identity, viewport, config, and selector", async () => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "index.html"), "<!doctype html><main></main>")
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(root.path) }),
      preview: { kind: "static", entrypoint: "index.html" },
    })
    let contractCalls = 0
    const values = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const reference = yield* host.materializeReference({ workflowID, referenceApp })
          const implementation = yield* host.prepareImplementation({
            workflowID,
            revision: 1,
            plan,
          })
          const changedImplementation = yield* host.prepareImplementation({
            workflowID,
            revision: 1,
            plan,
          })
          const alternateSelector = yield* host.materializeReference({
            workflowID,
            referenceApp: { ...referenceApp, readySelector: "#app-ready" },
          })
          const base = {
            preview: reference,
            stageID,
            viewport: { name: "desktop", width: 1440, height: 900 } as const,
          }
          return [
            WorkflowVisualHost.evidenceCoordinates(base),
            WorkflowVisualHost.evidenceCoordinates({
              ...base,
              stageID: Workflow.StageID.make("wfs_visual_host_other"),
            }),
            WorkflowVisualHost.evidenceCoordinates({ ...base, preview: implementation }),
            WorkflowVisualHost.evidenceCoordinates({ ...base, preview: changedImplementation }),
            WorkflowVisualHost.evidenceCoordinates({
              ...base,
              viewport: { name: "mobile", width: 390, height: 844 },
            }),
            WorkflowVisualHost.evidenceCoordinates({ ...base, preview: alternateSelector }),
          ]
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHost.fakeLayer({
            resolveImplementationContract: () => ({
              implementationSha256: (contractCalls++ === 0 ? "c" : "d").repeat(64),
              readySelector: "#ready",
            }),
          }),
        ),
      ),
    )

    expect(new Set(values.map(WorkflowVisualHost.evidenceID)).size).toBe(values.length)
    expect(values[0]).toMatchObject({
      workflowID,
      stageID,
      kind: "reference",
      revision: 0,
      viewport: { name: "desktop", width: 1440, height: 900 },
    })
    expect(values[0]?.readySelectorSha256).toBe(createHash("sha256").update("#ready").digest("hex"))
    expect(values[0]).not.toHaveProperty("evidenceID")
    expect(JSON.stringify(values[0])).not.toContain("127.0.0.1")
  })

  test("commits and releases only the exact receipt and preserves the released accounting tombstone", async () => {
    const evidenceStore = WorkflowVisualHost.makeFakeEvidenceStore()
    let captureCalls = 0
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.materializeReference({ workflowID, referenceApp })
          const image = yield* host.capture({
            preview,
            stageID,
            viewport: { name: "desktop", width: 1440, height: 900 },
          })
          const artifact = screenshotArtifact(image, "wfa_visual_evidence")
          expect(WorkflowVisualHost.evidenceArtifactBinding({ receipt: image.receipt, artifact })).toMatchObject({
            artifactID: artifact.id,
            evidenceID: image.evidenceID,
          })
          const beforeCommit = yield* host.lookupEvidence({ coordinates: image.receipt.coordinates })
          const committed = yield* host.commitEvidence({ receipt: image.receipt, artifact })
          const changedTime = Object.freeze({ ...artifact, timeCreated: DateTime.makeUnsafe(2) })
          const changedTimeFailure = yield* host
            .commitEvidence({ receipt: image.receipt, artifact: changedTime })
            .pipe(Effect.flip)
          const committedAgain = yield* host.commitEvidence({ receipt: image.receipt, artifact })
          const released = yield* host.releaseEvidence({ receipt: image.receipt, artifact })
          const releasedAgain = yield* host.releaseEvidence({ receipt: image.receipt, artifact })
          const recapture = yield* host
            .capture({
              preview,
              stageID,
              viewport: { name: "desktop", width: 1440, height: 900 },
            })
            .pipe(Effect.flip)
          return {
            image,
            artifact,
            beforeCommit,
            committed,
            changedTimeFailure,
            committedAgain,
            released,
            releasedAgain,
            recapture,
          }
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHost.fakeLayer({
            evidenceStore,
            captureBytes: (input) => {
              captureCalls++
              return WorkflowVisualHost.deterministicPng(input.viewport)
            },
          }),
        ),
      ),
    )

    expect(result.beforeCommit?.bytes).toEqual(result.image.bytes)
    expect(result.committed).toMatchObject({
      state: "committed",
      artifact: {
        artifactID: result.artifact.id,
        workflowID,
        stageID,
        sha256: result.artifact.sha256,
        evidenceID: result.image.evidenceID,
        pngSha256: result.image.sha256,
        timeCreatedEpochMs: 1,
      },
    })
    expect(result.changedTimeFailure).toMatchObject({ code: "evidence_conflict" })
    expect(() =>
      WorkflowVisualHost.evidenceArtifactBinding({
        receipt: result.image.receipt,
        // @ts-expect-error Deliberately exercise the runtime boundary with encoded time instead of DateTime.Utc.
        artifact: { ...result.artifact, timeCreated: 1 },
      }),
    ).toThrow()
    expect(result.committedAgain).toEqual(result.committed)
    expect(result.released).toMatchObject({ state: "released", artifact: { artifactID: result.artifact.id } })
    expect(result.releasedAgain).toEqual(result.released)
    expect(result.recapture).toMatchObject({ code: "evidence_released" })
    expect(captureCalls).toBe(1)
    expect(WorkflowVisualHost.inspectFakeEvidenceStore(evidenceStore)).toMatchObject({
      totalBytesByWorkflow: { [workflowID]: result.image.bytes.byteLength },
      items: [{ state: "released", hasBytes: false, artifact: { artifactID: result.artifact.id } }],
    })
  })

  test("rejects malformed evidence receipts at screenshot commit and decode boundaries", async () => {
    const result = await Effect.runPromise(Effect.scoped(capture).pipe(Effect.provide(WorkflowVisualHost.fakeLayer())))
    const captured = WorkflowVisualReviewArtifact.capturedImage({
      workflowID,
      kind: "reference",
      viewport: result.image.viewport.name,
      revision: 0,
      bytes: result.image.bytes,
    })
    const malformedReceipt = { ...result.image.receipt, unexpected: true }

    expect(() =>
      WorkflowVisualReviewArtifact.commitScreenshot({ ...captured, evidenceReceipt: malformedReceipt }),
    ).toThrow()

    const { bytes: _, evidenceReceipt: __, ...image } = captured
    const payload = {
      image,
      dataBase64: Buffer.from(captured.bytes).toString("base64"),
      evidenceReceipt: malformedReceipt,
    }
    const body = WorkflowDesignArtifact.encode(payload)
    const encoded = new TextEncoder().encode(body)
    const forged = Workflow.ArtifactCommit.make({
      kind: WorkflowVisualReviewArtifact.REFERENCE_SCREENSHOT_KIND,
      uri: image.uri,
      mime: "image/png",
      sha256: createHash("sha256").update(encoded).digest("hex"),
      size: encoded.byteLength,
      metadata: { payload },
    })

    expect(() => WorkflowVisualReviewArtifact.decodeScreenshot(forged, workflowID)).toThrow()
  })

  test("reconciliation preserves unknown staging and finishes only an exact committed binding", async () => {
    const evidenceStore = WorkflowVisualHost.makeFakeEvidenceStore()
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.materializeReference({ workflowID, referenceApp })
          const active = yield* host.capture({
            preview,
            stageID,
            viewport: { name: "desktop", width: 1440, height: 900 },
          })
          const committed = yield* host.capture({
            preview,
            stageID: Workflow.StageID.make("wfs_visual_host_committed"),
            viewport: { name: "desktop", width: 1440, height: 900 },
          })
          const unknown = yield* host.capture({
            preview,
            stageID: Workflow.StageID.make("wfs_visual_host_unknown"),
            viewport: { name: "desktop", width: 1440, height: 900 },
          })
          const artifact = screenshotArtifact(committed, "wfa_visual_reconciled")
          const reconciled = yield* host.reconcileEvidence({
            workflowID,
            active: [active.receipt.coordinates],
            abandoned: [],
            committed: [{ receipt: committed.receipt, artifact, release: true }],
          })
          return { active, committed, unknown, reconciled }
        }),
      ).pipe(Effect.provide(WorkflowVisualHost.fakeLayer({ evidenceStore }))),
    )

    expect(result.reconciled.active.map((item) => item.evidenceID)).toEqual([result.active.evidenceID])
    expect(result.reconciled.released.map((item) => item.evidenceID)).toEqual([result.committed.evidenceID])
    expect(result.reconciled.ambiguous.map((item) => item.evidenceID)).toEqual([result.unknown.evidenceID])
    expect(result.reconciled.abandoned).toEqual([])
    expect(WorkflowVisualHost.inspectFakeEvidenceStore(evidenceStore).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ evidenceID: result.active.evidenceID, state: "staged", hasBytes: true }),
        expect.objectContaining({ evidenceID: result.committed.evidenceID, state: "released", hasBytes: false }),
        expect.objectContaining({ evidenceID: result.unknown.evidenceID, state: "staged", hasBytes: true }),
      ]),
    )
  })

  test("creates an immutable abandoned tombstone only from exact durable terminal authority", async () => {
    const evidenceStore = WorkflowVisualHost.makeFakeEvidenceStore()
    let captureCalls = 0
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          const preview = yield* host.materializeReference({ workflowID, referenceApp })
          const image = yield* host.capture({
            preview,
            stageID,
            viewport: { name: "desktop", width: 1440, height: 900 },
          })
          const abandoned = yield* host.abandonEvidence({
            receipt: image.receipt,
            terminal: { workflowID, stageID, status: "cancelled", authorityID: "event-terminal-cancelled" },
          })
          const abandonedAgain = yield* host.abandonEvidence({
            receipt: image.receipt,
            terminal: { workflowID, stageID, status: "cancelled", authorityID: "event-terminal-cancelled" },
          })
          const recapture = yield* host
            .capture({ preview, stageID, viewport: { name: "desktop", width: 1440, height: 900 } })
            .pipe(Effect.flip)
          return { image, abandoned, abandonedAgain, recapture }
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHost.fakeLayer({
            evidenceStore,
            captureBytes: (input) => {
              captureCalls++
              return WorkflowVisualHost.deterministicPng(input.viewport)
            },
          }),
        ),
      ),
    )

    expect(result.abandoned).toMatchObject({
      state: "abandoned",
      abandonment: { workflowID, stageID, status: "cancelled", authorityID: "event-terminal-cancelled" },
    })
    expect(result.abandonedAgain).toEqual(result.abandoned)
    expect(result.recapture).toMatchObject({ code: "evidence_abandoned" })
    expect(captureCalls).toBe(1)
    expect(WorkflowVisualHost.inspectFakeEvidenceStore(evidenceStore)).toMatchObject({
      totalBytesByWorkflow: { [workflowID]: result.image.evidenceBytes },
      items: [{ state: "abandoned", hasBytes: false }],
    })
  })

  test("canonicalizes cleanup only beneath a configured host root and never the workspace", async () => {
    await using root = await tmpdir()
    await using workspace = await tmpdir()
    await using outside = await tmpdir()
    const capability = path.join(root.path, "capability")
    await fs.mkdir(capability)

    expect(
      WorkflowVisualHost.cleanupTarget({ hostRoots: [root.path], target: capability, workspace: workspace.path }),
    ).toBe(await fs.realpath(capability))
    for (const target of [root.path, workspace.path, outside.path]) {
      expect(() =>
        WorkflowVisualHost.cleanupTarget({ hostRoots: [root.path], target, workspace: workspace.path }),
      ).toThrow(WorkflowVisualHost.Failure)
    }

    const alias = path.join(root.path, "outside-alias")
    await fs.symlink(outside.path, alias, process.platform === "win32" ? "junction" : "dir")
    expect(() =>
      WorkflowVisualHost.cleanupTarget({ hostRoots: [root.path], target: alias, workspace: workspace.path }),
    ).toThrow(WorkflowVisualHost.Failure)

    const owned = path.join(root.path, "owned")
    const ownedAlias = path.join(root.path, "owned-alias")
    await fs.mkdir(owned)
    await fs.symlink(owned, ownedAlias, process.platform === "win32" ? "junction" : "dir")
    expect(() =>
      WorkflowVisualHost.cleanupTarget({ hostRoots: [root.path], target: ownedAlias, workspace: workspace.path }),
    ).toThrow(WorkflowVisualHost.Failure)
  })
})

function screenshotArtifact(image: WorkflowVisualHost.CapturedImage, artifactID: string): Workflow.Artifact {
  const receipt = image.receipt
  const captured = WorkflowVisualReviewArtifact.capturedImage({
    workflowID: receipt.coordinates.workflowID,
    kind: receipt.coordinates.kind,
    viewport: receipt.coordinates.viewport.name,
    revision: receipt.coordinates.revision,
    bytes: image.bytes,
    evidenceReceipt: receipt,
  })
  const commit = WorkflowVisualReviewArtifact.commitScreenshot(captured)
  return Workflow.Artifact.make({
    id: Workflow.ArtifactID.make(artifactID),
    workflowID: receipt.coordinates.workflowID,
    stageID: receipt.coordinates.stageID,
    ...commit,
    timeCreated: DateTime.makeUnsafe(1),
  })
}
