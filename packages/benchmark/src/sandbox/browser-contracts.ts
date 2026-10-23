import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { safePath, EvaluationIdentityV2 } from "../corpus/evaluation-profile"
import type { ProbeRequest } from "../evaluator/independent/host"
import { safeRelayPath } from "./relay-protocol"

export function enforcedDataFrameViolation(event: {
  isTrusted: boolean
  disposition: string
  effectiveDirective: string
  blockedURI: string
  originalPolicy: string
}): boolean {
  if (!event.isTrusted || event.disposition !== "enforce" || event.effectiveDirective !== "frame-src") return false
  if (event.blockedURI === "data" || event.blockedURI.startsWith("data:")) return true
  // Chromium can redact non-network scheme URLs. Only accept the empty URI
  // when the first effective frame-src directive denies every child frame.
  const frame = event.originalPolicy
    .split(";")
    .map((part) => part.trim().split(/\s+/))
    .find((part) => part[0]?.toLowerCase() === "frame-src")
  return event.blockedURI === "" && frame?.length === 2 && frame[1] === "'none'"
}

export function dataFrameWasBlocked(value: {
  executed: boolean
  closed: boolean
  frameURL: string
  cspDenied: boolean
}) {
  return !value.executed && (value.cspDenied || value.frameURL === "about:blank")
}
export function validateBrowserAdmission(raw: unknown) {
  const data = Schema.decodeUnknownSync(Schema.Struct({ canaryURL: Schema.String, fileURL: Schema.String }))(raw, {
    onExcessProperty: "error",
  })
  const url = new URL(data.canaryURL),
    file = new URL(data.fileURL)
  if (
    url.origin !== `http://127.0.0.1:${url.port}` ||
    !/^\/[a-f0-9]{64}$/.test(url.pathname) ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    file.protocol !== "file:" ||
    file.hostname ||
    !/^\/D:\/OpenCode-Benchmark\/Task24\/tmp\/[a-zA-Z0-9_./-]+$/.test(file.pathname) ||
    file.pathname.split("/").includes("..") ||
    file.search ||
    file.hash
  )
    throw new TypeError("TASK24_BROWSER_ADMISSION_INPUT")
  return data
}

export function isAdmittedLinuxBrowserURL(value: string, base: string, paths: readonly string[]): boolean {
  try {
    const root = new URL(base),
      url = new URL(value)
    safeRelayPath(url.pathname)
    return (
      root.protocol === "http:" &&
      root.hostname === "127.0.0.1" &&
      /^\/[a-f0-9]{64}\/$/.test(root.pathname) &&
      !url.username &&
      !url.password &&
      url.origin === root.origin &&
      url.protocol === "http:" &&
      url.pathname.startsWith(root.pathname) &&
      paths.includes("/" + url.pathname.slice(root.pathname.length)) &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
}
export function validateBrowserProbe(request: unknown): asserts request is ProbeRequest {
  const r = Schema.decodeUnknownSync(
    Schema.Struct({
      identity: EvaluationIdentityV2,
      candidate: Schema.Struct({
        archiveFile: Schema.String,
        archiveSha256: Schema.String,
        candidateSha256: Schema.String,
        configSha256: Schema.String,
      }),
      profileSha256: Schema.String,
      timeoutMs: Schema.Literal(30000),
      module: Schema.String,
      inputs: Schema.NonEmptyArray(
        Schema.Struct({
          id: Schema.String,
          fixtures: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
      operations: Schema.NonEmptyArray(
        Schema.Struct({
          id: Schema.String,
          steps: Schema.NonEmptyArray(
            Schema.Struct({
              kind: Schema.Literals(["call", "method", "get"]),
              target: Schema.String,
              args: Schema.Array(Schema.Unknown),
              store: Schema.optionalKey(Schema.String),
            }),
          ),
        }),
      ),
    }),
  )(request, { onExcessProperty: "error" })
  safePath(r.module)
  const target = (name: string) =>
    name.length <= 512 &&
    /^[A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|[0-9]+))*$/.test(name) &&
    !name.split(".").some((p) => ["__proto__", "prototype", "constructor"].includes(p))
  function refs(value: unknown): void {
    if (value && typeof value === "object") {
      if ("$ref" in value) {
        if (Object.keys(value).length !== 1 || typeof value.$ref !== "string" || !target(value.$ref))
          throw new TypeError("TASK24_BROWSER_PROBE_INPUT")
        return
      }
      for (const v of Object.values(value)) refs(v)
    }
  }
  for (const c of r.operations)
    for (const op of c.steps) {
      if (
        !target(op.target) ||
        (op.store !== undefined && (!target(op.store) || op.store.includes("."))) ||
        (op.kind === "get" && op.args.length)
      )
        throw new TypeError("TASK24_BROWSER_PROBE_INPUT")
      refs(op.args)
    }
  if (
    new Set(r.operations.map((c) => c.id)).size !== r.operations.length ||
    canonicalJson(r.inputs.map((c) => c.id)) !== canonicalJson(r.operations.map((c) => c.id))
  )
    throw new TypeError("TASK24_BROWSER_PROBE_INPUT")
  if (
    Buffer.byteLength(canonicalJson(r)) > 1048576 ||
    r.timeoutMs !== 30000 ||
    !r.module ||
    r.module.includes("..") ||
    r.module.startsWith("/") ||
    r.operations.length > 1000
  )
    throw new TypeError("TASK24_BROWSER_PROBE_INPUT")
}
