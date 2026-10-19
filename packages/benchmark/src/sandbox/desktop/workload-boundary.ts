import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { sha256Text } from "../../hash"
import type { FileIdentity, Gate } from "../contracts"
import { desktopBlocked, type DesktopPlatform } from "./contracts"
import { isNativeDesktopPlatform } from "./platform"
import { requireDesktopFixtureScopeV2 } from "./settings-policy"
import { parseDesktopSettingsJson } from "./settings-json"
import { readDesktopDirectoryV2, readDesktopFileV2 } from "./identity-v2"
import { withDesktopPublicationV2 } from "./publication-v2"
import type { DesktopSpecVersioned, DesktopLaunchSpecV2 } from "./v2-contracts"

export type DesktopWorkloadFact = Readonly<{ sha256: string }>
const facts = new WeakMap<
  DesktopWorkloadFact,
  { specSha256: string; platform: DesktopPlatform; scope: string; file: FileIdentity }
>()
const Empty = Schema.Tuple([])
const State = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  fixtureKind: Schema.Literal("task24-workload-state"),
  scopes: Schema.Struct({ containers: Empty, swarm: Empty, kubernetes: Empty }),
})

function validate(bytes: Uint8Array) {
  Schema.decodeUnknownSync(State)(parseDesktopSettingsJson(bytes, 1048576), { onExcessProperty: "error" })
}
export async function auditDesktopWorkloadBoundary(
  spec: DesktopSpecVersioned,
  platform: DesktopPlatform,
  signal?: AbortSignal,
): Promise<Gate<DesktopWorkloadFact>> {
  // No native collector exists. Do not read disks, query a daemon, or ask for accepted risk.
  if (isNativeDesktopPlatform(platform)) return desktopBlocked("existing_workload_restart_unproved")
  try {
    if (signal?.aborted || spec.schemaVersion !== 2) throw new TypeError("TASK24_DESKTOP_WORKLOAD_SOURCE")
    const scope = await requireDesktopFixtureScopeV2(spec, platform),
      file = await readDesktopFileV2(spec.disks.data.path)
    validate(file.bytes)
    const value = Object.freeze({ sha256: sha256Text(canonicalJson({ spec, scope, file: file.identity })) })
    facts.set(value, { specSha256: sha256Text(canonicalJson(spec)), platform, scope, file: file.identity })
    return { kind: "ready", value }
  } catch (error) {
    return desktopBlocked("existing_workload_restart_unproved", [
      "existing_workload_restart_unproved",
      error instanceof Error && /^[a-zA-Z0-9_.:-]{1,200}$/.test(error.message)
        ? error.message
        : "fixture_workload_not_verified",
    ])
  }
}

async function requireFact(fact: DesktopWorkloadFact, spec: DesktopSpecVersioned, platform: DesktopPlatform) {
  const state = facts.get(fact)
  if (
    !state ||
    isNativeDesktopPlatform(platform) ||
    spec.schemaVersion !== 2 ||
    state.platform !== platform ||
    state.specSha256 !== sha256Text(canonicalJson(spec))
  )
    throw new TypeError("TASK24_DESKTOP_WORKLOAD_AUTHORITY")
  if (state.scope !== (await requireDesktopFixtureScopeV2(spec, platform)))
    throw new TypeError("TASK24_DESKTOP_WORKLOAD_DRIFT")
  return { state, spec: spec as DesktopLaunchSpecV2 }
}
export async function requireDesktopWorkloadFact(
  fact: DesktopWorkloadFact,
  spec: DesktopSpecVersioned,
  platform: DesktopPlatform,
): Promise<void> {
  const context = await requireFact(fact, spec, platform),
    file = await readDesktopFileV2(context.spec.disks.data.path)
  if (canonicalJson(file.identity) !== canonicalJson(context.state.file))
    throw new TypeError("TASK24_DESKTOP_WORKLOAD_DRIFT")
  validate(file.bytes)
}
export async function withDesktopWorkloadFact<T>(
  fact: DesktopWorkloadFact,
  spec: DesktopSpecVersioned,
  platform: DesktopPlatform,
  use: () => Promise<T>,
): Promise<T> {
  const context = await requireFact(fact, spec, platform),
    root = path.dirname(context.state.file.path),
    parents = (await readDesktopDirectoryV2(root)).parents
  return withDesktopPublicationV2({ root, mode: "read", parents, signal: AbortSignal.timeout(120000) }, async (io) => {
    const relative = path.basename(context.state.file.path)
    await io.acquire([relative])
    const file = await io.read(relative)
    if (canonicalJson(file.identity) !== canonicalJson(context.state.file))
      throw new TypeError("TASK24_DESKTOP_WORKLOAD_DRIFT")
    validate(file.bytes)
    await requireFact(fact, spec, platform)
    return use()
  })
}
