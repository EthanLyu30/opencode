import { win32 } from "node:path"
import { Schema } from "effect"
import { FIXED_VIEWPORTS } from "../evaluator/browser-protocol"
import { sha256Text } from "../hash"
import { HttpsUrl, IsoDateTime, Sha256 } from "../schema"
import { Task24Root } from "../root"
import { canonicalJson } from "./canonical"

const exact = { onExcessProperty: "error" as const }

const DirectPath = Schema.NonEmptyString
const Viewport = Schema.Struct({
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  deviceScaleFactor: Schema.Finite.check(Schema.isGreaterThan(0)),
})

const FairnessFingerprintInput = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  capturedAt: IsoDateTime,
  roots: Schema.Struct({
    task24: DirectPath,
    bun: DirectPath,
    browserRuntime: DirectPath,
    upstreamSource: DirectPath,
  }),
  runtime: Schema.Struct({
    bunVersion: Schema.NonEmptyString,
    nodeVersion: Schema.NonEmptyString,
    playwrightVersion: Schema.NonEmptyString,
    chromiumRevision: Schema.NonEmptyString,
    operatingSystem: Schema.NonEmptyString,
    locale: Schema.NonEmptyString,
    timeZone: Schema.NonEmptyString,
  }),
  docker: Schema.Struct({
    engineVersion: Schema.NonEmptyString,
    imageDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  }),
  fonts: Schema.NonEmptyArray(Schema.Struct({ name: Schema.NonEmptyString, path: DirectPath, sha256: Sha256 })),
  viewports: Schema.Struct({ mobile: Viewport, tablet: Viewport, desktop: Viewport }),
  evaluatorCommands: Schema.NonEmptyArray(Schema.NonEmptyString),
  allowedDependencyMirrors: Schema.Array(HttpsUrl),
  externalNetworkPolicy: Schema.Literal("deny-except-approved-provider-broker"),
})

const FairnessFingerprint = Schema.Struct({ ...FairnessFingerprintInput.fields, sha256: Sha256 })

export type FairnessFingerprintInput = typeof FairnessFingerprintInput.Type
export type FairnessFingerprint = typeof FairnessFingerprint.Type

export function sealFairnessFingerprint(value: unknown): FairnessFingerprint {
  const input = Schema.decodeUnknownSync(FairnessFingerprintInput)(value, exact)
  validate(input)
  const authority = deepFreeze({ ...input })
  return deepFreeze({ ...authority, sha256: sha256Text(canonicalJson(authority)) })
}

export function verifyFairnessFingerprint(value: unknown):
  | { readonly ok: true; readonly fingerprint: FairnessFingerprint }
  | {
      readonly ok: false
      readonly reason: "FAIRNESS_FINGERPRINT_INVALID" | "FAIRNESS_FINGERPRINT_HASH_MISMATCH"
    } {
  try {
    const decoded = Schema.decodeUnknownSync(FairnessFingerprint)(value, exact)
    const { sha256, ...input } = decoded
    const sealed = sealFairnessFingerprint(input)
    if (sealed.sha256 !== sha256) return { ok: false, reason: "FAIRNESS_FINGERPRINT_HASH_MISMATCH" }
    return { ok: true, fingerprint: decoded }
  } catch {
    return { ok: false, reason: "FAIRNESS_FINGERPRINT_INVALID" }
  }
}

function validate(input: FairnessFingerprintInput): void {
  if (input.roots.task24 !== Task24Root.fixed) throw new TypeError("TASK24_FAIRNESS_FINGERPRINT_ROOT_INVALID")
  for (const value of [input.roots.bun, input.roots.browserRuntime, input.roots.upstreamSource]) {
    if (
      !win32.isAbsolute(value) ||
      win32.parse(value).root.toUpperCase() !== "D:\\" ||
      win32.normalize(value) !== value
    ) {
      throw new TypeError("TASK24_FAIRNESS_FINGERPRINT_ROOT_INVALID")
    }
  }
  if (canonicalJson(input.viewports) !== canonicalJson(FIXED_VIEWPORTS)) {
    throw new TypeError("TASK24_FAIRNESS_FINGERPRINT_VIEWPORTS_INVALID")
  }
  if (new Set(input.fonts.map((font) => font.name.toLowerCase())).size !== input.fonts.length) {
    throw new TypeError("TASK24_FAIRNESS_FINGERPRINT_FONT_DUPLICATE")
  }
  for (const font of input.fonts) {
    const value = win32.normalize(font.path)
    const lower = value.toLowerCase()
    const systemFont = lower.startsWith("c:\\windows\\fonts\\")
    const dDrive = win32.parse(value).root.toUpperCase() === "D:\\"
    if (!win32.isAbsolute(value) || value !== font.path || (!systemFont && !dDrive)) {
      throw new TypeError("TASK24_FAIRNESS_FINGERPRINT_FONT_PATH_INVALID")
    }
  }
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value)
    Object.freeze(input)
  }
  return input
}
