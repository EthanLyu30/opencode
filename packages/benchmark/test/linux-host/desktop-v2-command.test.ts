import fs from "node:fs/promises"
import path from "node:path"
import { expect, test } from "bun:test"
import { profileFixtureV2 } from "./desktop-v2-profile-fixture"
import { makeDesktopLaunchController } from "../../src/sandbox/desktop/command"
import { makeWindowsDesktopPlatform } from "../../src/sandbox/desktop/platform"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Bytes } from "../../src/hash"

async function controls(f: Awaited<ReturnType<typeof profileFixtureV2>>) {
  const root = path.join(f.root, "control", "desktop-launch", f.raw.launchID)
  await fs.mkdir(root, { recursive: true })
  const spec = path.join(root, "spec.json"),
    approval = path.join(root, "prepare-approval.json"),
    start = path.join(root, "start-approval.json")
  await fs.writeFile(spec, canonicalJson(f.spec))
  await fs.writeFile(approval, canonicalJson(f.raw))
  await fs.writeFile(start, "{}")
  return {
    spec,
    approval,
    start,
    argv: (mode: string) => [
      mode,
      "--spec",
      spec,
      "--approval",
      mode === "prepare-profile" ? approval : start,
      "--interactive",
    ],
  }
}
async function tree(root: string): Promise<unknown> {
  const entries = await fs.readdir(root, { withFileTypes: true })
  return Promise.all(
    entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (e) => ({
        name: e.name,
        value: e.isDirectory()
          ? await tree(path.join(root, e.name))
          : sha256Bytes(await fs.readFile(path.join(root, e.name))),
      })),
  )
}
test("unproved workload blocks both v2 mutations before confirmation or writes", async () => {
  const f = await profileFixtureV2()
  try {
    const c = await controls(f)
    await fs.writeFile(
      f.spec.disks.data.path,
      canonicalJson({
        schemaVersion: 1,
        fixtureKind: "task24-workload-state",
        scopes: { containers: [{ restart: "always" }], swarm: [], kubernetes: [] },
      }),
    )
    const controller = makeDesktopLaunchController(f.platform, async () => {
      f.calls.confirm++
      return true
    })
    for (const mode of ["prepare-profile", "start-readonly"]) {
      const before = await tree(f.root),
        result = await controller(c.argv(mode))
      expect(result.exitCode).toBe(2)
      expect(result.output).toMatchObject({ missing: expect.arrayContaining(["existing_workload_restart_unproved"]) })
      expect(await tree(f.root)).toEqual(before)
    }
    expect([f.calls.confirm, f.calls.start, f.calls.stop]).toEqual([0, 0, 0])
    expect(await fs.exists(f.spec.profileRoot)).toBe(false)
  } finally {
    await f.close()
  }
}, 30000)

test("v2 CLI prepares, consumes once, always cleans up, and only rereads stale diagnostics", async () => {
  const f = await profileFixtureV2()
  try {
    const c = await controls(f),
      controller = makeDesktopLaunchController(f.platform, async () => true)
    const prepared = await controller(c.argv("prepare-profile"))
    expect(prepared.exitCode).toBe(0)
    const manifest = (prepared.output as { manifestSha256: string }).manifestSha256
    await fs.writeFile(c.start, canonicalJson(f.startRaw(manifest)))
    f.onStart(() => f.emitRuntime())
    const result = await controller(c.argv("start-readonly"))
    expect(result.exitCode).toBe(2)
    expect(result.output).toMatchObject({
      reportPublished: true,
      engine_verified: false,
      tool_capability_verified: false,
      corpus_engine_ready: false,
    })
    expect([f.calls.start, f.calls.stop]).toEqual([1, 1])
    const before = await tree(f.root)
    expect((await controller(["inspect", "--launch-id", f.raw.launchID])).output).toMatchObject({
      code: "stale_record_not_live",
      live: false,
    })
    expect((await controller(["stop-owned", "--launch-id", f.raw.launchID])).output).toMatchObject({
      code: "session_not_live",
    })
    expect((await controller(c.argv("start-readonly"))).exitCode).toBe(2)
    expect(await tree(f.root)).toEqual(before)
    expect(f.calls.start).toBe(1)
  } finally {
    await f.close()
  }
}, 30000)

test("v2 malformed inputs and native evidence gaps have no output-tree effects", async () => {
  const f = await profileFixtureV2()
  try {
    const c = await controls(f),
      controller = makeDesktopLaunchController(f.platform, async () => {
        f.calls.confirm++
        return true
      })
    for (const argv of [
      c.argv("prepare-profile").slice(0, -1),
      [...c.argv("prepare-profile"), "--force"],
      [...c.argv("prepare-profile"), "--spec", c.spec],
      [...c.argv("prepare-profile"), "--accept-risk"],
      [...c.argv("prepare-profile"), "--interactive"],
    ]) {
      const before = await tree(f.root)
      expect((await controller(argv)).exitCode).not.toBe(0)
      expect(await tree(f.root)).toEqual(before)
    }
    const before = await tree(f.root)
    const cancelled = new AbortController()
    cancelled.abort()
    expect((await controller(c.argv("prepare-profile"), cancelled.signal)).exitCode).toBe(2)
    const native = makeDesktopLaunchController(makeWindowsDesktopPlatform(), async () => {
      throw Error("must_not_confirm")
    })
    const denied = await native(["audit", "--spec", c.spec])
    expect(denied.output).toMatchObject({
      missing: expect.arrayContaining(["settings_mutation_unproved", "existing_workload_restart_unproved"]),
    })
    expect(await tree(f.root)).toEqual(before)
    for (const patch of [
      { schemaVersion: 1 },
      { manifestSha256: "0".repeat(64) },
      { planSha256: "0".repeat(64) },
      { policySha256: "0".repeat(64) },
    ]) {
      await fs.writeFile(c.approval, canonicalJson({ ...f.raw, ...patch }))
      const before = await tree(f.root)
      expect((await controller(c.argv("prepare-profile"))).exitCode).toBe(2)
      expect(await tree(f.root)).toEqual(before)
    }
    expect([f.calls.confirm, f.calls.start, f.calls.stop]).toEqual([0, 0, 0])
  } finally {
    await f.close()
  }
}, 30000)

test("v2 document or input identity drift never reaches preparation", async () => {
  const f = await profileFixtureV2()
  try {
    const c = await controls(f)
    await fs.writeFile(c.spec, canonicalJson({ ...f.spec, sourceSha256: "0".repeat(64) }))
    const controller = makeDesktopLaunchController(f.platform, async () => {
      f.calls.confirm++
      return true
    })
    let before = await tree(f.root)
    expect((await controller(c.argv("prepare-profile"))).exitCode).toBe(2)
    expect(f.calls.confirm).toBe(0)
    expect(await tree(f.root)).toEqual(before)
    await fs.writeFile(c.spec, canonicalJson(f.spec))
    const changed = makeDesktopLaunchController(f.platform, async () => {
      f.calls.confirm++
      const file = c.spec + ".replacement"
      await fs.writeFile(file, canonicalJson(f.spec))
      await fs.rename(file, c.spec)
      return true
    })
    const result = await changed(c.argv("prepare-profile"))
    expect(result.output).toMatchObject({ code: "TASK24_DESKTOP_INPUT_DRIFT" })
    expect(f.calls.confirm).toBe(1)
    expect(await fs.exists(f.spec.profileRoot)).toBe(false)
    expect([f.calls.start, f.calls.stop]).toEqual([0, 0])
  } finally {
    await f.close()
  }
}, 30000)
