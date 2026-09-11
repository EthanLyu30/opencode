import { WorkflowSchema } from "@opencode-ai/core/workflow"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import { Effect } from "effect"
import { spawn as spawnProcess } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { VisualHostClaim } from "../src/workflow/visual-host-claim"
import { WorkflowVisualHostServer } from "../src/workflow/visual-host"
import { ProcessOwnership } from "../src/workflow/process-ownership"

const workflowID = WorkflowSchema.ID.make("wfl_visual_claim_cross_process")
const stageID = WorkflowSchema.StageID.make("wfs_visual_claim_cross_process")
const [, , mode, root, ...args] = process.argv

if (mode === undefined || root === undefined) throw new TypeError("worker mode and root are required")

try {
  const result = await run(mode, root, args)
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`)
} catch (cause) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : String(cause) })}\n`,
  )
}

async function run(mode: string, root: string, args: readonly string[]): Promise<unknown> {
  if (mode === "acquire") {
    const claim = await VisualHostClaim.acquire(root, makeBody(purpose(args[0]), revision(args[1]), args[2] ?? "a"))
    return { status: claim.status, generation: claim.claim.body.generation }
  }
  if (mode === "pause-acquire") {
    const seam = required(args[0], "acquire pause seam")
    const ready = required(args[1], "ready marker")
    const resume = required(args[2], "resume marker")
    const claimFile = required(args[3], "claim marker")
    const candidate = makeBody("reference", 0, args[4] ?? "paused-acquire")
    const wait = async () => {
      await publishMarker(ready)
      await waitForMarker(resume)
    }
    const result = await VisualHostClaim.acquire(root, candidate, {
      afterPendingInserted: async () => {
        await publishValue(claimFile, JSON.stringify(candidate))
        if (seam === "pending-inserted") await wait()
      },
      afterMirrorLinked: seam === "mirror-linked" ? wait : undefined,
    })
    return { status: result.status, generation: result.claim.body.generation }
  }
  if (mode === "rollback-known") {
    const claimFile = required(args[0], "claim marker")
    const started = required(args[1], "started marker")
    const pauseReady = args[2]
    const pauseResume = args[3]
    const candidate = JSON.parse(await fs.readFile(claimFile, "utf8")) as VisualHostClaim.Body
    const key = VisualHostClaim.keyOf(candidate)
    const claim: VisualHostClaim.Owned = {
      key,
      file: path.join(root, ".claims", `${key}.json`),
      body: candidate,
      sha256: VisualHostClaim.digest(candidate),
      registered: true,
      state: "pending",
    }
    await publishMarker(started)
    const rolledBack = await VisualHostClaim.rollbackPending(
      root,
      claim,
      async () => {
        if (pauseReady !== undefined && pauseResume !== undefined) {
          await publishMarker(pauseReady)
          await waitForMarker(pauseResume)
        }
      },
      async () => true,
    )
    return { rolledBack }
  }
  if (mode === "block-acquire") {
    const seam = args[0]
    const marker = required(args[1], "marker")
    const hooks: VisualHostClaim.AcquireHooks = {}
    const block = async () => {
      await publishMarker(marker)
      await never()
    }
    if (seam === "registry-pending-created") Reflect.set(hooks, "afterRegistryPendingCreated", block)
    else if (seam === "registry-pending-initialized") Reflect.set(hooks, "afterRegistryPendingInitialized", block)
    else if (seam === "registry-published") Reflect.set(hooks, "afterRegistryPublished", block)
    else if (seam === "pending-inserted") Reflect.set(hooks, "afterPendingInserted", block)
    else if (seam === "mirror-linked") Reflect.set(hooks, "afterMirrorLinked", block)
    else if (seam === "promoted") Reflect.set(hooks, "afterPromoted", block)
    else throw new TypeError("unknown acquire crash seam")
    await VisualHostClaim.acquire(root, makeBody("reference", 0, args[2] ?? "b"), hooks)
    return { unreachable: true }
  }
  if (mode === "release") {
    const acquired = await VisualHostClaim.acquire(root, makeBody(purpose(args[0]), revision(args[1]), args[2] ?? "c"))
    if (acquired.status !== "acquired") return { status: acquired.status }
    const releasing = await VisualHostClaim.beginRelease(root, acquired.claim)
    await VisualHostClaim.finishRelease(root, releasing, async () => undefined)
    return { status: "released" }
  }
  if (mode === "block-begin-release") {
    const marker = required(args[0], "marker")
    const acquired = await VisualHostClaim.acquire(root, makeBody("reference", 0, args[1] ?? "begin-release"))
    if (acquired.status !== "acquired") throw new TypeError("begin-release worker did not acquire")
    await VisualHostClaim.beginRelease(root, acquired.claim)
    await publishMarker(marker)
    await never()
  }
  if (mode === "block-release") {
    const seam = required(args[0], "release seam")
    const marker = required(args[1], "marker")
    const acquired = await VisualHostClaim.acquire(root, makeBody(purpose(args[2]), revision(args[3]), args[4] ?? "d"))
    if (acquired.status !== "acquired") throw new TypeError("release worker did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root, acquired.claim)
    const block = async () => {
      await publishMarker(marker)
      await never()
    }
    const hooks: VisualHostClaim.FinishReleaseHooks = {}
    if (seam === "cleanup-pending-initialized") Reflect.set(hooks, "afterCleanupLockPendingInitialized", block)
    else if (seam === "cleanup-root-removed") Reflect.set(hooks, "afterCleanupRootRemoved", block)
    else if (seam === "cleanup-lock-created") Reflect.set(hooks, "afterCleanupLockCreated", block)
    else if (seam === "cleanup-retired") Reflect.set(hooks, "afterCleanupLockRetired", block)
    else if (seam === "retirement-linked") Reflect.set(hooks, "afterCleanupRetirementLinked", block)
    else if (seam === "cleanup-lock-removed") Reflect.set(hooks, "afterCleanupLockRemoved", block)
    else if (seam === "journal-removed") Reflect.set(hooks, "afterCleanupJournalRemoved", block)
    else if (seam === "database-removed") Reflect.set(hooks, "afterCleanupDatabaseRemoved", block)
    else if (seam === "mirror-unlinked") Reflect.set(hooks, "afterMirrorUnlinked", block)
    else if (seam === "row-deleted") Reflect.set(hooks, "afterRowDeleted", block)
    else if (seam === "marker-removed") Reflect.set(hooks, "afterCleanupMarkerRemoved", block)
    else if (seam !== "cleanup-callback") throw new TypeError("unknown release crash seam")
    await VisualHostClaim.finishRelease(
      root,
      releasing,
      seam === "cleanup-callback" ? block : async () => undefined,
      hooks,
    )
    return { unreachable: true }
  }
  if (mode === "pause-old-finisher") {
    const claimFile = required(args[0], "claim marker")
    const ready = required(args[1], "ready marker")
    const resume = required(args[2], "resume marker")
    const acquired = await VisualHostClaim.acquire(root, makeBody("reference", 0, args[3] ?? "old-finisher"))
    if (acquired.status !== "acquired") throw new TypeError("old finisher worker did not acquire")
    const releasing = await VisualHostClaim.beginRelease(root, acquired.claim)
    await publishValue(claimFile, JSON.stringify(releasing))
    await publishMarker(ready)
    await waitForMarker(resume)
    let cleanupCalls = 0
    try {
      const released = await VisualHostClaim.finishRelease(root, releasing, async () => {
        cleanupCalls++
      })
      return { released, cleanupCalls, rejected: false }
    } catch (cause) {
      return {
        cleanupCalls,
        rejected: true,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }
  }
  if (mode === "finish-known-and-replace") {
    const claimFile = required(args[0], "claim marker")
    const releasing = JSON.parse(await fs.readFile(claimFile, "utf8")) as VisualHostClaim.Owned
    let cleanupCalls = 0
    await VisualHostClaim.finishRelease(root, releasing, async () => {
      cleanupCalls++
    })
    const replacement = await VisualHostClaim.acquire(root, makeBody("reference", 0, args[1] ?? "replacement-finisher"))
    return {
      cleanupCalls,
      status: replacement.status,
      generation: replacement.claim.body.generation,
    }
  }
  if (mode === "finish-known-race") {
    const claimFile = required(args[0], "claim marker")
    const started = required(args[1], "started marker")
    const prechecked = required(args[2], "precheck marker")
    const cleanupReady = args[3]
    const cleanupResume = args[4]
    const retireReady = required(args[5], "retire marker")
    const retireResume = required(args[6], "retire resume marker")
    const retirementReady = required(args[7], "retirement marker")
    const retirementResume = required(args[8], "retirement resume marker")
    const retirementPendingReady = args[9]
    const retirementPendingResume = args[10]
    const releasing = JSON.parse(await fs.readFile(claimFile, "utf8")) as VisualHostClaim.Owned
    let cleanupCalls = 0
    await publishMarker(started)
    try {
      const released = await VisualHostClaim.finishRelease(
        root,
        releasing,
        async () => {
          cleanupCalls++
          if (
            cleanupReady !== undefined &&
            cleanupReady !== "-" &&
            cleanupResume !== undefined &&
            cleanupResume !== "-"
          ) {
            await publishMarker(cleanupReady)
            await waitForMarker(cleanupResume)
          }
        },
        {
          afterLockOpened: async () => publishMarker(prechecked),
          beforeCleanupLockRetire: async () => {
            await publishMarker(retireReady)
            await waitForMarker(retireResume)
          },
          beforeCleanupRetirementPublish: async () => {
            await publishMarker(retirementReady)
            await waitForMarker(retirementResume)
          },
          afterCleanupRetirementPendingCreated:
            retirementPendingReady !== undefined &&
            retirementPendingReady !== "-" &&
            retirementPendingResume !== undefined &&
            retirementPendingResume !== "-"
              ? async () => {
                  await publishMarker(retirementPendingReady)
                  await waitForMarker(retirementPendingResume)
                }
              : undefined,
        },
      )
      return { released, cleanupCalls, rejected: false }
    } catch (cause) {
      return {
        cleanupCalls,
        rejected: true,
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }
  }
  if (mode === "manifest-block") {
    const seam = required(args[0], "manifest seam")
    const marker = required(args[1], "marker")
    const block = async () => {
      await publishMarker(marker)
      await never()
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          yield* host.materializeReference({
            workflowID,
            referenceApp: {
              entrypoint: "index.html",
              readySelector: "#ready",
              projectStack: ["HTML"],
              files: [{ path: "index.html", content: '<!doctype html><div id="ready"></div>' }],
            },
          })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: root,
            browser: { capture: async () => new Uint8Array(), close: async () => undefined },
            resolvePreviewLease: async () => lease(),
            isPreviewLeaseLive: async () => true,
            onRecordStagingCreated: seam === "directory-created" ? block : undefined,
            onRecordStaged: seam === "manifest-synced" ? block : undefined,
            onRecordPublished: seam === "final-published" ? block : undefined,
          }),
        ),
      ),
    )
    return { unreachable: true }
  }
  if (mode === "script-block") {
    const workspace = required(args[0], "workspace")
    const marker = required(args[1], "marker")
    const pidFile = required(args[2], "pid file")
    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspace) }),
      preview: { kind: "script", argv: ["node", "server.mjs"] },
      allowedOrigins: [],
    })
    let child: ReturnType<typeof spawnProcess> | undefined
    const closed = () => new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
    const ownership: ProcessOwnership.Service = {
      available: true,
      start: async () => {
        child = spawnProcess(process.execPath, ["-e", "setInterval(() => undefined, 60_000)"], {
          cwd: workspace,
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        })
        child.unref()
        if (child.pid === undefined) throw new TypeError("owned process pid is unavailable")
        const exited = new Promise<number>((resolve) => {
          child!.once("exit", (code) => resolve(code ?? 1))
          child!.once("error", () => resolve(1))
        })
        await publishValue(pidFile, String(child.pid))
        return {
          origin: "http://127.0.0.1:43199",
          exited,
          stdout: closed(),
          stderr: closed(),
        }
      },
      stop: async () => {
        child?.kill()
      },
      recover: async () => undefined,
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* WorkflowVisualHost.Service
          yield* host.prepareImplementation({ workflowID, revision: 1, plan })
        }),
      ).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: root,
            browser: { capture: async () => new Uint8Array(), close: async () => undefined },
            processOwnership: ownership,
            resolveImplementationContract: async () => ({
              implementationSha256: "e".repeat(64),
              readySelector: "#ready",
              previewLease: lease(),
            }),
            resolvePreviewLease: async () => lease(),
            isPreviewLeaseLive: async () => true,
            onProcessStarted: async () => {
              await publishMarker(marker)
              await never()
            },
          }),
        ),
      ),
    )
    return { unreachable: true }
  }
  if (mode === "recover-script") {
    const pidFile = required(args[0], "pid file")
    const recovered = required(args[1], "recovered marker")
    const ownership: ProcessOwnership.Service = {
      available: true,
      start: async () => {
        throw new Error("unused")
      },
      stop: async () => undefined,
      recover: async () => {
        const pid = Number(await fs.readFile(pidFile, "utf8"))
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("invalid owned process pid")
        try {
          process.kill(pid)
        } catch (cause) {
          if (!(cause instanceof Error) || Reflect.get(cause, "code") !== "ESRCH") throw cause
        }
        await publishMarker(recovered)
      },
    }
    await Effect.runPromise(
      Effect.scoped(WorkflowVisualHost.Service).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: root,
            browser: { capture: async () => new Uint8Array(), close: async () => undefined },
            processOwnership: ownership,
            resolvePreviewLease: async () => lease(),
            isPreviewLeaseLive: async () => false,
          }),
        ),
      ),
    )
    return { status: "recovered" }
  }
  if (mode === "recover-host") {
    await Effect.runPromise(
      Effect.scoped(WorkflowVisualHost.Service).pipe(
        Effect.provide(
          WorkflowVisualHostServer.makeLayer({
            hostRoot: root,
            browser: { capture: async () => new Uint8Array(), close: async () => undefined },
            resolvePreviewLease: async () => lease(),
            isPreviewLeaseLive: async () => false,
          }),
        ),
      ),
    )
    return { status: "recovered" }
  }
  if (mode === "list") {
    return (await VisualHostClaim.list(root)).map((claim) => ({
      state: claim.state,
      generation: claim.body.generation,
    }))
  }
  throw new TypeError("unknown worker mode")
}

function makeBody(kind: VisualHostClaim.Purpose, revision: number, seed: string): VisualHostClaim.Body {
  const identity = (name: string) => createHash("sha256").update(`${seed}:${name}`).digest("hex")
  return VisualHostClaim.make({
    purpose: kind,
    kind: "static",
    ...lease(),
    hostID: WorkflowVisualHost.HostID.make(identity("host")),
    nonce: identity("nonce"),
    createdAt: 10,
    revision,
    configurationSha256: identity("configuration"),
    sourceSha256: identity("source"),
  })
}

function lease(): WorkflowVisualHost.PreviewLeaseAuthority {
  return {
    workflowID,
    stageID,
    attempt: 1,
    leaseOwner: "visual-claim-cross-process-owner",
    leaseExpiresAt: 2_000_000_000_000,
  }
}

function purpose(value: string | undefined): VisualHostClaim.Purpose {
  if (value === "reference" || value === "implementation") return value
  throw new TypeError("invalid purpose")
}

function revision(value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError("invalid revision")
  return parsed
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new TypeError(`${name} is required`)
  return value
}

async function publishMarker(file: string): Promise<void> {
  await publishValue(file, String(process.pid))
}

async function publishValue(file: string, value: string): Promise<void> {
  const pending = `${file}.${process.pid}.pending`
  const handle = await fs.open(pending, "wx", 0o600)
  try {
    await handle.writeFile(value, "utf8")
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(pending, file)
}

async function never(): Promise<never> {
  return new Promise<never>(() => undefined)
}

async function waitForMarker(file: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await fs.exists(file)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("resume marker timed out")
}
