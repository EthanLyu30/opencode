import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Hash } from "@opencode-ai/core/util/hash"
import { WorkflowSchema } from "@opencode-ai/core/workflow"
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

describe("Snapshot", () => {
  test("seals exact Snapshot bytes without creating a filesystem cache", async () => {
    const source = Buffer.from("sealed implementation\n")
    const entries = [
      {
        path: RelativePath.make("index.html"),
        type: "file" as const,
        sha256: Hash.sha256(source),
        size: source.byteLength,
      },
    ]
    const archive = await WorkflowWorkspaceMaterialization.seal(entries, async () => source)
    const sealed = WorkflowWorkspaceMaterialization.bind({
      workflowID: WorkflowSchema.ID.make("wfl_sealed_snapshot"),
      stageID: WorkflowSchema.StageID.make("wfs_sealed_snapshot"),
      revision: 0,
      location: Location.Ref.make({ directory: AbsolutePath.make("D:\\sealed-snapshot") }),
      snapshotRef: Snapshot.ID.make("sealed-tree"),
      manifestSha256: "1".repeat(64),
      workspaceSha256: archive.workspaceSha256,
      archive,
    })

    source.fill(0)

    expect(Buffer.from(WorkflowWorkspaceMaterialization.bytes(archive).get(RelativePath.make("index.html"))!)).toEqual(
      Buffer.from("sealed implementation\n"),
    )
    expect(archive.workspaceSha256).toBe(Snapshot.workspaceSha256(entries))
    expect(sealed).not.toHaveProperty("root")
    expect(sealed).not.toHaveProperty("leaseID")
    expect(WorkflowWorkspaceMaterialization.validate(sealed)).toEqual(sealed)
    expect(() =>
      WorkflowWorkspaceMaterialization.validateArchive({
        ...archive,
        entries: [{ ...archive.entries[0], contentBase64: Buffer.from("drift").toString("base64") }],
      }),
    ).toThrow("archive")
  })

  testEffect(Layer.empty).live("captures and restores Location-scoped changes", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const location = path.join(project, "scope")
          yield* Effect.promise(async () => {
            await fs.mkdir(location, { recursive: true })
            await fs.writeFile(path.join(location, "tracked.txt"), "one\n")
            await fs.writeFile(path.join(project, "outside.txt"), "outside\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          const layer = snapshotLayer(tmp.path, location)
          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return

            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(location, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(location, "added.txt"), "added\n")
              await fs.writeFile(path.join(project, "outside.txt"), "changed outside\n")
            })
            const after = yield* snapshot.capture()
            expect(after).toBeDefined()
            if (!after) return

            expect(yield* snapshot.files({ from: before, to: after })).toEqual([
              RelativePath.make("scope/added.txt"),
              RelativePath.make("scope/tracked.txt"),
            ])
            const plan = new Map([[RelativePath.make("scope/tracked.txt"), before]])
            const preview = yield* snapshot.preview({ files: plan, context: 1 })
            expect(preview).toHaveLength(1)
            expect(preview[0]?.path).toBe(RelativePath.make("scope/tracked.txt"))
            yield* snapshot.restore({ files: plan })
            expect(yield* read(path.join(location, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(location, "added.txt"))).toBe("added\n")
            expect(yield* read(path.join(project, "outside.txt"))).toBe("changed outside\n")
          }).pipe(Effect.provide(layer))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("exposes canonical bounded Location entries with content SHA-256", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const location = path.join(project, "scope")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(location, "nested"), { recursive: true })
            await fs.writeFile(path.join(location, "z.txt"), "z\n")
            await fs.writeFile(path.join(location, "nested", "a.txt"), "alpha\n")
            await fs.writeFile(path.join(project, "outside.txt"), "outside\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const captured = yield* snapshot.capture()
            expect(captured).toBeDefined()
            if (!captured) return
            const entriesMethod = Reflect.get(snapshot, "entries") as
              | ((input: {
                  readonly snapshot: Snapshot.ID
                }) => Effect.Effect<readonly Snapshot.Entry[], Snapshot.Error>)
              | undefined
            expect(entriesMethod).toBeFunction()
            if (!entriesMethod) return
            const entries = yield* entriesMethod({ snapshot: captured })
            expect(entries).toEqual([
              {
                path: RelativePath.make("nested/a.txt"),
                type: "file",
                sha256: Hash.sha256(Buffer.from("alpha\n")),
                size: 6,
              },
              {
                path: RelativePath.make("z.txt"),
                type: "file",
                sha256: Hash.sha256(Buffer.from("z\n")),
                size: 2,
              },
            ])
            expect(Reflect.get(Snapshot, "workspaceSha256")).toBeFunction()
            expect(
              (Reflect.get(Snapshot, "workspaceSha256") as (value: readonly Snapshot.Entry[]) => string)(entries),
            ).toMatch(/^[a-f0-9]{64}$/)
            const contentsMethod = Reflect.get(snapshot, "contents") as
              | ((input: {
                  readonly snapshot: Snapshot.ID
                }) => Effect.Effect<readonly Snapshot.Content[], Snapshot.Error>)
              | undefined
            expect(contentsMethod).toBeFunction()
            if (!contentsMethod) return
            const contents = yield* contentsMethod({ snapshot: captured })
            expect(
              contents.map(({ bytes, ...entry }) => ({ ...entry, text: Buffer.from(bytes).toString("utf8") })),
            ).toEqual([
              { ...entries[0], text: "alpha\n" },
              { ...entries[1], text: "z\n" },
            ])
            contents[0]?.bytes.fill(0)
            const reread = yield* contentsMethod({ snapshot: captured })
            expect(Buffer.from(reread[0]?.bytes ?? []).toString("utf8")).toBe("alpha\n")
          }).pipe(Effect.provide(snapshotLayer(tmp.path, location)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("treats capture outside Git as unavailable", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          expect(
            yield* Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, tmp.path))),
          ).toBeUndefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("fails closed when a scoped untracked file exceeds the capture bound", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "tracked\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add tracked.txt`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
            await fs.writeFile(path.join(project, "oversized.bin"), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
          })

          expect(
            yield* Effect.gen(function* () {
              return yield* (yield* Snapshot.Service).capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, project))),
          ).toBeUndefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("isolates snapshot indexes by canonical Git worktree", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const linked = path.join(tmp.path, "linked")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "main\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
            await $`git worktree add --detach ${linked} HEAD`.cwd(project).quiet()
          })

          const capture = (directory: string) =>
            Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              return yield* snapshot.capture()
            }).pipe(Effect.provide(snapshotLayer(tmp.path, directory)))
          expect(yield* capture(project)).toBeDefined()
          expect(yield* capture(linked)).toBeDefined()

          const projectID = yield* Effect.gen(function* () {
            return (yield* Location.Service).project.id
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(project) }))),
            ),
          )
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(project)))),
          ).toBeDefined()
          expect(
            yield* Effect.promise(() => fs.stat(path.join(tmp.path, "snapshot", projectID, Hash.fast(linked)))),
          ).toBeDefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  testEffect(Layer.empty).live("checks out a legacy revert snapshot without removing unrelated files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(project)
            await fs.writeFile(path.join(project, "tracked.txt"), "one\n")
            await $`git init`.cwd(project).quiet()
            await $`git config core.fsmonitor false`.cwd(project).quiet()
            await $`git config commit.gpgsign false`.cwd(project).quiet()
            await $`git config user.email test@opencode.test`.cwd(project).quiet()
            await $`git config user.name Test`.cwd(project).quiet()
            await $`git add .`.cwd(project).quiet()
            await $`git commit -m initial`.cwd(project).quiet()
          })

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            expect(before).toBeDefined()
            if (!before) return
            yield* Effect.promise(async () => {
              await fs.writeFile(path.join(project, "tracked.txt"), "two\n")
              await fs.writeFile(path.join(project, "unrelated.txt"), "keep\n")
            })
            yield* snapshot.checkout(before)
            expect(yield* read(path.join(project, "tracked.txt"))).toBe("one\n")
            expect(yield* read(path.join(project, "unrelated.txt"))).toBe("keep\n")
          }).pipe(Effect.provide(snapshotLayer(tmp.path, project)))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

function snapshotLayer(data: string, directory: string) {
  return AppNodeBuilder.build(Snapshot.node, [
    [Location.node, Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(directory) }))],
    [Global.node, Global.layerWith({ data, config: path.join(data, "config") })],
  ])
}

function read(file: string) {
  return Effect.promise(() => fs.readFile(file, "utf8")).pipe(Effect.map((content) => content.replaceAll("\r\n", "\n")))
}
