import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { decodeTaskExecutionProfile, safePath, freeze, type TaskExecutionProfile } from "../corpus/evaluation-profile"
import { directRoot } from "../corpus/evaluation-bundle"
import { sha256Bytes, sha256Text } from "../hash"
import { fileIdentity } from "./storage"
import type { AuthorityGuard } from "./contracts"
import type { PolicyEventCode } from "../evaluator/policy"
import { publicCaptureContent } from "./mcp-server"

const observations = new WeakSet<object>()
export type PublicToolObservation = Readonly<{
  hostID: string
  workspace: string
  readonly: boolean
  toolCalls: number
  deniedReads: number
  deniedWrites: number
  writes: readonly { path: string; beforeSha256: string | null; afterSha256: string }[]
  checks: readonly {
    commandID: string
    revision: number
    candidateSha256: string
    status: string
    commands: readonly { id: string; exitCode: number }[]
  }[]
  previews: readonly { previewID: string; revision: number; candidateSha256: string }[]
  captures: readonly {
    previewID: string
    viewportID: string
    screenshotSha256: string
    evidenceSha256: string
    revision: number
    candidateSha256: string
  }[]
}>
export function requirePublicToolObservation(value: PublicToolObservation, workspace: string) {
  if (!observations.has(value) || value.workspace !== workspace)
    throw new TypeError("TASK24_PUBLIC_OBSERVATION_AUTHORITY")
}

export type PublicToolBackend = Readonly<{
  check(commandID: string): Promise<unknown>
  preview(entry: string): Promise<unknown>
  capture(previewID: string, viewportID: string): Promise<unknown>
}>
export function makePublicToolHost(input: {
  workspace: string
  profile: TaskExecutionProfile
  backend: PublicToolBackend
  guard: AuthorityGuard
  maxCalls: number
  readonly?: boolean
  signal?: AbortSignal
}) {
  const profile = decodeTaskExecutionProfile(input.profile),
    events: { code: PolicyEventCode }[] = [],
    observed: string[] = []
  let calls = 0,
    queue = Promise.resolve()
  let readonly = input.readonly ?? false,
    deniedReads = 0,
    deniedWrites = 0
  const hostID = randomBytes(16).toString("hex"),
    writes: Array<PublicToolObservation["writes"][number]> = [],
    checks: Array<PublicToolObservation["checks"][number]> = [],
    previews: Array<PublicToolObservation["previews"][number]> = [],
    captures: Array<PublicToolObservation["captures"][number]> = []
  function backendOperation<T>(operation: () => Promise<T>): Promise<T> {
    const work = queue.then(async () => {
      await input.guard()
      input.signal?.throwIfAborted()
      return operation()
    })
    queue = work.then(
      () => {},
      () => {},
    )
    return work
  }
  function writable() {
    if (!readonly) return
    deniedWrites++
    throw new TypeError("TASK24_PUBLIC_PROTECTED")
  }
  async function guard() {
    if (input.signal?.aborted || calls >= input.maxCalls || !Number.isSafeInteger(input.maxCalls) || input.maxCalls < 1)
      throw new TypeError("TASK24_PUBLIC_BUDGET")
    calls++
    await input.guard()
    await directRoot(input.workspace)
  }
  function target(relative: string, write = false) {
    safePath(relative)
    if (/(?:^|\/)(?:private|gold|oracle|\.git|node_modules|\.opencode|\.env)(?:[/.]|$)/i.test(relative)) {
      events.push({ code: "hidden-gold-access" })
      if (!write) deniedReads++
      throw new TypeError("TASK24_PUBLIC_PATH")
    }
    if (
      write &&
      (readonly ||
        profile.protectedPaths.some((p) => relative === p || relative.startsWith(p + "/")) ||
        /(?:^|\/)(?:public|\.task24|tests?|__tests__)(?:\/|$)|(?:^|\/)(?:package\.json|.*lock.*|.*config\..*)$/i.test(
          relative,
        ) ||
        !profile.mutablePaths.some((p) => relative === p || relative.startsWith(p + "/")))
    ) {
      events.push({ code: "test-mutation" })
      if (readonly) deniedWrites++
      throw new TypeError("TASK24_PUBLIC_PROTECTED")
    }
    return path.join(input.workspace, relative)
  }
  return {
    async read(raw: unknown) {
      await guard()
      const r = Schema.decodeUnknownSync(
        Schema.Struct({ path: Schema.String, offset: Schema.Int, length: Schema.Int }),
      )(raw, { onExcessProperty: "error" })
      if (r.offset < 0 || r.length < 1 || r.length > 65536) throw new TypeError("TASK24_PUBLIC_READ_LIMIT")
      const file = target(r.path),
        identity = await fileIdentity(file)
      const stat = await fs.stat(file)
      if (stat.size > 8388608) throw new TypeError("TASK24_PUBLIC_READ_LIMIT")
      const data = await fs.readFile(file)
      if ((await fileIdentity(file)).sha256 !== identity.sha256) throw new TypeError("TASK24_PUBLIC_DRIFT")
      return {
        text: data.subarray(r.offset, r.offset + r.length).toString("utf8"),
        sha256: identity.sha256,
        totalBytes: stat.size,
      }
    },
    async write(raw: unknown) {
      await guard()
      const r = Schema.decodeUnknownSync(
        Schema.Struct({ path: Schema.String, baseSha256: Schema.NullOr(Schema.String), content: Schema.String }),
      )(raw, { onExcessProperty: "error" })
      const file = target(r.path, true)
      if (Buffer.byteLength(r.content) > 8388608) throw new TypeError("TASK24_PUBLIC_WRITE_LIMIT")
      const operation = queue.then(async () => {
        writable()
        await input.guard()
        await directRoot(path.dirname(file))
        const before = await fileIdentity(file).catch((e) => {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
          return null
        })
        if ((before?.sha256 ?? null) !== r.baseSha256) throw new TypeError("TASK24_PUBLIC_STALE_BASE")
        const temp = path.join(path.dirname(file), ".task24-write-" + randomBytes(16).toString("hex"))
        await fs.writeFile(temp, r.content, { flag: "wx" })
        try {
          await input.guard()
          writable()
          const current = await fileIdentity(file).catch((e) => {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
            return null
          })
          if (canonicalJson(before) !== canonicalJson(current)) throw new TypeError("TASK24_PUBLIC_STALE_BASE")
          writable()
          await fs.rename(temp, file)
          observed.push(r.path)
          writes.push({ path: r.path, beforeSha256: before?.sha256 ?? null, afterSha256: sha256Text(r.content) })
          return { sha256: sha256Text(r.content), bytes: Buffer.byteLength(r.content) }
        } finally {
          await fs.unlink(temp).catch((e) => {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
          })
        }
      })
      queue = operation.then(
        () => {},
        () => {},
      )
      return operation
    },
    async check(raw: unknown) {
      await guard()
      const r = Schema.decodeUnknownSync(Schema.Struct({ commandID: Schema.String }))(raw, {
        onExcessProperty: "error",
      })
      if (!profile.checks.some((c) => c.id === r.commandID)) throw new TypeError("TASK24_PUBLIC_COMMAND")
      return backendOperation(async () => {
        const revision = writes.length
        const result = await input.backend.check(r.commandID)
        const observed = Schema.decodeUnknownOption(
          Schema.Struct({
            status: Schema.String,
            candidateSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
            commands: Schema.Array(Schema.Struct({ id: Schema.String, exitCode: Schema.Int })),
          }),
        )(result)
        if (observed._tag === "Some")
          checks.push({
            commandID: r.commandID,
            revision,
            candidateSha256: observed.value.candidateSha256,
            status: observed.value.status,
            commands: observed.value.commands.map((c) => ({ ...c })),
          })
        return result
      })
    },
    async preview(raw: unknown) {
      await guard()
      const r = Schema.decodeUnknownSync(Schema.Struct({ entry: Schema.String }))(raw, { onExcessProperty: "error" })
      if (!profile.preview || profile.preview.entry !== r.entry) throw new TypeError("TASK24_PUBLIC_PREVIEW")
      return backendOperation(async () => {
        const revision = writes.length
        const result = await input.backend.preview(r.entry)
        const observed = Schema.decodeUnknownOption(
          Schema.Struct({
            previewID: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
            candidateSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
          }),
        )(result)
        if (observed._tag === "Some") previews.push({ ...observed.value, revision })
        return result
      })
    },
    async capture(raw: unknown) {
      await guard()
      const r = Schema.decodeUnknownSync(
        Schema.Struct({ previewID: Schema.String, viewportID: Schema.Literals(["mobile", "tablet", "desktop"]) }),
      )(raw, { onExcessProperty: "error" })
      if (!/^[a-f0-9]{64}$/.test(r.previewID) || !profile.preview) throw new TypeError("TASK24_PUBLIC_CAPTURE")
      return backendOperation(async () => {
        const revision = writes.length
        const result = await input.backend.capture(r.previewID, r.viewportID)
        publicCaptureContent(result)
        const observed = Schema.decodeUnknownSync(
          Schema.Struct({
            screenshotSha256: Schema.String,
            evidenceSha256: Schema.String,
            identity: Schema.Struct({
              previewID: Schema.String,
              viewportID: Schema.String,
              candidateSha256: Schema.String,
            }),
          }),
        )(result)
        if (observed.identity.previewID !== r.previewID || observed.identity.viewportID !== r.viewportID)
          throw new TypeError("TASK24_PUBLIC_IMAGE_BINDING")
        captures.push({
          previewID: r.previewID,
          viewportID: r.viewportID,
          screenshotSha256: observed.screenshotSha256,
          evidenceSha256: observed.evidenceSha256,
          revision,
          candidateSha256: observed.identity.candidateSha256,
        })
        return result
      })
    },
    async setReadonly() {
      readonly = true
      await queue
    },
    observation(): PublicToolObservation {
      const value = freeze({
        hostID,
        workspace: input.workspace,
        readonly,
        toolCalls: calls,
        deniedReads,
        deniedWrites,
        writes: writes.map((v) => ({ ...v })),
        checks: checks.map((v) => ({ ...v, commands: v.commands.map((c) => ({ ...c })) })),
        previews: previews.map((v) => ({ ...v })),
        captures: captures.map((v) => ({ ...v })),
      })
      observations.add(value)
      return value
    },
    journal() {
      return freeze({ toolCalls: calls, events: [...events], writtenPaths: [...observed] })
    },
  }
}
export type PublicToolHost = ReturnType<typeof makePublicToolHost>
