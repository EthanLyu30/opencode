import { expect, test } from "bun:test"
import path from "node:path"
import { desktopV2Fixture } from "./desktop-v2-fixture"
import { sha256Bytes } from "../../src/hash"
import { desktopRuntimeTargetsV2, type DesktopSettingsTarget } from "../../src/sandbox/desktop/v2-contracts"
import { makeWindowsDesktopPlatform } from "../../src/sandbox/desktop/platform"

const json = await import("../../src/sandbox/desktop/settings-json").catch(() => undefined)
const policy = await import("../../src/sandbox/desktop/settings-policy").catch(() => undefined)
const encode = (s: string) => new TextEncoder().encode(s)

test("bounded parser rejects escaped duplicates, aliases, trailing input and invalid encoding", () => {
  expect(json).toBeDefined()
  for (const text of [
    '{"AutoStart":false,"\\u0041utoStart":true}',
    '{"AutoStart":false,"autostart":true}',
    '{"nested":{"a":1,"A":2}}',
    "{}true",
    '{"x":01}',
    '{"x":1e999}',
  ])
    expect(() => json!.parseDesktopSettingsJson(encode(text), 16384)).toThrow()
  expect(() => json!.parseDesktopSettingsJson(new Uint8Array([0xff]), 16384)).toThrow()
  expect(() => json!.parseDesktopSettingsJson(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), 16384)).toThrow()
  expect(json!.parseDesktopSettingsJson(encode('{"text":"brace } and escaped \\""}'), 16384)).toEqual({
    text: 'brace } and escaped "',
  })
})

test("bounded parser accepts exactly 32 container levels and inclusive byte limit", () => {
  expect(json).toBeDefined()
  expect(() => json!.parseDesktopSettingsJson(encode("[".repeat(32) + "0" + "]".repeat(32)), 16384)).not.toThrow()
  expect(() => json!.parseDesktopSettingsJson(encode("[".repeat(33) + "0" + "]".repeat(33)), 16384)).toThrow()
  expect(() => json!.parseDesktopSettingsJson(encode("{}" + " ".repeat(16382)), 16384)).not.toThrow()
  expect(() => json!.parseDesktopSettingsJson(encode("{}" + " ".repeat(16383)), 16384)).toThrow()
})

test("compiled fixture policy checks all three complete files, not just five values", async () => {
  expect(policy).toBeDefined()
  const f = await desktopV2Fixture()
  try {
    const selected = await policy!.selectDesktopSettingsPolicy(f.spec, f.platform)
    expect(selected.kind).toBe("ready")
    if (selected.kind !== "ready") throw Error(selected.code)
    const p = selected.value
    const intent = { schemaVersion: 2 as const, policyID: p.id, policySha256: p.sha256, expected: f.expected }
    const targets = desktopRuntimeTargetsV2(f.spec.profileRoot)
    const file = (
      target: DesktopSettingsTarget,
      body: unknown,
      relative = path.relative(f.spec.profileRoot, targets[target]),
    ) => {
      const bytes = encode(typeof body === "string" ? body : JSON.stringify(body))
      return {
        target,
        relative,
        bytes,
        identity: { path: path.join(f.spec.profileRoot, relative), fileID: "v2:1:2:3", sha256: sha256Bytes(bytes) },
      }
    }
    const files = (["settings-store", "daemon", "windows-daemon"] as const).map((target) =>
      file(target, f.payload(target)),
    )
    const validate = (value = files, temporary: typeof files = []) =>
      policy!.validateDesktopSettingsSet({ policy: p, intent, files: value, temporary, phase: "starting" })
    const first = validate()
    const formatted = validate(files.map((v) => file(v.target, JSON.stringify(f.payload(v.target), null, 2) + "\n")))
    expect(first.files.map((v) => v.semanticSha256)).toEqual(formatted.files.map((v) => v.semanticSha256))
    expect(first.files[0]!.rawSha256).not.toBe(formatted.files[0]!.rawSha256)
    for (const bad of [
      { ...f.payload("settings-store"), AutoStart: true },
      { ...f.payload("settings-store"), WslEngineEnabled: "true" },
      { ...f.payload("settings-store"), CustomWslDistroDir: "C:\\bad" },
      { ...f.payload("settings-store"), unknown: false },
    ])
      expect(() => validate([file("settings-store", bad), ...files.slice(1)])).toThrow()
    expect(() =>
      validate([
        files[0]!,
        file("daemon", { FixtureEpoch: 1, features: { fixture: false, unknown: true } }),
        files[2]!,
      ]),
    ).toThrow()
    expect(() => validate([files[0]!, file("daemon", f.payload("daemon", 2)), files[2]!])).toThrow()
    expect(() => validate(files.slice(0, 2))).toThrow()
    expect(() =>
      validate([
        file("settings-store", JSON.stringify(f.payload("settings-store")) + " ".repeat(1048576)),
        ...files.slice(1),
      ]),
    ).toThrow()
    const temps = [1, 2, 3].map((n) =>
      file("daemon", f.payload("daemon"), path.relative(f.spec.profileRoot, targets.daemon) + `.fixture-0${n}.tmp`),
    )
    expect(() => validate(files, temps)).not.toThrow()
    expect(() =>
      validate(files, [
        ...temps,
        file(
          "settings-store",
          f.payload("settings-store"),
          path.relative(f.spec.profileRoot, targets["settings-store"]) + ".fixture-01.tmp",
        ),
      ]),
    ).toThrow()
    expect(() =>
      validate(files, [file("daemon", {}, path.relative(f.spec.profileRoot, targets.daemon) + ".tmp")]),
    ).toThrow()
    const native = await policy!.selectDesktopSettingsPolicy(f.spec, makeWindowsDesktopPlatform())
    expect(native).toMatchObject({ kind: "blocked", missing: expect.arrayContaining(["settings_mutation_unproved"]) })
    expect(() =>
      policy!.validateDesktopSettingsSet({ policy: { ...p }, intent, files, temporary: [], phase: "observed" }),
    ).toThrow()
    expect(() =>
      policy!.validateDesktopSettingsSet({
        policy: p,
        intent: { ...intent, expected: { ...intent.expected, AutoStart: true } as unknown as typeof intent.expected },
        files,
        temporary: [],
        phase: "observed",
      }),
    ).toThrow()
    const padded = (value: (typeof files)[number], size: number) =>
      file(value.target, new TextDecoder().decode(value.bytes) + " ".repeat(size - value.bytes.length), value.relative)
    const full = files.map((f) => padded(f, 1048576)),
      fullTemps = temps.map((f) => padded(f, 1048576))
    expect(() => validate(full, fullTemps)).not.toThrow()
    expect(() => validate([padded(files[0]!, 1048577), ...full.slice(1)], fullTemps)).toThrow()
    expect(() => validate(full, [padded(temps[0]!, 1048577), ...fullTemps.slice(1)])).toThrow()
    const changed = await policy!.selectDesktopSettingsPolicy(
      { ...f.spec, disks: { ...f.spec.disks, data: { ...f.spec.disks.data, fileID: "v2:1:2:3" } } },
      f.platform,
    )
    expect(changed.kind).toBe("blocked")
  } finally {
    await f.close()
  }
})
