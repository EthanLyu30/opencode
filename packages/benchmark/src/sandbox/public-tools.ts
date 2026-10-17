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
      throw new TypeError("TASK24_PUBLIC_PATH")
    }
    if (
      write &&
      (input.readonly ||
        profile.protectedPaths.some((p) => relative === p || relative.startsWith(p + "/")) ||
        /(?:^|\/)(?:public|\.task24|tests?|__tests__)(?:\/|$)|(?:^|\/)(?:package\.json|.*lock.*|.*config\..*)$/i.test(
          relative,
        ) ||
        !profile.mutablePaths.some((p) => relative === p || relative.startsWith(p + "/")))
    ) {
      events.push({ code: "test-mutation" })
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
          const current = await fileIdentity(file).catch((e) => {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
            return null
          })
          if (canonicalJson(before) !== canonicalJson(current)) throw new TypeError("TASK24_PUBLIC_STALE_BASE")
          await fs.rename(temp, file)
          observed.push(r.path)
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
      return input.backend.check(r.commandID)
    },
    async preview(raw: unknown) {
      await guard()
      const r = Schema.decodeUnknownSync(Schema.Struct({ entry: Schema.String }))(raw, { onExcessProperty: "error" })
      if (!profile.preview || profile.preview.entry !== r.entry) throw new TypeError("TASK24_PUBLIC_PREVIEW")
      return input.backend.preview(r.entry)
    },
    async capture(raw: unknown) {
      await guard()
      const r = Schema.decodeUnknownSync(
        Schema.Struct({ previewID: Schema.String, viewportID: Schema.Literals(["mobile", "tablet", "desktop"]) }),
      )(raw, { onExcessProperty: "error" })
      if (!/^[a-f0-9]{64}$/.test(r.previewID) || !profile.preview) throw new TypeError("TASK24_PUBLIC_CAPTURE")
      return input.backend.capture(r.previewID, r.viewportID)
    },
    journal() {
      return freeze({ toolCalls: calls, events: [...events], writtenPaths: [...observed] })
    },
  }
}
export type PublicToolHost = ReturnType<typeof makePublicToolHost>
