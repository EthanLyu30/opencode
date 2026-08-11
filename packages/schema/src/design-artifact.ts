export * as DesignArtifact from "./design-artifact"

import { Schema } from "effect"
import { PositiveInt } from "./schema"

const exact = { parseOptions: { onExcessProperty: "error" as const } }

export const SafeIdentifier = Schema.NonEmptyString.check(Schema.isPattern(/^[a-z0-9][a-z0-9_-]*$/)).annotate({
  identifier: "DesignArtifact.SafeIdentifier",
})

export const SourcePath = Schema.NonEmptyString.check(
  Schema.makeFilter<string>((value) => {
    if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value))
      return "Source path must be a normalized relative POSIX path"
    const segments = value.split("/")
    if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
      return "Source path must not contain empty, dot, or parent segments"
    return undefined
  }),
).annotate({ identifier: "DesignArtifact.SourcePath" })

export const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).annotate({
  identifier: "DesignArtifact.Sha256",
})

export const Viewport = Schema.Struct({
  name: SafeIdentifier,
  width: PositiveInt,
  height: PositiveInt,
}).annotate({ identifier: "DesignArtifact.Viewport", ...exact })
export interface Viewport extends Schema.Schema.Type<typeof Viewport> {}

export const SourceFile = Schema.Struct({
  path: SourcePath,
  sha256: Sha256,
  size: PositiveInt,
}).annotate({ identifier: "DesignArtifact.SourceFile", ...exact })
export interface SourceFile extends Schema.Schema.Type<typeof SourceFile> {}

export const ReferenceApp = Schema.Struct({
  entrypoint: Schema.NonEmptyString,
  readySelector: Schema.NonEmptyString,
  files: Schema.NonEmptyArray(SourceFile),
  viewports: Schema.NonEmptyArray(Viewport),
}).annotate({ identifier: "DesignArtifact.ReferenceApp", ...exact })
export interface ReferenceApp extends Schema.Schema.Type<typeof ReferenceApp> {}

const SpecShape = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  goals: Schema.NonEmptyArray(Schema.NonEmptyString),
  routes: Schema.NonEmptyArray(
    Schema.Struct({
      path: Schema.NonEmptyString,
      goal: Schema.NonEmptyString,
    }),
  ),
  layoutConstraints: Schema.NonEmptyArray(Schema.NonEmptyString),
  componentTree: Schema.NonEmptyArray(
    Schema.Struct({
      id: Schema.NonEmptyString,
      component: Schema.NonEmptyString,
      children: Schema.Array(Schema.NonEmptyString),
    }),
  ),
  states: Schema.NonEmptyArray(
    Schema.Struct({
      name: Schema.NonEmptyString,
      description: Schema.NonEmptyString,
    }),
  ),
  typography: Schema.NonEmptyArray(
    Schema.Struct({
      token: Schema.NonEmptyString,
      family: Schema.NonEmptyString,
      weight: PositiveInt,
      sizePx: PositiveInt,
      lineHeight: Schema.Number.check(Schema.isGreaterThan(0)),
    }),
  ),
  colors: Schema.NonEmptyArray(
    Schema.Struct({
      token: Schema.NonEmptyString,
      value: Schema.NonEmptyString,
    }),
  ),
  responsiveRules: Schema.NonEmptyArray(
    Schema.Struct({
      viewport: Schema.NonEmptyString,
      width: PositiveInt,
      height: PositiveInt,
      rules: Schema.NonEmptyArray(Schema.NonEmptyString),
    }),
  ),
  accessibilityRules: Schema.NonEmptyArray(Schema.NonEmptyString),
  acceptanceCriteria: Schema.NonEmptyArray(Schema.NonEmptyString),
  projectStack: Schema.NonEmptyArray(Schema.NonEmptyString),
  referenceApp: ReferenceApp,
})

const safePersistence = Schema.makeFilter<Schema.Schema.Type<typeof SpecShape>>((value) =>
  containsSecret(value) ? "Design artifacts must not contain provider secrets" : undefined,
)

const internallyConsistent = Schema.makeFilter<Schema.Schema.Type<typeof SpecShape>>((value) => {
  const viewports = new Set(value.referenceApp.viewports.map((viewport) => viewport.name))
  if (viewports.size !== value.referenceApp.viewports.length) return "Reference viewport names must be unique"
  const files = new Set(value.referenceApp.files.map((file) => file.path))
  if (files.size !== value.referenceApp.files.length) return "Reference source paths must be unique"
  if (!value.referenceApp.files.some((file) => file.path === value.referenceApp.entrypoint))
    return "Reference entrypoint must name a hashed reference-app file"
  if (value.responsiveRules.some((rule) => !viewports.has(rule.viewport)))
    return "Every responsive rule must target a configured reference viewport"
  return undefined
})

export const Spec = SpecShape.check(safePersistence, internallyConsistent).annotate({
  identifier: "DesignArtifact.Spec",
  ...exact,
})
export interface Spec extends Schema.Schema.Type<typeof Spec> {}

function containsSecret(value: unknown): boolean {
  if (typeof value === "string") return /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{8,})\b/.test(value)
  if (Array.isArray(value)) return value.some(containsSecret)
  if (value === null || typeof value !== "object") return false
  return Object.entries(value).some(
    ([key, item]) =>
      /^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie|set-cookie)$/i.test(key) ||
      containsSecret(item),
  )
}
