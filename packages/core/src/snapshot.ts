export * as Snapshot from "./snapshot"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "./config"
import { File } from "./file"
import { FSUtil } from "./fs-util"
import { Git } from "./git"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath, RelativePath } from "./schema"
import { Hash } from "./util/hash"
import { DesignArtifact } from "@opencode-ai/schema/design-artifact"

export const ID = Schema.String.pipe(Schema.brand("Snapshot.ID"))
export type ID = typeof ID.Type

export interface Entry {
  readonly path: RelativePath
  readonly type: "file" | "executable"
  readonly sha256: string
  readonly size: number
}

export const MAX_ENTRIES = 20_000
export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_TREE_BYTES = 64 * 1024 * 1024

export class Error extends Schema.TaggedErrorClass<Error>()("Snapshot.Error", {
  operation: Schema.Literals(["capture", "entries", "files", "diff", "preview", "restore", "materialize"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface CompareInput {
  readonly from: ID
  readonly to: ID
}

export interface DiffInput extends CompareInput {
  readonly context?: number
  readonly paths?: readonly RelativePath[]
}

export interface RestoreInput {
  /** Paths are relative to the project root. */
  readonly files: ReadonlyMap<RelativePath, ID>
}

export interface PreviewInput extends RestoreInput {
  readonly context?: number
}

export interface Interface {
  /**
   * Capture the current Location-scoped filesystem state as a content-addressed
   * tree. Returns `undefined` when snapshots are disabled, unsupported, or the
   * best-effort capture fails.
   */
  readonly capture: () => Effect.Effect<ID | undefined>

  /**
   * Read the exact bounded Location-relative file set from a captured tree.
   * Unsupported entry types and unsafe Windows/path topologies fail closed.
   */
  readonly entries: (input: { readonly snapshot: ID }) => Effect.Effect<readonly Entry[], Error>

  /** Copy an exact bounded captured tree into a new empty host-owned directory. */
  readonly materialize: (input: {
    readonly snapshot: ID
    readonly directory: AbsolutePath
  }) => Effect.Effect<void, Error>

  /**
   * List project-relative paths changed between two captured trees without
   * loading file contents or generating patches.
   */
  readonly files: (input: CompareInput) => Effect.Effect<readonly RelativePath[], Error>

  /**
   * Generate structured per-file diffs between two captured trees. `context`
   * controls unchanged lines around each unified diff hunk.
   */
  readonly diff: (input: DiffInput) => Effect.Effect<readonly File.Diff[], Error>

  /**
   * Preview the filesystem result of a selective restore without modifying the
   * worktree. Each project-relative path maps to the tree it would be restored
   * from.
   */
  readonly preview: (input: PreviewInput) => Effect.Effect<readonly File.Diff[], Error>

  /**
   * Restore selected project-relative paths from their associated trees. A path
   * absent from its selected tree is removed; paths outside the map are untouched.
   */
  readonly restore: (input: RestoreInput) => Effect.Effect<void, Error>

  /**
   * Replace the snapshot index with a captured tree and check out all its entries.
   * Files absent from the tree remain untouched. Prefer selective `restore` when
   * only known paths should change.
   */
  readonly checkout: (snapshot: ID) => Effect.Effect<void, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Snapshot") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const source = yield* git.repo.discover(location.project.directory)
    const worktree = source
      ? AbsolutePath.make(yield* fs.realPath(source.worktree).pipe(Effect.orDie))
      : location.project.directory
    const gitDirectory = AbsolutePath.make(path.join(global.data, "snapshot", location.project.id, Hash.fast(worktree)))

    const scope = Effect.fnUntraced(function* () {
      const relative = path.relative(worktree, location.directory)
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* new Error({ operation: "capture", message: "Location is outside the project" })
      return RelativePath.make(relative.replaceAll("\\", "/") || ".")
    })

    const repository = Effect.fnUntraced(function* () {
      if (!source) return yield* new Error({ operation: "capture", message: "Project is not a Git repository" })
      if (yield* fs.existsSafe(path.join(gitDirectory, "HEAD")))
        return new Git.Repository({
          worktree,
          gitDirectory,
          commonDirectory: gitDirectory,
        })
      return yield* git.repo
        .create({
          worktree,
          gitDirectory,
          seed: source,
        })
        .pipe(Effect.mapError((cause) => failure("capture", cause)))
    })

    const enabled = Effect.fnUntraced(function* () {
      if (location.vcs?.type !== "git") return false
      return Config.latest(yield* config.entries(), "snapshots") !== false
    })

    const capture = Effect.fn("Snapshot.capture")(function* () {
      if (!(yield* enabled())) return undefined
      return yield* Effect.gen(function* () {
        const repo = yield* repository()
        return ID.make(
          yield* git.tree.capture({
            repository: repo,
            scopes: [yield* scope()],
            ignores: source,
            maximumUntrackedFileBytes: 2 * 1024 * 1024,
          }),
        )
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("failed to capture snapshot", { cause }).pipe(Effect.as(undefined))),
      )
    })

    const compare = Effect.fnUntraced(function* (operation: "files" | "diff", input: CompareInput) {
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure(operation, cause)))
      return { repository: repo, from: Git.TreeID.make(input.from), to: Git.TreeID.make(input.to) }
    })

    const entries = Effect.fn("Snapshot.entries")(function* (input: { readonly snapshot: ID }) {
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("entries", cause)))
      const locationScope = yield* scope().pipe(Effect.mapError((cause) => failure("entries", cause)))
      const raw = yield* git.tree
        .entries({
          repository: repo,
          tree: Git.TreeID.make(input.snapshot),
          scope: locationScope,
          maximumEntries: MAX_ENTRIES,
          maximumFileBytes: MAX_FILE_BYTES,
          maximumTotalBytes: MAX_TREE_BYTES,
        })
        .pipe(Effect.mapError((cause) => failure("entries", cause)))
      const prefix = locationScope === "." ? "" : `${locationScope}/`
      return yield* Effect.try({
        try: () =>
          canonicalEntries(
            raw.map((entry) => {
              if (prefix && !entry.path.startsWith(prefix))
                throw new Error({ operation: "entries", message: "Snapshot entry escapes the Location scope" })
              return {
                path: RelativePath.make(prefix ? entry.path.slice(prefix.length) : entry.path),
                type: entry.mode === "100755" ? ("executable" as const) : ("file" as const),
                sha256: entry.sha256,
                size: entry.size,
              }
            }),
          ),
        catch: (cause) => failure("entries", cause),
      })
    })

    const materialize = Effect.fn("Snapshot.materialize")(function* (input: {
      readonly snapshot: ID
      readonly directory: AbsolutePath
    }) {
      const target = path.resolve(input.directory)
      if (target === path.parse(target).root || FSUtil.contains(worktree, target) || (yield* fs.existsSafe(target)))
        yield* new Error({
          operation: "materialize",
          message: "Snapshot materialization target is unsafe or not empty",
        })
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("materialize", cause)))
      const locationScope = yield* scope().pipe(Effect.mapError((cause) => failure("materialize", cause)))
      const exact = yield* entries({ snapshot: input.snapshot }).pipe(
        Effect.mapError((cause) => failure("materialize", cause)),
      )
      yield* fs.ensureDir(target).pipe(Effect.mapError((cause) => failure("materialize", cause)))
      yield* Effect.forEach(
        exact,
        (entry) =>
          Effect.gen(function* () {
            const destination = path.resolve(target, ...entry.path.split("/"))
            if (!FSUtil.contains(target, destination) || destination === target)
              yield* new Error({ operation: "materialize", message: "Snapshot entry escaped its target" })
            const projectPath = RelativePath.make(locationScope === "." ? entry.path : `${locationScope}/${entry.path}`)
            const bytes = yield* git.tree
              .read({
                repository: repo,
                tree: Git.TreeID.make(input.snapshot),
                path: projectPath,
                maximumBytes: entry.size,
              })
              .pipe(Effect.mapError((cause) => failure("materialize", cause)))
            if (bytes.byteLength !== entry.size || Hash.sha256(Buffer.from(bytes)) !== entry.sha256)
              yield* new Error({
                operation: "materialize",
                message: "Snapshot materialization bytes differ from the captured entry",
              })
            yield* fs
              .writeWithDirs(destination, bytes, entry.type === "executable" ? 0o755 : 0o644)
              .pipe(Effect.mapError((cause) => failure("materialize", cause)))
          }),
        { discard: true },
      ).pipe(Effect.tapError(() => fs.remove(target, { recursive: true, force: true }).pipe(Effect.ignore)))
    })

    const files = Effect.fn("Snapshot.files")(function* (input: CompareInput) {
      const comparison = yield* compare("files", input)
      const files = yield* git.tree.files(comparison).pipe(Effect.mapError((cause) => failure("files", cause)))
      if (!source) return files
      const ignored = yield* git.index
        .ignored({ repository: source, paths: files })
        .pipe(Effect.mapError((cause) => failure("files", cause)))
      return files.filter((file) => !ignored.has(file))
    })

    const diff = Effect.fn("Snapshot.diff")(function* (input: DiffInput) {
      const comparison = yield* compare("diff", input)
      const files = yield* git.tree.files(comparison).pipe(Effect.mapError((cause) => failure("diff", cause)))
      const ignored = source
        ? yield* git.index
            .ignored({ repository: source, paths: files })
            .pipe(Effect.mapError((cause) => failure("diff", cause)))
        : new Set<RelativePath>()
      return yield* git.tree
        .diff({
          ...comparison,
          context: input.context,
          paths: (input.paths ?? files).filter((file) => !ignored.has(file)),
        })
        .pipe(Effect.mapError((cause) => failure("diff", cause)))
    })

    const plan = Effect.fnUntraced(function* (operation: "preview" | "restore", input: RestoreInput) {
      const files = new Map<RelativePath, Git.TreeID>()
      for (const [file, snapshot] of input.files) {
        const absolute = path.resolve(worktree, file)
        if (!FSUtil.contains(worktree, absolute))
          return yield* new Error({ operation, message: `Path escapes the project: ${file}` })
        files.set(file, Git.TreeID.make(snapshot))
      }
      return files
    })

    const preview = Effect.fn("Snapshot.preview")(function* (input: PreviewInput) {
      if (!(yield* enabled())) return yield* new Error({ operation: "preview", message: "Snapshots are disabled" })
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("preview", cause)))
      const files = yield* plan("preview", input)
      const current = yield* git.tree
        .capture({
          repository: repo,
          scopes: Array.from(files.keys()),
          ignores: source,
          maximumUntrackedFileBytes: 2 * 1024 * 1024,
        })
        .pipe(Effect.mapError((cause) => failure("preview", cause)))
      return yield* git.tree
        .preview({
          repository: repo,
          current,
          files,
          context: input.context,
        })
        .pipe(Effect.mapError((cause) => failure("preview", cause)))
    })

    const restore = Effect.fn("Snapshot.restore")(function* (input: RestoreInput) {
      if (!(yield* enabled())) return yield* new Error({ operation: "restore", message: "Snapshots are disabled" })
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("restore", cause)))
      yield* git.tree
        .restore({ repository: repo, files: yield* plan("restore", input) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    const checkout = Effect.fn("Snapshot.checkout")(function* (snapshot: ID) {
      const repo = yield* repository().pipe(Effect.mapError((cause) => failure("restore", cause)))
      yield* git.tree
        .checkout({ repository: repo, tree: Git.TreeID.make(snapshot) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    return Service.of({ capture, entries, materialize, files, diff, preview, restore, checkout })
  }),
)

export const locationLayer = layer.pipe(Layer.provideMerge(Config.locationLayer))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, FSUtil.node, Git.node, Global.node, Location.node],
})

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    capture: () => Effect.succeed(undefined),
    entries: () => Effect.fail(new Error({ operation: "entries", message: "Snapshots are unavailable" })),
    materialize: () => Effect.fail(new Error({ operation: "materialize", message: "Snapshots are unavailable" })),
    files: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    preview: () => Effect.succeed([]),
    restore: () => Effect.void,
    checkout: () => Effect.void,
  }),
)

export function canonicalEntries(input: readonly Entry[]): readonly Entry[] {
  if (input.length > MAX_ENTRIES) throw new Error({ operation: "entries", message: "Snapshot tree is oversized" })
  const entries = input.map((entry) => ({
    path: RelativePath.make(Schema.decodeUnknownSync(DesignArtifact.SourcePath)(entry.path)),
    type: Schema.decodeUnknownSync(Schema.Literals(["file", "executable"]))(entry.type),
    sha256: Schema.decodeUnknownSync(DesignArtifact.Sha256)(entry.sha256),
    size: Schema.decodeUnknownSync(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(MAX_FILE_BYTES)),
    )(entry.size),
  }))
  if (entries.reduce((total, entry) => total + entry.size, 0) > MAX_TREE_BYTES)
    throw new Error({ operation: "entries", message: "Snapshot tree is oversized" })
  const topology = DesignArtifact.sourceTopologyError(entries.map((entry) => entry.path))
  if (topology !== undefined) throw new Error({ operation: "entries", message: topology })
  return Object.freeze(
    entries
      .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map((entry) => Object.freeze(entry)),
  )
}

export function workspaceSha256(input: readonly Entry[]): string {
  const entries = canonicalEntries(input)
  return Hash.sha256(
    Buffer.from(JSON.stringify(entries.map((entry) => [entry.path, entry.type, entry.sha256, entry.size])), "utf8"),
  )
}

function failure(operation: Error["operation"], cause: unknown) {
  if (cause instanceof Error && cause.operation === operation) return cause
  return new Error({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
    cause,
  })
}

/** Legacy persisted session diff shape. */
export type LegacyFileDiff = {
  file?: string
  patch?: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}
