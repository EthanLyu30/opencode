export * as WorkflowModelCatalogStore from "./store"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { Flock } from "../../util/flock"
import { WorkflowModelCatalogPolicy } from "./policy"
import { WorkflowBusinessArtifact } from "../artifacts/business"
export interface Options {
  signal?: AbortSignal
  lockTimeoutMs?: number
  onPublish?: (phase: "before_head" | "after_head") => Promise<void>
}
export interface Interface {
  read: () => Promise<WorkflowModelCatalog.View>
  publish: (input: {
    expectedHeadSha256: string | null
    catalogue: WorkflowModelCatalog.Catalogue
    policy: WorkflowModelCatalog.Policy
  }) => Promise<WorkflowModelCatalog.Head>
}
const error = (code: WorkflowModelCatalog.ErrorCode = "snapshot_corrupt") =>
  new WorkflowModelCatalog.CatalogError({ code })
const absent = (cause: unknown) =>
  cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT"
// A <=2 MiB wire reply grows after sanitization adds profile/evidence/status fields to <=256 entries.
const snapshotBytes = 4 * 1024 * 1024

// Recheck all ancestor components, including Windows junctions, before filesystem mutation.
async function checked(target: string, directory: boolean, create = false): Promise<boolean> {
  const resolved = path.resolve(target)
  const base = path.parse(resolved).root
  const components = path.relative(base, resolved).split(path.sep).filter(Boolean)
  let current = base
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]!)
    const isDirectory = index < components.length - 1 || directory
    const stat = await fs.lstat(current).catch((cause: unknown) => {
      if (absent(cause)) return null
      throw cause
    })
    if (!stat) {
      if (!create || !isDirectory) return false
      await fs.mkdir(current, { mode: 0o700 }).catch((cause: unknown) => {
        if (!(cause && typeof cause === "object" && "code" in cause && cause.code === "EEXIST")) throw cause
      })
      await checked(current, true)
      continue
    }
    if (
      stat.isSymbolicLink() ||
      (isDirectory ? !stat.isDirectory() : !stat.isFile()) ||
      path.resolve(await fs.realpath(current)).toLowerCase() !== path.resolve(current).toLowerCase()
    )
      throw error()
  }
  return true
}

async function json(target: string): Promise<unknown | null> {
  if (!(await checked(target, false))) return null
  if ((await fs.stat(target)).size > snapshotBytes) throw error()
  const value = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(await fs.readFile(target, "utf8"))
  if (value._tag === "None" || value.value === null) throw error()
  return value.value
}

async function atomic(target: string, content: unknown): Promise<void> {
  await checked(path.dirname(target), true)
  await checked(target, false)
  const temporary = `${target}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(WorkflowBusinessArtifact.encode(content))
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await checked(path.dirname(target), true)
    await checked(target, false)
    await fs.rename(temporary, target)
  } finally {
    // Only this invocation's exact, exclusive temporary file may be removed.
    if (await checked(temporary, false)) await fs.unlink(temporary)
  }
}

async function immutable(target: string, content: unknown): Promise<void> {
  const existing = await json(target)
  if (existing !== null) {
    if (WorkflowBusinessArtifact.encode(existing) !== WorkflowBusinessArtifact.encode(content)) throw error()
    return
  }
  await atomic(target, content)
}

export async function open(root: string, scopeSha256: string, options: Options = {}): Promise<Interface> {
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) === path.parse(root).root ||
    !Schema.is(WorkflowModelCatalog.Sha256)(scopeSha256)
  )
    throw error()
  const directory = path.join(path.resolve(root), "scopes", scopeSha256)
  const lockDirectory = path.join(directory, "locks")
  const guard = async () => {
    for (const child of [
      directory,
      path.join(directory, "catalogues"),
      path.join(directory, "policies"),
      lockDirectory,
    ])
      await checked(child, true, true)
    // Flock reads/removes lock children, so reject links before handing it the directory.
    for (const child of await fs.readdir(lockDirectory, { withFileTypes: true })) {
      const lock = path.join(lockDirectory, child.name)
      await checked(lock, true)
      for (const file of await fs.readdir(lock)) await checked(path.join(lock, file), false)
    }
  }
  await guard().catch(() => {
    throw error()
  })
  const headPath = path.join(directory, "head.json")
  const read = async (): Promise<WorkflowModelCatalog.View> => {
    try {
      if (!(await checked(directory, true))) throw error()
      const raw = await json(headPath)
      if (raw === null)
        return { head: null, catalogue: null, policy: null, stale: true, refreshStatus: "idle", failureCode: null }
      const parsed = Schema.decodeUnknownOption(WorkflowModelCatalog.Head)(raw)
      if (parsed._tag === "None") throw error()
      const head = parsed.value
      const { sha256, ...content } = head
      if (head.scopeSha256 !== scopeSha256 || WorkflowBusinessArtifact.hash(content) !== sha256) throw error()
      const catalogue = WorkflowModelCatalogPolicy.normalizeCatalogue(
        await json(path.join(directory, "catalogues", `${head.catalogueSha256}.json`)),
        scopeSha256,
      )
      const policyRaw = Schema.decodeUnknownOption(WorkflowModelCatalog.Policy)(
        await json(path.join(directory, "policies", `${head.policySha256}.json`)),
      )
      if (policyRaw._tag === "None") throw error()
      const policy = WorkflowModelCatalogPolicy.sealPolicy(policyRaw.value)
      if (
        catalogue.sha256 !== head.catalogueSha256 ||
        policy.sha256 !== head.policySha256 ||
        policyRaw.value.sha256 !== policy.sha256 ||
        policy.scopeSha256 !== scopeSha256
      )
        throw error()
      const catalogueRaw = await json(path.join(directory, "catalogues", `${head.catalogueSha256}.json`))
      if (!Schema.is(WorkflowModelCatalog.Catalogue)(catalogueRaw) || catalogueRaw.sha256 !== catalogue.sha256)
        throw error()
      return {
        head,
        catalogue,
        policy,
        stale: Date.now() - catalogue.observedAt >= 3_600_000,
        refreshStatus: "idle",
        failureCode: null,
      }
    } catch {
      throw error()
    }
  }
  return {
    read,
    publish: async (input) => {
      try {
        const catalogue = WorkflowModelCatalogPolicy.normalizeCatalogue(input.catalogue, scopeSha256)
        const policy = WorkflowModelCatalogPolicy.sealPolicy(input.policy)
        if (policy.scopeSha256 !== scopeSha256) throw error("scope_mismatch")
        if (catalogue.sha256 !== input.catalogue.sha256 || policy.sha256 !== input.policy.sha256) throw error()
        if (
          [catalogue, policy].some((value) => Buffer.byteLength(WorkflowBusinessArtifact.encode(value)) > snapshotBytes)
        )
          throw error("invalid_metadata")
        if (input.expectedHeadSha256 !== null && !Schema.is(WorkflowModelCatalog.Sha256)(input.expectedHeadSha256))
          throw error()
        await guard()
        return await Flock.withLock(
          `workflow-model-catalog:${scopeSha256}`,
          async () => {
            await guard()
            const before = await read()
            if ((before.head?.sha256 ?? null) !== input.expectedHeadSha256) throw error("selection_conflict")
            await immutable(path.join(directory, "catalogues", `${catalogue.sha256}.json`), catalogue)
            await immutable(path.join(directory, "policies", `${policy.sha256}.json`), policy)
            const content = {
              schemaVersion: 1 as const,
              scopeSha256,
              generation: (before.head?.generation ?? 0) + 1,
              catalogueSha256: catalogue.sha256,
              policySha256: policy.sha256,
            }
            const head = { ...content, sha256: WorkflowBusinessArtifact.hash(content) }
            await options.onPublish?.("before_head")
            options.signal?.throwIfAborted()
            await atomic(headPath, head)
            await options.onPublish?.("after_head")
            return head
          },
          { dir: lockDirectory, timeoutMs: options.lockTimeoutMs ?? 10_000, signal: options.signal },
        )
      } catch (cause) {
        if (cause instanceof WorkflowModelCatalog.CatalogError) throw cause
        throw error("selection_conflict")
      }
    },
  }
}
