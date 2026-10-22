import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { profileFixture } from "./desktop-profile.test"
import { requireDesktopPlan, prepareDesktopProfile, confirmDesktopApproval } from "../../src/sandbox/desktop/profile"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"
import { desktopDocumentDigest, readDesktopBindings } from "../../src/sandbox/desktop/bindings"

test("document bindings include both approved documents and distinguish runtime hashes", () => {
  const entries = [
    { path: "docs/b.md", sha256: "b".repeat(64) },
    { path: "docs/a.md", sha256: "a".repeat(64) },
  ]
  const expected = sha256Text(
    '[{"path":"docs/a.md","sha256":"' + "a".repeat(64) + '"},{"path":"docs/b.md","sha256":"' + "b".repeat(64) + '"}]',
  )
  expect(desktopDocumentDigest(entries)).toBe(expected)
  expect(desktopDocumentDigest([...entries].reverse())).toBe(expected)
  for (const invalid of [
    [entries[0]!, entries[0]!],
    [{ path: "D:/docs/a.md", sha256: "a".repeat(64) }],
    [{ path: "../a.md", sha256: "a".repeat(64) }],
    [{ path: "docs/a.md", sha256: "INVALID" }],
  ])
    expect(() => desktopDocumentDigest(invalid)).toThrow()
})

test("planning preserves authority and explicitly enables singleton lock", async () => {
  const f = await profileFixture()
  try {
    expect(f.plan.env.PINATA_SINGLE_INSTANCE_LOCK).toBe("true")
    expect(requireDesktopPlan(f.plan, f.platform)).toBe(f.platform)
    expect(() => requireDesktopPlan({ ...f.plan }, f.platform)).toThrow("PLAN_AUTHORITY")
    expect(f.plan.settings).toEqual({
      SettingsVersion: 44,
      CustomWslDistroDir: f.spec.dataRoot,
      WslEngineEnabled: true,
      UseWindowsContainers: false,
      AutoStart: false,
    })
    const { PINATA_SINGLE_INSTANCE_LOCK, ...oldEnv } = f.plan.env
    const { planSha256, ...body } = f.plan
    const oldHash = sha256Text(canonicalJson({ ...body, env: oldEnv }))
    const oldApproval = await confirmDesktopApproval({ ...f.raw, planSha256: oldHash }, async () => true)
    expect(
      (await prepareDesktopProfile({ spec: f.spec, plan: f.plan, approval: oldApproval, platform: f.platform })).kind,
    ).toBe("blocked")
    expect(await fs.exists(f.spec.profileRoot)).toBe(false)
  } finally {
    await f.close()
  }
})

test(
  "document reads bind clean tree and reject linked or dirty documents",
  async () => {
    const f = await profileFixture()
    try {
      const root = path.join(f.root, "source")
      await fs.mkdir(root)
      const run = async (args: string[]) => {
        const child = Bun.spawn(
          ["C:\\Program Files\\Git\\cmd\\git.exe", "-c", "core.fsmonitor=false", "-C", root, ...args],
          {
            env: {
              SystemRoot: "C:\\Windows",
              PATH: process.env.PATH!,
              HOME: process.env.HOME!,
              TEMP: process.env.TEMP!,
              TMP: process.env.TMP!,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "NUL",
            },
            windowsHide: true,
            stdout: "pipe",
            stderr: "pipe",
          },
        )
        const output = await new Response(child.stdout).text()
        const error = await new Response(child.stderr).text()
        if (await child.exited) throw Error(error)
        return output.trim()
      }
      await run(["init", "--quiet"])
      const documents = [
        "docs/superpowers/specs/2026-10-18-task24b-d-drive-docker-launch-design.md",
        "docs/superpowers/specs/2026-10-18-task24b-dl6-native-cli-confirmation-design.md",
        "docs/superpowers/plans/2026-10-18-task24b-d-drive-docker-launch.md",
        "docs/superpowers/plans/2026-10-18-task24b-dl6-native-cli-confirmation.md",
      ]
      for (const file of documents) {
        await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
        await fs.writeFile(path.join(root, file), "synthetic " + file)
      }
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
      const first = await readDesktopBindings(root)
      expect(first).toMatchObject({ sourceSha256: sha256Text("git-tree:" + (await run(["rev-parse", "HEAD^{tree}"]))) })
      expect(first?.specSha256).not.toBe(sha256Text("synthetic " + documents[0]))
      for (const file of documents) {
        await fs.appendFile(path.join(root, file), " revised")
        const failure = await readDesktopBindings(root).then(
          () => false,
          () => true,
        )
        expect(failure).toBe(true)
        await run(["add", file])
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
          "revision",
        ])
        const next = await readDesktopBindings(root)
        expect(next?.[file.includes("/specs/") ? "specSha256" : "planSha256"]).not.toBe(
          first?.[file.includes("/specs/") ? "specSha256" : "planSha256"],
        )
      }
      const target = path.join(root, documents[0]!)
      const linked = path.join(f.root, "linked-input.md")
      await fs.rename(target, linked)
      await fs.link(linked, target)
      expect(
        await readDesktopBindings(root).then(
          () => false,
          () => true,
        ),
      ).toBe(true)
    } finally {
      await f.close()
    }
  },
  process.platform === "win32" ? 60000 : 30000,
)
