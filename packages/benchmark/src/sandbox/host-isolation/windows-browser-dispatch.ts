import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { randomBytes } from "node:crypto"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { sha256Text } from "../../hash"
import { directRoot } from "../../corpus/direct-root"
import { loadBrowserRelease } from "../../evaluator/browser-runtime"
import { bindEvidenceFile } from "../../evaluator/evidence"
import { publishImmutable } from "../../offline/atomic"
import { FileIdentity, requireDPath } from "../contracts"
import { fileIdentity } from "../storage"
import type { HostIsolationAdapter } from "../capability"
import { runWindowsBrowserProtocol, createWindowsBrowserRoot } from "./windows-browser"

const Config = Schema.Struct({
  root: Schema.String,
  evidenceRoot: Schema.String,
  releaseRoot: Schema.String,
  helper: FileIdentity,
  manifestSha256: Schema.String,
  allowedEvidenceRoots: Schema.Array(Schema.String),
})
const contains = (root: string, file: string) => root === file || file.startsWith(root + path.sep)

/** Controller dispatch, not an engine receipt. Every invocation earns its own live admission proof. */
export async function createWindowsBrowserDispatch(raw: unknown, guard: () => Promise<void>) {
  const parsed = Schema.decodeUnknownOption(Config)(raw, { onExcessProperty: "error" })
  if (parsed._tag !== "Some" || typeof guard !== "function") throw new TypeError("TASK24_BROWSER_DISPATCH_INPUT")
  const config = parsed.value
  if (!/^[a-f0-9]{64}$/.test(config.manifestSha256) || !config.allowedEvidenceRoots.length)
    throw new TypeError("TASK24_BROWSER_DISPATCH_INPUT")
  for (const root of [config.root, config.evidenceRoot, ...config.allowedEvidenceRoots]) {
    requireDPath(root)
    if (!/^D:\\OpenCode-Benchmark\\Task24\\(?:tmp|workspaces)\\[^\\]+(?:\\.*)?$/.test(root))
      throw new TypeError("TASK24_BROWSER_DISPATCH_INPUT")
    await directRoot(root)
  }
  await guard()
  const release = loadBrowserRelease(config.releaseRoot, { readOnly: true })
  const browser = await fileIdentity(release.browserExecutable),
    node = await fileIdentity(release.nodeExecutable)
  if (canonicalJson(await fileIdentity(config.helper.path)) !== canonicalJson(config.helper))
    throw new TypeError("TASK24_BROWSER_DISPATCH_BINDING")
  let blocked = false
  const dispatch: NonNullable<HostIsolationAdapter["browser"]> = async (input) => {
    if (blocked) throw new TypeError("TASK24_BROWSER_DISPATCH_CLEANUP_BLOCKED")
    await guard()
    input.invocation.signal.throwIfAborted()
    if (
      input.manifestSha256 !== config.manifestSha256 ||
      input.executable !== node.path ||
      canonicalJson(input.helper) !== canonicalJson(config.helper) ||
      canonicalJson(input.browser) !== canonicalJson(browser) ||
      canonicalJson(input.node) !== canonicalJson(node) ||
      input.cwd !== config.root ||
      input.chromiumSandboxRequired !== true ||
      input.denyNonPreviewNetwork !== true ||
      !(input.invocation.stdin instanceof Uint8Array) ||
      input.invocation.stdin.length > 2097152
    )
      throw new TypeError("TASK24_BROWSER_DISPATCH_BINDING")
    const frame = Schema.decodeUnknownSync(
      Schema.Struct({
        temp: Schema.String,
        evidence: Schema.String,
        identity: Schema.Unknown,
        paths: Schema.Array(Schema.String),
      }),
    )(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.invocation.stdin)))
    for (const value of [frame.temp, frame.evidence]) requireDPath(value)
    if (frame.temp !== config.root || !config.allowedEvidenceRoots.some((root) => contains(root, frame.evidence)))
      throw new TypeError("TASK24_BROWSER_DISPATCH_BINDING")
    await directRoot(frame.evidence)
    const scope = await createWindowsBrowserRoot(config.root)
    const root = scope.root
    const temp = path.join(root, "temp"),
      evidence = path.join(root, "evidence"),
      file = path.join(root, "private-canary.txt")
    let safe = true,
      hits = 0
    const canaryID = randomBytes(32).toString("hex")
    let canary: ReturnType<typeof Bun.serve> | undefined, preview: ReturnType<typeof Bun.serve> | undefined
    try {
      canary = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname !== "/" + canaryID) return new Response(null, { status: 404 })
          hits++
          return new Response(canaryID)
        },
      })
      await fs.mkdir(temp)
      await fs.mkdir(evidence)
      await fs.writeFile(file, canaryID, { flag: "wx" })
      const url = `http://127.0.0.1:${canary.port}/${canaryID}`
      if ((await (await fetch(url, { signal: AbortSignal.timeout(2000) })).text()) !== canaryID || hits !== 1)
        throw new TypeError("TASK24_BROWSER_DISPATCH_CANARY")
      hits = 0
      const previewID = randomBytes(32).toString("hex")
      preview = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (request.method !== "GET" || new URL(request.url).pathname !== `/${previewID}/index.html`)
            return new Response(null, { status: 404 })
          return new Response("<!doctype html><html><body><h1>Controller admission</h1></body></html>", {
            headers: {
              "content-type": "text/html",
              "content-security-policy":
                "default-src 'none'; connect-src http://127.0.0.1:* ws://127.0.0.1:*; frame-src 'none'; object-src 'none'; base-uri 'none'",
            },
          })
        },
      })
      const proofURL = `http://127.0.0.1:${preview.port}/${previewID}/`
      const proofFrame = {
        schemaVersion: 2,
        operation: "admission",
        identity: frame.identity,
        base: proofURL,
        previewID,
        paths: ["/index.html"],
        browser: browser.path,
        temp,
        evidence,
        plans: [],
        data: { canaryURL: url, fileURL: pathToFileURL(file).href },
      }
      const proof = await runWindowsBrowserProtocol({
        root: config.root,
        releaseRoot: config.releaseRoot,
        helper: config.helper,
        tempRoot: config.root,
        evidenceRoot: evidence,
        previewID,
        previewURL: proofURL,
        invocation: { ...input.invocation, stdin: Buffer.from(canonicalJson(proofFrame)), timeoutMs: 30000 },
      })
      if (!proof.execution.started || proof.execution.exitCode !== 0 || proof.execution.truncated)
        throw new TypeError("TASK24_BROWSER_DISPATCH_ADMISSION")
      const reply = Schema.decodeUnknownSync(
        Schema.Struct({
          identity: Schema.Unknown,
          operation: Schema.Literal("admission"),
          previewID: Schema.String,
          result: Schema.Struct({
            networkBlocked: Schema.Literal(true),
            websocketBlocked: Schema.Literal(true),
            fileBlocked: Schema.Literal(true),
            dataBlocked: Schema.Literal(true),
            crossCapabilityBlocked: Schema.Literal(true),
            blockedRequests: Schema.Int,
            deniedCanaryAttempts: Schema.Int,
          }),
          observations: Schema.Unknown,
        }),
      )(JSON.parse(Buffer.from(proof.execution.stdout).toString("utf8")), { onExcessProperty: "error" })
      if (
        canonicalJson(reply.identity) !== canonicalJson(frame.identity) ||
        reply.previewID !== previewID ||
        reply.result.deniedCanaryAttempts !== 2 ||
        hits !== 0 ||
        (await fs.readFile(file, "utf8")) !== canaryID
      )
        throw new TypeError("TASK24_BROWSER_DISPATCH_ADMISSION")
      await guard()
      input.invocation.signal.throwIfAborted()
      const actual = await runWindowsBrowserProtocol({
        root: config.root,
        releaseRoot: config.releaseRoot,
        helper: config.helper,
        tempRoot: config.root,
        evidenceRoot: frame.evidence,
        previewID: input.previewID,
        previewURL: input.previewURL,
        invocation: input.invocation,
      })
      await guard()
      if (!actual.execution.started || !actual.containment.cleanupCompleted || hits !== 0)
        throw new TypeError("TASK24_BROWSER_DISPATCH_UNOBSERVED")
      const body = {
        manifestSha256: config.manifestSha256,
        previewID: input.previewID,
        helperSha256: config.helper.sha256,
        nodeSha256: node.sha256,
        browserSha256: browser.sha256,
        ended: true,
        processTreeEnded: actual.containment.processTreeEnded,
        sandboxEnabled:
          actual.containment.renderers.length > 0 &&
          actual.containment.renderers.every((r) => r.appContainer || (r.restricted && r.integrity <= 4096)),
        nonPreviewNetworkBlocked: reply.result.networkBlocked && reply.result.websocketBlocked,
        canaryHealthy: true,
        deniedCanaryAttempts: reply.result.deniedCanaryAttempts,
        canaryHits: hits,
      }
      if (!body.sandboxEnabled) throw new TypeError("TASK24_BROWSER_DISPATCH_UNOBSERVED")
      const value = {
        ...body,
        stdoutSha256: sha256Text(Buffer.from(actual.execution.stdout).toString("base64")),
        exitCode: actual.execution.exitCode,
      }
      const output = path.join(config.evidenceRoot, "browser-isolation-" + sha256Text(canonicalJson(value)) + ".json")
      await publishImmutable(output, canonicalJson(value))
      return {
        execution: actual.execution,
        observation: { ...body, evidence: [bindEvidenceFile(config.evidenceRoot, output, "browser-isolation")] },
      }
    } catch (cause) {
      if (cause && typeof cause === "object" && Reflect.get(cause, "cleanupUncertain") === true) safe = false
      if (!safe) {
        blocked = true
        throw Object.assign(new Error("TASK24_BROWSER_DISPATCH_CLEANUP_UNCERTAIN: " + root, { cause }), {
          root,
          cleanupUncertain: true,
        })
      }
      throw cause
    } finally {
      await canary?.stop(false)
      await preview?.stop(false)
      if (safe) {
        try {
          await scope.dispose()
        } catch (cause) {
          blocked = true
          throw Object.assign(new Error("TASK24_BROWSER_DISPATCH_CLEANUP_UNCERTAIN: " + root, { cause }), {
            root,
            cleanupUncertain: true,
          })
        }
      }
    }
  }
  return dispatch
}
