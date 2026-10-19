import fs from "node:fs/promises"
import path from "node:path"
import { desktopV2Fixture } from "./desktop-v2-fixture"
import { sha256Text } from "../../src/hash"

export async function profileFixtureV2() {
  const f = await desktopV2Fixture()
  await f.seedEmptyWorkload()
  const { auditDesktopCompatibility } = await import("../../src/sandbox/desktop/compatibility")
  const { planDesktopProfileV2 } = await import("../../src/sandbox/desktop/planning-v2")
  const { confirmDesktopApprovalV2 } = await import("../../src/sandbox/desktop/approval-v2")
  const { prepareDesktopProfileV2 } = await import("../../src/sandbox/desktop/profile-v2")
  const report = await auditDesktopCompatibility(f.spec, f.platform)
  if (report.kind !== "ready") throw Error(report.code)
  const result = planDesktopProfileV2(f.spec, report.value)
  if (result.kind !== "ready") throw Error(result.code)
  const plan = result.value
  const common = () => ({
    schemaVersion: 2 as const,
    launchID: "fixture-v2-launch",
    nonce: sha256Text(crypto.randomUUID()),
    sid: "S-1-5-21-fixture",
    planSha256: plan.planSha256,
    compatibilitySha256: plan.compatibilitySha256,
    registration: f.spec.registration,
    disks: f.spec.disks,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60000,
  })
  const raw = {
    ...common(),
    phase: "prepare-profile" as const,
    operations: ["prepare-profile"] as const,
    expectedProfileRoot: plan.paths.root,
  }
  return {
    ...f,
    plan,
    raw,
    async holdTarget(target: "settings-store" | "daemon" | "windows-daemon") {
      const file = plan.runtimeTargets[target]
      if (!file.startsWith(f.root + path.sep)) throw Error("FIXTURE_HOLD_SCOPE")
      const script = String.raw`$ErrorActionPreference='Stop'
$file=[Console]::ReadLine()
$stream=[IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read)
try{[Console]::WriteLine('held');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null}finally{$stream.Dispose()}`
      const child = Bun.spawn(
        [
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { env: process.env, cwd: process.env.TEMP, windowsHide: true, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      )
      child.stdin.write(file + "\n")
      await child.stdin.flush()
      const reader = child.stdout.getReader(),
        first = await reader.read()
      if (first.done || Buffer.from(first.value).toString().trim() !== "held") {
        child.kill()
        await child.exited
        throw Error("FIXTURE_HOLD_FAILED")
      }
      return {
        async release() {
          child.stdin.end()
          await child.exited
          reader.releaseLock()
          await new Response(child.stderr).text()
        },
      }
    },
    startRaw(manifestSha256: string, validMs = 60000) {
      return {
        ...common(),
        expiresAt: Date.now() + validMs,
        phase: "start-readonly" as const,
        operations: ["start-readonly", "stop-owned"] as const,
        manifestSha256,
      }
    },
    async prepareV2() {
      const approval = await confirmDesktopApprovalV2(raw, async () => {
        f.calls.confirm++
        return true
      })
      const result = await prepareDesktopProfileV2({ spec: f.spec, plan, approval, platform: f.platform })
      if (result.kind !== "ready") throw Error(result.code)
      f.calls.prepare++
      return result.value
    },
    async profileOutputCounts() {
      const scan = async (root: string): Promise<{ directories: number; files: number }> => {
        const entries = await fs.readdir(root, { withFileTypes: true }),
          counts = { directories: 1, files: 0 }
        for (const e of entries) {
          if (e.isSymbolicLink()) throw Error("FIXTURE_LINK")
          if (e.isDirectory()) {
            const child = await scan(path.join(root, e.name))
            counts.directories += child.directories
            counts.files += child.files
          } else counts.files++
        }
        return counts
      }
      return scan(f.spec.profileRoot)
    },
  }
}
