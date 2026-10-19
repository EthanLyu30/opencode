import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import { runtimeFixtureV2 } from "./desktop-v2-runtime-fixture"
import { profileFixtureV2 } from "./desktop-v2-profile-fixture"
import { confirmDesktopApprovalV2 } from "../../src/sandbox/desktop/approval-v2"
import { consumeDesktopGrantV2 } from "../../src/sandbox/desktop/profile-v2"
import { inspectDesktopLaunch, decodeDesktopStorageObservationV2 } from "../../src/sandbox/desktop/inspection"
import { stopDesktopLaunch, readDesktopAttemptDiagnostics } from "../../src/sandbox/desktop/launch"
import { withDesktopRuntimeSettings } from "../../src/sandbox/desktop/settings-runtime"
import {
  beginDesktopSettingsRuntime,
  finishDesktopSettingsRuntime,
  type DesktopSettingsBootstrap,
} from "../../src/sandbox/desktop/settings-runtime"
import { publishDesktopLaunchRecordV2, readDesktopLaunchRecord } from "../../src/sandbox/desktop/inventory"
import { auditDesktopCompatibility } from "../../src/sandbox/desktop/compatibility"
import { makeWindowsDesktopPlatform } from "../../src/sandbox/desktop/platform"
import { startDesktopReadonly, readDesktopAttemptCleanup } from "../../src/sandbox/desktop/launch"

test("real fixture writer exit leaves only stale diagnostics, never a native engine capability", async () => {
  let writerExit: number | undefined
  const f = await runtimeFixtureV2(async (fixture) => {
    const inputs = Object.entries(fixture.plan.runtimeTargets).map(([target, file]) => ({
      file,
      body: fixture.payload(target as "daemon"),
    }))
    if (inputs.some((i) => !i.file.startsWith(fixture.root + path.sep))) throw Error("WRITER_SCOPE")
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `
      const fs = require('node:fs/promises');
      for (const {file,body} of JSON.parse(process.argv.at(-1))) {
        const temp=file+'.fixture-01.tmp';await fs.writeFile(temp,JSON.stringify(body,null,2)+'\\n');await fs.rename(temp,file);
      }
      process.stdout.write('fixture-writer-exit');process.exit(23);
    `,
        JSON.stringify(inputs),
      ],
      { cwd: process.env.TMPDIR, env: process.env, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    writerExit = code
    expect(code).toBe(23)
    expect(out).toBe("fixture-writer-exit")
    expect(err).toBe("")
  })
  try {
    expect(writerExit).toBe(23)
    let reopened: DesktopSettingsBootstrap | undefined
    try {
      await expect(
        beginDesktopSettingsRuntime({ profile: f.profile, approval: f.approval }).then((value) => {
          reopened = value
          return value
        }),
      ).rejects.toThrow()
    } finally {
      if (reopened) await finishDesktopSettingsRuntime(reopened)
    }
    const raw = await f.storageSnapshot()
    f.setObservation({ ...f.readObservation(), storage: raw })
    const inventory = await inspectDesktopLaunch(f.session)
    expect(inventory.status).toBe("inventory_observed_not_accepted")
    expect([inventory.engine_verified, inventory.tool_capability_verified, inventory.corpus_engine_ready]).toEqual([
      false,
      false,
      false,
    ])
    let serialized: unknown
    await withDesktopRuntimeSettings(f.session, async (seal) => {
      serialized = JSON.parse(JSON.stringify(seal))
    })
    expect(() =>
      decodeDesktopStorageObservationV2(raw, {
        spec: f.spec,
        profile: f.profile,
        session: f.session,
        seal: serialized as any,
      }),
    ).toThrow()
    f.onStop(async () => {
      const file = f.plan.runtimeTargets["windows-daemon"],
        temp = file + ".fixture-01.tmp"
      await fs.writeFile(temp, JSON.stringify(f.payload("windows-daemon")) + "\n")
      await fs.rename(temp, file)
    })
    const cleanup = await stopDesktopLaunch(f.session)
    expect(cleanup).toEqual({ kind: "ready", value: "stopped" })
    expect(readDesktopAttemptDiagnostics(cleanup)?.failureCode).toBeNull()
    await publishDesktopLaunchRecordV2({
      profile: f.profile,
      approval: f.approval,
      record: {
        schemaVersion: 2,
        launchID: f.session.launchID,
        specSha256: f.plan.specSha256,
        planSha256: f.plan.planSha256,
        compatibilitySha256: f.plan.compatibilitySha256,
        manifestSha256: f.profile.manifestSha256,
        intentSha256: f.plan.intentSha256,
        policySha256: f.plan.policySha256,
        status: "inventory_observed_not_accepted",
        code: "inventory_observed_not_accepted",
        missing: [],
        inventory,
        cleanup: "stopped",
        engine_verified: false,
        tool_capability_verified: false,
        corpus_engine_ready: false,
      },
    })
    expect((await readDesktopLaunchRecord(f.platform, f.session.launchID))?.live).toBe(false)
    expect((await auditDesktopCompatibility(f.spec, makeWindowsDesktopPlatform())).kind).toBe("blocked")
    await expect(withDesktopRuntimeSettings(f.session, async () => "bad")).rejects.toThrow()
    expect([f.calls.start, f.calls.stop, f.calls.execute]).toEqual([1, 1, 0])
  } finally {
    await stopDesktopLaunch(f.session)
    await f.close()
  }
}, 30000)

test("cancelled unresolved start retains the workload read lock until the actual start returns", async () => {
  const f = await profileFixtureV2()
  let release!: () => void, entered!: () => void
  const reached = new Promise<void>((yes) => {
      entered = yes
    }),
    gate = new Promise<void>((yes) => {
      release = yes
    })
  let operation: Promise<unknown> | undefined
  try {
    const profile = await f.prepareV2(),
      approval = await confirmDesktopApprovalV2(f.startRaw(profile.manifestSha256), async () => true)
    f.onStart(async () => {
      entered()
      await gate
    })
    const cancel = new AbortController()
    operation = startDesktopReadonly({ spec: f.spec, profile, approval, platform: f.platform, signal: cancel.signal })
    await reached
    cancel.abort()
    const result = (await operation) as object
    expect(readDesktopAttemptCleanup(result)).toBe("uncertain")
    await expect(fs.appendFile(f.spec.disks.data.path, " ")).rejects.toThrow()
    expect(f.calls.stop).toBe(0)
  } finally {
    release()
    await operation
    const deadline = Date.now() + 5000
    while (true) {
      try {
        const file = await fs.open(f.spec.disks.data.path, "r+")
        await file.close()
        break
      } catch (error) {
        if (Date.now() >= deadline) throw error
        await Bun.sleep(25)
      }
    }
    await f.close()
  }
}, 30000)

test("removing an owned durable journal never permits the consumed v2 nonce to be replayed", async () => {
  const f = await profileFixtureV2()
  try {
    const profile = await f.prepareV2(),
      raw = f.startRaw(profile.manifestSha256)
    const approval = await confirmDesktopApprovalV2(raw, async () => true)
    await consumeDesktopGrantV2(profile, approval)
    const journal = path.join(profile.plan.paths.root, "state", "grants", approval.nonce + ".json")
    expect(journal.startsWith(f.root + path.sep)).toBe(true)
    await fs.unlink(journal)
    await expect(consumeDesktopGrantV2(profile, approval)).rejects.toThrow()
    const copiedApproval = await confirmDesktopApprovalV2(raw, async () => true)
    await expect(consumeDesktopGrantV2(profile, copiedApproval)).rejects.toThrow()
    expect(await fs.exists(journal)).toBe(false)
    expect([f.calls.start, f.calls.stop]).toEqual([0, 0])
  } finally {
    await f.close()
  }
}, 30000)
