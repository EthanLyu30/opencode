import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"
import { decodeDesktopLaunchSpec } from "../../src/sandbox/desktop/compatibility"
import { desktopFixture } from "./desktop-fixture"

const v2 = await import("../../src/sandbox/desktop/v2-contracts").catch(() => undefined)
const binding = await import("../../src/sandbox/desktop/bindings")
const docs = {
  specs: [
    "2026-10-18-task24b-d-drive-docker-launch-design.md",
    "2026-10-18-task24b-dl6-native-cli-confirmation-design.md",
    "2026-10-19-task24b-settings-workload-boundary-design.md",
  ].map((p) => "docs/superpowers/specs/" + p),
  plans: [
    "2026-10-18-task24b-d-drive-docker-launch.md",
    "2026-10-18-task24b-dl6-native-cli-confirmation.md",
    "2026-10-19-task24b-settings-workload-boundary.md",
  ].map((p) => "docs/superpowers/plans/" + p),
}

test("v2 intent rejects wrong types, versions, hash, missing and excess fields", () => {
  expect(v2).toBeDefined()
  const expected = {
    dataRoot: "D:\\Applications\\DockerWSL",
    policyID: "fixture-settings-v2",
    policySha256: sha256Text("synthetic policy"),
  }
  const body = {
    schemaVersion: 2,
    policyID: expected.policyID,
    policySha256: expected.policySha256,
    expected: {
      SettingsVersion: 44,
      CustomWslDistroDir: expected.dataRoot,
      WslEngineEnabled: true,
      UseWindowsContainers: false,
      AutoStart: false,
    },
  }
  expect(v2!.decodeDesktopIntentV2(canonicalJson(body), expected).expected.AutoStart).toBe(false)
  for (const raw of [
    { ...body, schemaVersion: 1 },
    { ...body, schemaVersion: 3 },
    { ...body, policySha256: "0".repeat(64) },
    { ...body, extra: true },
    { ...body, expected: { ...body.expected, AutoStart: "false" } },
    { ...body, expected: { ...body.expected, CustomWslDistroDir: "C:\\bad" } },
    { ...body, expected: { ...body.expected, AutoStart: undefined } },
  ])
    expect(() => v2!.decodeDesktopIntentV2(canonicalJson(raw), expected)).toThrow()
})

test("v2 spec is explicitly decoded and cannot enter v1", async () => {
  expect(v2).toBeDefined()
  const f = await desktopFixture()
  try {
    const raw = { ...f.spec, schemaVersion: 2 }
    expect(v2!.decodeDesktopSpecV2(raw).schemaVersion).toBe(2)
    expect(() => decodeDesktopLaunchSpec(raw)).toThrow()
    for (const bad of [
      { ...raw, schemaVersion: 3 },
      { ...raw, settingsVersion: 45 },
      { ...raw, version: "other" },
      { ...raw, force: true },
    ])
      expect(() => v2!.decodeDesktopSpecV2(bad)).toThrow()
  } finally {
    await f.close()
  }
})

test("v2 document digest enforces exact three-member sets rather than just count", () => {
  expect(binding.desktopDocumentDigestV2).toBeFunction()
  const entries = docs.specs.map((path, index) => ({ path, sha256: sha256Text("spec" + index) }))
  const expected = sha256Text(canonicalJson([...entries].sort((a, b) => (a.path < b.path ? -1 : 1))))
  expect(binding.desktopDocumentDigestV2("specs", entries)).toBe(expected)
  expect(binding.desktopDocumentDigestV2("specs", entries.toReversed())).toBe(expected)
  for (const bad of [
    entries.slice(0, 2),
    [entries[0]!, entries[1]!, entries[1]!],
    [...entries.slice(0, 2), { ...entries[2]!, path: "docs/other.md" }],
    [...entries.slice(0, 2), { ...entries[2]!, sha256: "placeholder" }],
    [...entries.slice(0, 2), { ...entries[2]!, sha256: "0".repeat(64) }],
  ])
    expect(() => binding.desktopDocumentDigestV2("specs", bad)).toThrow()
})

test("v2 bindings read six actual document bytes and reject missing, dirty, linked inputs", async () => {
  expect(binding.readDesktopBindingsV2).toBeFunction()
  const parent = process.env.TMPDIR!,
    root = await fs.mkdtemp(path.join(parent, "v2-git-"))
  const id = await fs.lstat(root, { bigint: true })
  const run = async (args: string[]) => {
    const child = Bun.spawn(
      [
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.autocrlf=false",
        "-C",
        root,
        ...args,
      ],
      {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" },
        windowsHide: true,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code) throw Error(err)
    return out.trim()
  }
  const commit = async () => {
    await run(["add", "."])
    await run([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=NUL",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ])
  }
  try {
    await run(["init", "--quiet"])
    for (const name of [...docs.specs, ...docs.plans]) {
      await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
      await fs.writeFile(path.join(root, name), "synthetic:" + name)
    }
    await commit()
    const result = await binding.readDesktopBindingsV2(root)
    expect(result.sourceSha256).toBe(sha256Text("git-tree:" + (await run(["rev-parse", "HEAD^{tree}"]))))
    const entries = docs.plans.map((path) => ({ path, sha256: sha256Text("synthetic:" + path) }))
    expect(result.planSha256).toBe(sha256Text(canonicalJson(entries.sort((a, b) => (a.path < b.path ? -1 : 1)))))
    await fs.appendFile(path.join(root, docs.plans[2]!), "drift")
    await expect(binding.readDesktopBindingsV2(root)).rejects.toThrow()
    await commit()
    expect((await binding.readDesktopBindingsV2(root)).planSha256).not.toBe(result.planSha256)
    await fs.unlink(path.join(root, docs.plans[2]!))
    await commit()
    await expect(binding.readDesktopBindingsV2(root)).rejects.toThrow()
    await fs.writeFile(path.join(root, docs.plans[2]!), "restored")
    await commit()
    await fs.link(path.join(root, docs.specs[0]!), path.join(root, "linked"))
    await commit()
    await expect(binding.readDesktopBindingsV2(root)).rejects.toThrow()
  } finally {
    if (!root.startsWith(parent + path.sep) || (await fs.lstat(root, { bigint: true })).ino !== id.ino)
      throw Error("CLEANUP_SCOPE")
    await fs.rm(root, { recursive: true })
  }
})
