import { describe, expect, test } from "bun:test"
import { WorkflowVisualReviewArtifact } from "@opencode-ai/core/workflow/artifacts/visual-review"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Workflow } from "@opencode-ai/schema/workflow"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"

const workflowID = Workflow.ID.make("wfl_visual_host")
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
    readySelector: "#ready",
    viewport: { name: "desktop", width: 1440, height: 900 },
  })
  return { host, preview, image }
})

describe("WorkflowVisualHost", () => {
  test("accepts only opaque loopback capability handles", () => {
    const capability = "a".repeat(64)
    expect(WorkflowVisualHost.validateHandle(`http://127.0.0.1:4173/${capability}/`)).toBe(true)
    for (const value of [
      `https://127.0.0.1:4173/${capability}/`,
      `http://localhost:4173/${capability}/`,
      `http://127.0.0.1:0/${capability}/`,
      `http://user:pass@127.0.0.1:4173/${capability}/`,
      `http://127.0.0.1:4173/${capability}/?url=https://example.com`,
      "file:///D:/workspace/index.html",
      "https://example.com",
    ]) {
      expect(WorkflowVisualHost.validateHandle(value)).toBe(false)
    }
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
            ["capture", "materializeReference", "prepareImplementation", "recoverExpired"].toSorted(),
          )
          return yield* host.prepareImplementation({ workflowID, revision: 3, plan })
        }),
      ).pipe(Effect.provide(WorkflowVisualHost.fakeLayer())),
    )

    expect(result.revision).toBe(3)
    expect(result.configSha256).toBe(plan.configSha256)
    expect(WorkflowVisualHost.validateHandle(result.url)).toBe(true)
  })

  test("rejects a shallow-frozen or hash-forged implementation plan", async () => {
    const forged = Object.freeze({
      kind: "script" as const,
      argv: ["bun", "run", "preview"],
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
          return yield* host.prepareImplementation({ workflowID, revision: 0, plan: forged })
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
          return yield* host.prepareImplementation({ workflowID, revision: 0, plan: forged })
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
            readySelector: "#ready",
            viewport: { name: "mobile", width: 390, height: 844 },
          })
          yield* host.recoverExpired({ activeHostIDs: new Set(), expiredBefore: 11 })
          const afterRecovery = yield* host
            .capture({ preview, readySelector: "#ready", viewport: { name: "mobile", width: 390, height: 844 } })
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
