export * as ProductionHostRoots from "./production-host-roots"

import fs from "node:fs"
import path from "node:path"
import { HostRootPolicy } from "./host-root-policy"

export const environmentNames = Object.freeze([
  "OPENCODE_WORKFLOW_HOST_ROOT",
  "OPENCODE_WORKFLOW_HOST_DATA",
  "OPENCODE_WORKFLOW_HOST_RUNTIME",
  "OPENCODE_WORKFLOW_HOST_CACHE",
  "OPENCODE_WORKFLOW_HOST_TEMP",
  "OPENCODE_WORKFLOW_EVIDENCE_ROOT",
  "PLAYWRIGHT_BROWSERS_PATH",
  "OPENCODE_WORKFLOW_SANDBOX_ENGINE",
  "OPENCODE_WORKFLOW_SANDBOX_IMAGE",
  "OPENCODE_WORKFLOW_SANDBOX_CONFIG",
  "OPENCODE_WORKFLOW_SANDBOX_TEMP",
] as const)

export type EnvironmentName = (typeof environmentNames)[number]

export interface Roots extends HostRootPolicy.ProductionRoots {
  readonly evidenceRoot: string
  readonly runtimeRoot: string
}

export interface Contract {
  readonly roots: Roots
  readonly sandbox: {
    readonly enginePath: string
    readonly image: string
  }
  readonly policy: HostRootPolicy.ProductionPolicy
}

export function fromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  options: { readonly probe: HostRootPolicy.Probe; readonly workspaceRoots?: readonly string[] },
): Contract {
  const values = {
    OPENCODE_WORKFLOW_HOST_ROOT: required(environment, "OPENCODE_WORKFLOW_HOST_ROOT"),
    OPENCODE_WORKFLOW_HOST_DATA: required(environment, "OPENCODE_WORKFLOW_HOST_DATA"),
    OPENCODE_WORKFLOW_HOST_RUNTIME: required(environment, "OPENCODE_WORKFLOW_HOST_RUNTIME"),
    OPENCODE_WORKFLOW_HOST_CACHE: required(environment, "OPENCODE_WORKFLOW_HOST_CACHE"),
    OPENCODE_WORKFLOW_HOST_TEMP: required(environment, "OPENCODE_WORKFLOW_HOST_TEMP"),
    OPENCODE_WORKFLOW_EVIDENCE_ROOT: required(environment, "OPENCODE_WORKFLOW_EVIDENCE_ROOT"),
    PLAYWRIGHT_BROWSERS_PATH: required(environment, "PLAYWRIGHT_BROWSERS_PATH"),
    OPENCODE_WORKFLOW_SANDBOX_ENGINE: required(environment, "OPENCODE_WORKFLOW_SANDBOX_ENGINE"),
    OPENCODE_WORKFLOW_SANDBOX_IMAGE: required(environment, "OPENCODE_WORKFLOW_SANDBOX_IMAGE"),
    OPENCODE_WORKFLOW_SANDBOX_CONFIG: required(environment, "OPENCODE_WORKFLOW_SANDBOX_CONFIG"),
    OPENCODE_WORKFLOW_SANDBOX_TEMP: required(environment, "OPENCODE_WORKFLOW_SANDBOX_TEMP"),
  }
  const dataRoot = canonicalDirectory(values.OPENCODE_WORKFLOW_HOST_DATA)
  const evidenceRoot = canonicalDirectory(values.OPENCODE_WORKFLOW_EVIDENCE_ROOT)
  if (dataRoot !== evidenceRoot) throw new TypeError("Workflow data and evidence roots must be the same directory")
  const runtimeRoot = canonicalDirectory(values.OPENCODE_WORKFLOW_HOST_RUNTIME)
  const browserRuntimeRoot = canonicalDirectory(values.PLAYWRIGHT_BROWSERS_PATH)
  if (runtimeRoot !== browserRuntimeRoot) {
    throw new TypeError("Workflow runtime and Playwright roots must be the same directory")
  }
  const policy = HostRootPolicy.makeProduction({
    deploymentRoot: values.OPENCODE_WORKFLOW_HOST_ROOT,
    dataRoot,
    browserRuntimeRoot,
    browserCacheRoot: values.OPENCODE_WORKFLOW_HOST_CACHE,
    previewCapabilityRoot: values.OPENCODE_WORKFLOW_HOST_TEMP,
    dockerConfigRoot: values.OPENCODE_WORKFLOW_SANDBOX_CONFIG,
    dockerTempRoot: values.OPENCODE_WORKFLOW_SANDBOX_TEMP,
    workspaceRoots: options.workspaceRoots,
    probe: options.probe,
  })
  const roots = Object.freeze({ ...policy.roots, evidenceRoot: dataRoot, runtimeRoot })
  return Object.freeze({
    roots,
    sandbox: Object.freeze({
      enginePath: values.OPENCODE_WORKFLOW_SANDBOX_ENGINE,
      image: values.OPENCODE_WORKFLOW_SANDBOX_IMAGE,
    }),
    policy,
  })
}

function required(environment: Readonly<Record<string, string | undefined>>, name: EnvironmentName): string {
  const value = environment[name]
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`)
  return value
}

function canonicalDirectory(value: string): string {
  if (!path.win32.isAbsolute(value) || !/^D:\\/i.test(value)) {
    throw new TypeError("Workflow production roots must be absolute D-drive directories")
  }
  assertCanonicalWindowsLexeme(value)
  const lexical = path.resolve(value)
  const canonical = fs.realpathSync.native(lexical)
  const stat = fs.lstatSync(lexical)
  if (canonical !== lexical || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("Workflow production roots must not be aliases or reparse points")
  }
  return canonical
}

function assertCanonicalWindowsLexeme(value: string): void {
  const remainder = value.slice(3)
  const parts = remainder.split("\\")
  if (
    value.slice(0, 3) !== "D:\\" ||
    value.includes("/") ||
    value !== path.win32.normalize(value) ||
    parts.some(
      (part) =>
        part.length === 0 ||
        part === "." ||
        part === ".." ||
        /[. ]$/.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  ) {
    throw new TypeError("Workflow production roots must not be aliases or reparse points")
  }
}
