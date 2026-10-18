import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../src/campaign/canonical"
import { fileIdentity } from "../../src/sandbox/storage"
import { auditDesktopCompatibility } from "../../src/sandbox/desktop/compatibility"
import { planDesktopProfile } from "../../src/sandbox/desktop/profile"
import { makeWindowsDesktopPlatform } from "../../src/sandbox/desktop/platform"
import { desktopFixture } from "./desktop-fixture"
import { nativeQueryFixture, desktopFeature } from "./desktop-native-fixture"
import { runDesktopProbe } from "../../src/sandbox/desktop/native-process"

const audit = await desktopFeature<typeof import("../../src/sandbox/desktop/native-audit")>("native-audit")
const publication = await desktopFeature<typeof import("../../src/sandbox/desktop/publication")>("publication")

test("known CLI resolution is evidence but not a launch permit", async () => {
  const f = await desktopFixture()
  try {
    const report = audit.describeDesktopNativeEvidence?.(f.spec, nativeQueryFixture(f.spec).snapshot, {
      production: "npipe:////./pipe/docker_engine",
      profile: "npipe:////./pipe/home-oc-task24-dd479dockerDesktopEngine",
    })
    expect(report?.checks.find((c) => c.id === "cli_default")?.conclusion).toBe("proved")
    expect(report?.missing).toContain("existing_workload_restart_unproved")
    expect(report?.missing).toContain("settings_mutation_unproved")
    expect(report?.checks.filter((c) => c.conclusion === "unproved").length).toBe(4)
    expect(audit.decodeDesktopCliEndpoint?.(Buffer.from('"npipe:////./pipe/docker_engine"\r\n'))).toBe(
      "npipe:////./pipe/docker_engine",
    )
    for (const value of [
      '"tcp://remote:2375"',
      "{}",
      '"npipe:////./pipe/unknown"',
      '"npipe:////./pipe/docker_engine"\n{}',
    ])
      expect(() => audit.decodeDesktopCliEndpoint?.(Buffer.from(value))).toThrow()
    const forged = { ...f.platform, audit: async () => report! }
    expect((await auditDesktopCompatibility(f.spec, forged)).kind).toBe("blocked")
    expect(f.calls.start).toBe(0)
  } finally {
    await f.close()
  }
})

test("stable evidence excludes ephemeral observations", async () => {
  const f = await desktopFixture()
  try {
    const snapshot = nativeQueryFixture(f.spec).snapshot
    const cli = {
      production: "npipe:////./pipe/docker_engine",
      profile: "npipe:////./pipe/home-oc-task24-dd479dockerDesktopEngine",
    }
    const first = audit.describeDesktopNativeEvidence?.(f.spec, snapshot, cli)
    expect(first?.checks).toHaveLength(5)
    const second = audit.describeDesktopNativeEvidence?.(
      f.spec,
      { ...snapshot, sampledAt: snapshot.sampledAt + 1 },
      cli,
    )
    expect(canonicalJson(first)).toBe(canonicalJson(second))
    const changed = audit.describeDesktopNativeEvidence?.(f.spec, snapshot, {
      ...cli,
      production: "npipe:////./pipe/dockerDesktopEngine",
    })
    expect(canonicalJson(changed)).not.toBe(canonicalJson(first))
    expect(planDesktopProfile(f.spec, JSON.parse(JSON.stringify(first))).kind).toBe("blocked")
  } finally {
    await f.close()
  }
})

test("cancelled audit never registers late evidence", async () => {
  const f = await desktopFixture()
  try {
    const controller = new AbortController()
    let release: () => void = () => {},
      entered: () => void = () => {}
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const platform = {
      ...f.platform,
      async audit() {
        entered()
        await barrier
        return f.platform.audit(f.spec)
      },
    }
    const result = auditDesktopCompatibility(f.spec, platform, controller.signal)
    await started
    controller.abort()
    release()
    expect(await result).toMatchObject({ kind: "blocked", code: "TASK24_DESKTOP_CANCELLED" })
    const native = makeWindowsDesktopPlatform()
    expect(
      await native.audit(f.spec, controller.signal).then(
        () => false,
        () => true,
      ),
    ).toBe(true)
    expect(audit.readDesktopNativeDiagnostics?.(native)).toBeUndefined()
    expect(f.calls.start).toBe(0)
  } finally {
    await f.close()
  }
})

test("partial static rules cannot prove complete routing", async () => {
  const f = await desktopFixture()
  try {
    const report = audit.describeDesktopNativeEvidence?.(f.spec, nativeQueryFixture(f.spec).snapshot, {
      production: "npipe:////./pipe/docker_engine",
      profile: "npipe:////./pipe/home-oc-task24-dd479dockerDesktopEngine",
    })
    expect(report?.missing).toEqual(
      expect.arrayContaining([
        "path_routing_unproved",
        "backend_environment_unproved",
        "registration_reuse_unproved",
        "stop_owned_unproved",
        "automatic_behavior_unproved",
      ]),
    )
    expect(
      await makeWindowsDesktopPlatform()
        .start({} as never)
        .then(
          () => false,
          () => true,
        ),
    ).toBe(true)
    expect(
      await makeWindowsDesktopPlatform()
        .stop({} as never)
        .then(
          () => false,
          () => true,
        ),
    ).toBe(true)
  } finally {
    await f.close()
  }
})

test("executable read lease pins bytes and parents without preparing a profile", async () => {
  const f = await desktopFixture()
  try {
    const exe = path.join(f.root, "install", "owned-probe.exe")
    await fs.copyFile("C:\\Windows\\System32\\cmd.exe", exe)
    const result = await publication.withDesktopReadLease?.(await fileIdentity(exe), async () => {
      expect(
        await fs.appendFile(exe, "must-not-change").then(
          () => false,
          () => true,
        ),
      ).toBe(true)
      expect(
        await fs.rename(path.dirname(exe), path.join(f.root, "moved-install")).then(
          () => false,
          () => true,
        ),
      ).toBe(true)
      return runDesktopProbe({
        exe,
        argv: ["/d", "/c", "echo owned-read-lease"],
        timeoutMs: 5000,
        stdoutLimit: 8192,
        stderrLimit: 8192,
      })
    })
    expect(result?.exitCode).toBe(0)
    expect(result && Buffer.from(result.stdout).toString("utf8").trim()).toBe("owned-read-lease")
    expect(await fs.readdir(path.dirname(exe))).not.toContain("state")
    expect(await fs.exists(f.spec.profileRoot)).toBe(false)
    await fs.appendFile(exe, "lease-released")
  } finally {
    await f.close()
  }
})
