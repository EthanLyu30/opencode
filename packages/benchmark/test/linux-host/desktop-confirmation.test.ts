import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import { profileFixture } from "./desktop-profile.test"
import { desktopFeature } from "./desktop-native-fixture"
import {
  confirmDesktopApproval,
  prepareDesktopProfile,
  requireDesktopApproval,
} from "../../src/sandbox/desktop/profile"
import { makeWindowsDesktopPlatform } from "../../src/sandbox/desktop/platform"

test("fixed system console image has a read-only identity lease without widening D writes", async () => {
  const api = await desktopFeature<typeof import("../../src/sandbox/desktop/publication")>("publication")
  expect(api.desktopConsoleImageIdentity).toBeFunction()
  if (!api.desktopConsoleImageIdentity || !api.withDesktopReadLease) return
  const image = await api.desktopConsoleImageIdentity()
  expect(image.path).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  let held = false
  await api.withDesktopReadLease(
    image,
    async (signal) => {
      expect(signal.aborted).toBe(false)
      held = true
    },
    "console",
  )
  expect(held).toBe(true)
  await expect(
    api.withDesktopReadLease({ ...image, path: "C:\\Windows\\System32\\cmd.exe" }, async () => {}, "console"),
  ).rejects.toThrow()
})

test("native provenance cannot be manufactured by fixture callbacks", async () => {
  const api = await desktopFeature<typeof import("../../src/sandbox/desktop/approval")>("approval")
  expect(api.isDesktopApprovalSourceAllowed).toBeFunction()
  if (!api.isDesktopApprovalSourceAllowed || !api.confirmDesktopInteractive) return
  expect(api.isDesktopApprovalSourceAllowed("fixture-callback", "native")).toBe(false)
  expect(api.isDesktopApprovalSourceAllowed(undefined, "native")).toBe(false)
  expect(api.isDesktopApprovalSourceAllowed("native-console", "native")).toBe(true)
  const f = await profileFixture()
  try {
    const approval = await confirmDesktopApproval(f.raw, async () => true)
    requireDesktopApproval(approval, f.plan, "prepare-profile", f.raw.sid)
    expect(() => requireDesktopApproval({ ...approval }, f.plan, "prepare-profile", f.raw.sid)).toThrow()
    await expect(
      api.confirmDesktopInteractive({ raw: f.raw, plan: f.plan, signal: new AbortController().signal }),
    ).rejects.toThrow()
    const native = makeWindowsDesktopPlatform()
    const result = await prepareDesktopProfile({ spec: f.spec, plan: f.plan, approval, platform: native })
    expect(result.kind).toBe("blocked")
    expect(await fs.exists(f.spec.profileRoot)).toBe(false)
    expect(f.calls.start).toBe(0)
  } finally {
    await f.close()
  }
})

test("redirected or truncated console confirmation cannot issue authority", async () => {
  const api = await desktopFeature<typeof import("../../src/sandbox/desktop/console")>("console")
  expect(api.validateDesktopConsolePacket).toBeFunction()
  if (!api.validateDesktopConsolePacket || !api.readDesktopConsoleDecision) return
  const { sha256Text } = await import("../../src/hash")
  const panel = "Trusted confirmation panel"
  const packet = {
    panel,
    panelSha256: sha256Text(panel),
    requestSha256: sha256Text("request"),
    controllerID: crypto.randomUUID(),
    launchID: "fixture-desktop",
    phase: "prepare-profile" as const,
    expiresAt: Date.now() + 2000,
  }
  expect(() => api.validateDesktopConsolePacket!({ ...packet, panel: panel + "\x1b[2J" })).toThrow()
  expect(() => api.validateDesktopConsolePacket!({ ...packet, panel: "x".repeat(12289) })).toThrow()
  expect(() => api.validateDesktopConsolePacket!({ ...packet, panelSha256: sha256Text("truncated") })).toThrow()
  // This runner has redirected streams; never attach a console or auto-enter a native challenge.
  expect(await api.readDesktopConsoleDecision(packet, new AbortController().signal)).toBe("unavailable")
  const { runDesktopProbe } = await import("../../src/sandbox/desktop/native-process")
  // Exercise the real fixed helper with inherited pipe handles, including compilation; no console/challenge entered.
  const script = `$env:OC_TASK24_CONSOLE_PACKET='${JSON.stringify(packet)}';\n` + api.desktopConsoleProgram
  const child = await runDesktopProbe({
    exe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    argv: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    timeoutMs: 10000,
    stdoutLimit: 8192,
    stderrLimit: 8192,
  })
  expect(Buffer.from(child.stderr).toString("utf8")).toBe("")
  expect(child.exitCode).toBe(3)
})

test("single-use challenge rejects generic or stale input", async () => {
  const api = await desktopFeature<typeof import("../../src/sandbox/desktop/console")>("console")
  expect(api.desktopConsolePhrase).toBeFunction()
  if (!api.desktopConsolePhrase || !api.desktopConsoleInputMatches) return
  const challenge = "ab".repeat(12)
  const phrase = api.desktopConsolePhrase("prepare-profile", "fixture-desktop", challenge)
  expect(phrase).toBe(`PREPARE fixture-desktop ${challenge}`)
  expect(api.desktopConsolePhrase("start-readonly", "fixture-desktop", challenge)).toBe(
    `START fixture-desktop ${challenge}`,
  )
  for (const input of [
    "",
    "yes",
    phrase + "\n",
    phrase + "\nextra",
    phrase + " ",
    phrase.replace("ab", "cd"),
    "\x03",
  ]) {
    expect(api.desktopConsoleInputMatches(phrase, input, Date.now() + 1000)).toBe(false)
  }
  expect(api.desktopConsoleInputMatches(phrase, phrase, Date.now() + 1000)).toBe(true)
  expect(api.desktopConsoleInputMatches(phrase, phrase, Date.now() - 1)).toBe(false)
  const { runDesktopProbe } = await import("../../src/sandbox/desktop/native-process")
  const source =
    "$env:OC_TASK24_CONSOLE_PACKET='{}';\n" +
    api.desktopConsoleProgram!.split("exit [DesktopConsole]::Run")[0] +
    String.raw`
$expiry=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+5000
if(-not [DesktopConsole]::Matches('PREPARE fixture 123','PREPARE fixture 123',$expiry)){exit 10}
if([DesktopConsole]::Matches('PREPARE fixture 123','yes',$expiry)){exit 11}
if([DesktopConsole]::Matches('PREPARE fixture 123',"PREPARE fixture 123\nextra",$expiry)){exit 12}
if([DesktopConsole]::Matches('PREPARE fixture 123','PREPARE fixture 123',0)){exit 13}
exit 0
`
  const child = await runDesktopProbe({
    exe: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    argv: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(source, "utf16le").toString("base64"),
    ],
    timeoutMs: 10000,
    stdoutLimit: 8192,
    stderrLimit: 8192,
  })
  expect(Buffer.from(child.stderr).toString("utf8")).toBe("")
  expect(child.exitCode).toBe(0)
})

test("confirmation panel binds actual settings and all document digests", async () => {
  const api = await desktopFeature<typeof import("../../src/sandbox/desktop/approval")>("approval")
  expect(api.desktopConfirmationPanel).toBeFunction()
  if (!api.desktopConfirmationPanel || !api.checkDesktopApprovalRequest) return
  const f = await profileFixture()
  try {
    const raw = api.checkDesktopApprovalRequest(f.raw, f.plan, f.raw.sid)
    const panel = api.desktopConfirmationPanel(f.plan, raw)
    for (const value of [
      f.spec.sourceSha256,
      f.spec.specSha256,
      f.spec.planSha256,
      f.plan.planSha256,
      f.plan.compatibilitySha256,
      f.spec.profileRoot,
      f.raw.sid,
      "PINATA_SINGLE_INSTANCE_LOCK=true",
      "12 directories",
      "4 files",
      "3145728",
    ])
      expect(panel).toContain(value)
    expect(() =>
      api.checkDesktopApprovalRequest!({ ...f.raw, expectedProfileRoot: "D:\\wrong" }, f.plan, f.raw.sid),
    ).toThrow()
    expect(() => api.desktopConfirmationPanel!(f.plan, { ...raw, sid: "S-1\u202eevil" })).toThrow()
  } finally {
    await f.close()
  }
})
