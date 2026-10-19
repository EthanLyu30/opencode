import fs from "node:fs/promises"
import { profileFixtureV2 } from "./desktop-v2-profile-fixture"
import { confirmDesktopApprovalV2 } from "../../src/sandbox/desktop/approval-v2"
import { startDesktopReadonly } from "../../src/sandbox/desktop/launch"
import { withDesktopRuntimeSettings } from "../../src/sandbox/desktop/settings-runtime"

export async function runtimeFixtureV2(onStart?: (f: Awaited<ReturnType<typeof profileFixtureV2>>) => Promise<void>) {
  const f = await profileFixtureV2()
  const profile = await f.prepareV2()
  f.onStart(() => (onStart ? onStart(f) : f.emitRuntime()))
  const approval = await confirmDesktopApprovalV2(f.startRaw(profile.manifestSha256), async () => true)
  const result = await startDesktopReadonly({
    spec: f.spec,
    profile,
    approval,
    platform: f.platform,
    signal: AbortSignal.timeout(120000),
  })
  if (result.kind !== "ready") {
    await f.close()
    throw Error(JSON.stringify(result))
  }
  const session = result.value
  return {
    ...f,
    profile,
    approval,
    session,
    async storageSnapshot() {
      return withDesktopRuntimeSettings(session, async (seal) => ({
        schemaVersion: 2 as const,
        intentSha256: seal.intentSha256,
        policySha256: seal.policySha256,
        runtimeSealSha256: seal.sha256,
        sequence: seal.sequence,
        manifestSha256: profile.manifestSha256,
        registration: f.spec.registration,
        runtimeDisk: f.spec.disks.runtime,
        dataDisk: f.spec.disks.data,
        wslConfig: { ...f.spec.wslConfig, modifiedAt: (await fs.stat(f.spec.wslConfig.path)).mtimeMs },
        swapsText: "Filename Type Size Used Priority\n",
        active: true,
        binding: {
          version: f.spec.version,
          distributionName: "docker-desktop",
          basePath: f.spec.registration.basePath,
          windowsProfile: f.spec.windowsProfile,
          settingsPath: f.plan.runtimeTargets["settings-store"],
          settings: f.payload("settings-store"),
          settingsModifiedAt: (await fs.stat(f.plan.runtimeTargets["settings-store"])).mtimeMs,
          backendStartedAt: (f.readObservation().process as { createdAt: number }).createdAt,
          imagePath: f.spec.disks.data.path,
          attached: true,
          windowsFilesystemUUID: "01234567-89ab-cdef-0123-456789abcdef",
          guestFilesystemUUID: "01234567-89ab-cdef-0123-456789abcdef",
          guestEngineID: "fixture-engine",
          daemonServerID: "fixture-engine",
        },
      }))
    },
  }
}
