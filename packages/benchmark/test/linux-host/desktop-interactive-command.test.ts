import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { profileFixture } from "./desktop-profile.test"
import { makeDesktopLaunchController } from "../../src/sandbox/desktop/command"
import { makeWindowsDesktopPlatform } from "../../src/sandbox/desktop/platform"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"

export async function interactiveFixture() {
  const f = await profileFixture()
  const control = path.join(f.root, "control", "desktop-launch", f.raw.launchID)
  await fs.mkdir(control, { recursive: true })
  const specFile = path.join(control, "spec.json"),
    approvalFile = path.join(control, "prepare-approval.json"),
    startFile = path.join(control, "start-approval.json")
  await fs.writeFile(specFile, canonicalJson(f.spec))
  await fs.writeFile(approvalFile, canonicalJson(f.raw))
  const argv = ["prepare-profile", "--spec", specFile, "--approval", approvalFile, "--interactive"]
  return { ...f, control, specFile, approvalFile, startFile, argv }
}

test("explicit interactive syntax cannot be replaced by yes or callbacks", async () => {
  const f = await interactiveFixture()
  let prompts = 0
  try {
    const run = makeDesktopLaunchController(f.platform, async () => {
      prompts++
      return true
    })
    expect((await run(f.argv.slice(0, -1))).output).toMatchObject({ code: "human_confirmation_required" })
    for (const args of [
      [...f.argv, "--interactive"],
      [...f.argv.slice(0, -1), "--interactive=true"],
      [...f.argv, "yes"],
      [...f.argv.slice(0, -1), "--yes"],
      ["audit", "--spec", f.specFile, "--interactive"],
    ])
      expect((await run(args)).exitCode).toBe(1)
    for (const file of [path.join(f.root, "approval.json"), f.startFile]) {
      await fs.writeFile(file, canonicalJson(f.raw))
      expect((await run(["prepare-profile", "--spec", f.specFile, "--approval", file, "--interactive"])).exitCode).toBe(
        2,
      )
    }
    const native = makeDesktopLaunchController(makeWindowsDesktopPlatform(), async () => {
      prompts++
      return true
    })
    expect((await native(f.argv)).exitCode).toBe(2)
    expect(prompts).toBe(0)
    expect(await fs.exists(f.spec.profileRoot)).toBe(false)
    expect(f.calls.start).toBe(0)
  } finally {
    await f.close()
  }
})

test("blocked or mismatched requests never prompt", async () => {
  for (const kind of ["sid", "plan", "phase", "expired", "target", "registration", "disk", "running", "blocked"]) {
    const f = await interactiveFixture()
    let prompts = 0
    try {
      const raw = { ...f.raw }
      if (kind === "sid") raw.sid = "S-1-5-21-other"
      if (kind === "plan") raw.planSha256 = sha256Text("wrong")
      if (kind === "expired") raw.expiresAt = Date.now() - 1
      if (kind === "target") raw.expectedProfileRoot = path.join(f.root, "elsewhere")
      if (kind === "registration") raw.registration = { ...raw.registration, fileID: "other" }
      if (kind === "disk") raw.disks = { ...raw.disks, data: { ...raw.disks.data, fileID: "other" } }
      const json = kind === "phase" ? { ...raw, phase: "start-readonly" } : raw
      await fs.writeFile(f.approvalFile, canonicalJson(json))
      if (kind === "running") f.setObservation({ ...f.getObservation(), runningWsl: true })
      if (kind === "blocked") f.checks[0]!.conclusion = "unproved"
      const result = await makeDesktopLaunchController(f.platform, async () => {
        prompts++
        return true
      })(f.argv)
      expect(result.exitCode).toBe(2)
      expect(prompts).toBe(0)
      expect(await fs.exists(f.spec.profileRoot)).toBe(false)
      expect(f.calls.start).toBe(0)
    } finally {
      await f.close()
    }
  }
})

test("same bytes replacement during prompt invalidates confirmation", async () => {
  for (const kind of ["spec", "approval", "install", "parent", "disk", "registration"]) {
    const f = await interactiveFixture()
    let prompts = 0
    try {
      const run = makeDesktopLaunchController(f.platform, async () => {
        prompts++
        if (kind === "registration") f.checks[2]!.conclusion = "unproved"
        else if (kind === "parent") {
          await fs.rename(f.control, f.control + "-original")
          await fs.mkdir(f.control)
          await fs.copyFile(path.join(f.control + "-original", "spec.json"), f.specFile)
          await fs.copyFile(path.join(f.control + "-original", "prepare-approval.json"), f.approvalFile)
        } else {
          const file =
            kind === "spec"
              ? f.specFile
              : kind === "approval"
                ? f.approvalFile
                : kind === "install"
                  ? f.spec.install.backend.path
                  : f.spec.disks.data.path
          const bytes = await fs.readFile(file)
          await fs.rename(file, file + ".original")
          await fs.writeFile(file, bytes)
        }
        return true
      })
      const result = await run(f.argv)
      expect(prompts).toBe(1)
      expect(result.exitCode).toBe(2)
      expect(await fs.exists(f.spec.profileRoot)).toBe(false)
      expect(await fs.exists(path.join(f.root, "reports"))).toBe(false)
      expect(f.calls.start).toBe(0)
    } finally {
      await f.close()
    }
  }
})

test("confirmation cancellation precedes durable side effects", async () => {
  const f = await interactiveFixture()
  try {
    const abort = new AbortController()
    const result = await makeDesktopLaunchController(f.platform, async () => {
      abort.abort()
      return true
    })(f.argv, abort.signal)
    expect(result.exitCode).toBe(2)
    expect(result.output).toMatchObject({ code: "TASK24_DESKTOP_CANCELLED" })
    expect(await fs.exists(f.spec.profileRoot)).toBe(false)
    expect(await fs.exists(path.join(f.root, "reports"))).toBe(false)
    expect(f.calls).toEqual({ start: 0, stop: 0, execute: 0 })
  } finally {
    await f.close()
  }
})

test("start preflight binds the actual manifest before prompting and after confirmation", async () => {
  const f = await interactiveFixture()
  try {
    expect((await makeDesktopLaunchController(f.platform, async () => true)(f.argv)).exitCode).toBe(0)
    const { expectedProfileRoot, ...common } = f.raw
    const manifest = path.join(f.spec.profileRoot, "manifest.json")
    const raw = {
      ...common,
      nonce: sha256Text(crypto.randomUUID()),
      phase: "start-readonly",
      operations: ["start-readonly", "stop-owned"],
      manifestSha256: sha256Text(await fs.readFile(manifest, "utf8")),
    }
    const argv = ["start-readonly", "--spec", f.specFile, "--approval", f.startFile, "--interactive"]
    let prompts = 0
    await fs.writeFile(f.startFile, canonicalJson({ ...raw, manifestSha256: sha256Text("wrong") }))
    expect(
      (
        await makeDesktopLaunchController(f.platform, async () => {
          prompts++
          return true
        })(argv)
      ).exitCode,
    ).toBe(2)
    expect(prompts).toBe(0)
    await fs.writeFile(f.startFile, canonicalJson(raw))
    const result = await makeDesktopLaunchController(f.platform, async () => {
      prompts++
      const bytes = await fs.readFile(manifest)
      await fs.rename(manifest, manifest + ".original")
      await fs.writeFile(manifest, bytes)
      return true
    })(argv)
    expect(result.exitCode).toBe(2)
    expect(prompts).toBe(1)
    expect(f.calls.start).toBe(0)
    expect(await fs.exists(path.join(f.spec.profileRoot, "state", "grants", raw.nonce + ".json"))).toBe(false)
  } finally {
    await f.close()
  }
})
