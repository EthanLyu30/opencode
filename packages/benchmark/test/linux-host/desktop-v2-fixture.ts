import fs from "node:fs/promises"
import path from "node:path"
import { desktopFixture } from "./desktop-fixture"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"
import { readDesktopFileV2, desktopIdentityV2 } from "../../src/sandbox/desktop/identity-v2"
import {
  decodeDesktopSpecV2,
  desktopRuntimeTargetsV2,
  type DesktopSettingsTarget,
} from "../../src/sandbox/desktop/v2-contracts"
import type { DesktopPlatform, DesktopProcessIdentity } from "../../src/sandbox/desktop/contracts"

export async function desktopV2Fixture() {
  const base = await desktopFixture(),
    rootStat = await fs.lstat(base.root, { bigint: true })
  const install = Object.fromEntries(
    await Promise.all(
      Object.entries(base.spec.install).map(async ([key, file]) => [
        key,
        (await readDesktopFileV2(file.path)).identity,
      ]),
    ),
  )
  const disks = Object.fromEntries(
    await Promise.all(
      Object.entries(base.spec.disks).map(async ([key, disk]) => {
        const s = await fs.lstat(disk.path, { bigint: true })
        return [key, { path: disk.path, fileID: desktopIdentityV2(s), volumeID: String(s.dev) }]
      }),
    ),
  )
  const spec = decodeDesktopSpecV2({
    ...base.spec,
    schemaVersion: 2,
    install,
    disks,
    wslConfig: (await readDesktopFileV2(base.spec.wslConfig.path)).identity,
  })
  const calls = { start: 0, stop: 0, execute: 0, confirm: 0, prepare: 0, settingsUse: 0 }
  let observation: Record<string, unknown> = {
    phase: "idle",
    sid: "S-1-5-21-fixture",
    runningDocker: false,
    runningWsl: false,
  }
  let owned: DesktopProcessIdentity | undefined
  let onStart: () => Promise<void> = async () => {}
  let onStop: () => Promise<void> = async () => {}
  const platform: DesktopPlatform = {
    async audit(actual) {
      if (canonicalJson(actual) !== canonicalJson(spec)) throw Error("FIXTURE_SPEC")
      return {
        assurance: "fixture",
        specSha256: sha256Text(canonicalJson(spec)),
        missing: [],
        checks: (
          ["path_routing", "backend_environment", "registration_reuse", "stop_owned", "cli_default"] as const
        ).map((id) => ({
          id,
          source: spec.install.asar.path,
          sourceSha256: spec.install.asar.sha256,
          location: "synthetic behavior only",
          conclusion: "proved",
        })),
      }
    },
    async observe() {
      return structuredClone(observation)
    },
    async start(plan) {
      if (plan.schemaVersion !== 2 || canonicalJson(plan.spec) !== canonicalJson(spec)) throw Error("FIXTURE_PLAN")
      calls.start++
      owned = {
        pid: 1234,
        createdAt: Date.now(),
        ownerSID: "S-1-5-21-fixture",
        image: spec.install.backend,
        parentPID: 1000,
      }
      observation = {
        phase: "running",
        sid: owned.ownerSID,
        runningDocker: true,
        runningWsl: true,
        process: owned,
        pipe: { endpoint: plan.endpoint, owner: owned },
        profileEndpoint: plan.endpoint,
        productionDefaultEndpoint: plan.endpoint,
      }
      await onStart()
      return owned
    },
    async stop(actual) {
      if (!owned || canonicalJson(actual) !== canonicalJson(owned)) throw Error("FIXTURE_PROCESS")
      calls.stop++
      await onStop()
      observation = { phase: "stopped", sid: owned.ownerSID, runningDocker: false, runningWsl: false }
      return "stopped"
    },
  }
  const expected = {
    SettingsVersion: 44,
    CustomWslDistroDir: spec.dataRoot,
    WslEngineEnabled: true,
    UseWindowsContainers: false,
    AutoStart: false,
  } as const
  const payload = (target: DesktopSettingsTarget, epoch = 1) =>
    target === "settings-store"
      ? { ...expected, FixtureEpoch: epoch }
      : { FixtureEpoch: epoch, features: { fixture: false } }
  return {
    root: base.root,
    spec,
    platform,
    calls,
    expected,
    payload,
    async seedEmptyWorkload() {
      await fs.writeFile(
        spec.disks.data.path,
        canonicalJson({
          schemaVersion: 1,
          fixtureKind: "task24-workload-state",
          scopes: { containers: [], swarm: [], kubernetes: [] },
        }),
      )
    },
    setObservation(value: Record<string, unknown>) {
      observation = value
    },
    readObservation() {
      return structuredClone(observation)
    },
    onStart(fn: () => Promise<void>) {
      onStart = fn
    },
    onStop(fn: () => Promise<void>) {
      onStop = fn
    },
    async emitRuntime(epoch = 1) {
      for (const [target, file] of Object.entries(desktopRuntimeTargetsV2(spec.profileRoot))) {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, JSON.stringify(payload(target as DesktopSettingsTarget, epoch), null, 2) + "\n")
      }
    },
    async close() {
      if ((await fs.lstat(base.root, { bigint: true })).ino !== rootStat.ino) throw Error("V2_CLEANUP_IDENTITY")
      await base.close()
    },
  }
}
