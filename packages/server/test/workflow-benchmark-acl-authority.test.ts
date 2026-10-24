import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { BenchmarkAclAuthority } from "../src/workflow/benchmark-acl-authority"
import { HostRootPolicy } from "../src/workflow/host-root-policy"

const user = "S-1-5-21-100-200-300-1001"
const packageSid = "S-1-15-2-1-2-3-4-5-6-7"
const otherSid = "S-1-15-2-8-9-10-11-12-13-14"
const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex")

function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "acl-authority-"))
  const id = fs.lstatSync(root, { bigint: true })
  const roots = {
    deploymentRoot: path.join(root, "host"),
    dataRoot: path.join(root, "host", "data"),
    browserRuntimeRoot: path.join(root, "host", "runtime"),
    browserCacheRoot: path.join(root, "host", "cache"),
    previewCapabilityRoot: path.join(root, "host", "preview"),
    dockerConfigRoot: path.join(root, "host", "config"),
    dockerTempRoot: path.join(root, "host", "temp"),
  }
  for (const dir of Object.values(roots)) fs.mkdirSync(dir, { recursive: true })
  const executable = path.join(root, "own.exe")
  fs.writeFileSync(executable, "non-executable own fixture", { flag: "wx" })
  const binding = {
    campaignID: "own-campaign",
    runID: "own-run",
    bindingSha256: "a".repeat(64),
    expiresAt: Date.now() + 60000,
    evidenceMode: "production" as const,
  }
  const target = fs.lstatSync(roots.dataRoot, { bigint: true })
  const record = {
    schemaVersion: 1,
    nonce: "b".repeat(32),
    campaignID: binding.campaignID,
    runID: binding.runID,
    bindingSha256: binding.bindingSha256,
    expiresAt: binding.expiresAt,
    executableSha256: hash("non-executable own fixture"),
    grants: [
      { path: roots.dataRoot, fileID: `${target.dev}:${target.ino}:${target.birthtimeNs}`, mask: 0x1301bf, flags: 3 },
    ],
  }
  const text = JSON.stringify(record)
  const profile = "opencode.task24." + hash(text).slice(0, 48)
  const recordFile = path.join(root, "benchmark-acl-authority.json")
  fs.writeFileSync(recordFile, text, { flag: "wx" })
  const snapshot = (dir: string): HostRootPolicy.AclSnapshot => ({
    currentUserSid: user,
    currentIdentitySids: [user, "S-1-1-0"],
    ownerSid: user,
    protected: true,
    reparsePoint: false,
    descriptorSddl: `O:${user}G:${user}D:P(A;OICI;FA;;;${user})${dir === roots.dataRoot ? `(A;OICI;0x1301bf;;;${packageSid})` : ""}`,
    aces: [user, "S-1-5-18", "S-1-5-32-544"]
      .map((sid) => ({ sid, allow: true, inherited: false, mask: 0x1f01ff }))
      .concat(dir === roots.dataRoot ? [{ sid: packageSid, allow: true, inherited: false, mask: 0x1301bf }] : []),
  })
  let mutate: (value: Record<string, unknown>) => void = () => {}
  let malformed = false
  const make = (override: Partial<typeof binding> = {}) =>
    BenchmarkAclAuthority.make({
      tempRoot: roots.previewCapabilityRoot,
      executable,
      binding: { ...binding, ...override },
      guard() {},
      collect(dir, _launch, context) {
        if (malformed) return { status: 0, stdout: "not-json", stderr: "" }
        const value: Record<string, unknown> = {
          ...snapshot(dir),
          benchmark: {
            tokenSid: packageSid,
            profileSid: context?.profile === profile ? packageSid : otherSid,
            flags: dir === roots.dataRoot ? [3, 3, 3, 3] : [3, 3, 3],
          },
        }
        mutate(value)
        return { status: 0, stdout: JSON.stringify(value), stderr: "" }
      },
    })
  return {
    root,
    roots,
    binding,
    record,
    recordFile,
    make,
    snapshot,
    mutate(fn: typeof mutate) {
      mutate = fn
    },
    malformed() {
      malformed = true
    },
    [Symbol.dispose]() {
      const now = fs.lstatSync(root, { bigint: true })
      if (
        fs.realpathSync.native(root) !== root ||
        now.dev !== id.dev ||
        now.ino !== id.ino ||
        now.birthtimeNs !== id.birthtimeNs
      )
        throw Error("own authority fixture changed")
      fs.rmSync(root, { recursive: true })
    },
  }
}

test("benchmark authority admits only the native token's exact launcher grant without hiding raw ACLs", () => {
  using f = fixture()
  const authority = f.make()
  const value = authority.probe(f.roots.dataRoot)
  expect(value.aces.at(-1)).toEqual({ sid: packageSid, allow: true, inherited: false, mask: 0x1301bf })
  expect(value.descriptorSddl).toContain(packageSid)
  const policy = HostRootPolicy.makeProduction({
    ...f.roots,
    probe: authority.probe,
    benchmarkWriteGrant: authority.writeGrant,
  })
  expect(() => policy.verifyAll()).not.toThrow()
  expect(() => HostRootPolicy.makeProduction({ ...f.roots, probe: f.snapshot })).toThrow(/untrusted SID/)
})

test("benchmark authority rejects a string-claimed SID when the actual package token differs", () => {
  using f = fixture()
  f.mutate((value) => {
    ;(value.benchmark as { tokenSid: string }).tokenSid = otherSid
  })
  const authority = f.make()
  expect(() =>
    HostRootPolicy.makeProduction({ ...f.roots, probe: authority.probe, benchmarkWriteGrant: authority.writeGrant }),
  ).toThrow()
})

test("benchmark authority rejects another run, expired records and a different executable", () => {
  using f = fixture()
  for (const replacement of [
    { runID: "another-run" },
    { campaignID: "another-campaign" },
    { bindingSha256: "c".repeat(64) },
  ])
    expect(() => f.make(replacement)).toThrow()
  fs.writeFileSync(f.recordFile, JSON.stringify({ ...f.record, expiresAt: Date.now() - 1 }))
  expect(() => f.make()).toThrow()
  fs.writeFileSync(f.recordFile, JSON.stringify({ ...f.record, executableSha256: "d".repeat(64) }))
  expect(() => f.make()).toThrow()
})

test("tampering a record before admission cannot forge the SID committed into the real token", () => {
  using f = fixture()
  fs.writeFileSync(f.recordFile, JSON.stringify({ ...f.record, nonce: "c".repeat(32) }))
  const authority = f.make()
  expect(() => authority.probe(f.roots.dataRoot)).toThrow()
})

test("benchmark authority rejects broadened masks, flags, inherited grants, duplicates and unrelated SIDs", () => {
  using f = fixture()
  for (const change of [
    (v: Record<string, unknown>) => {
      ;(v.aces as HostRootPolicy.Ace[])[3] = { sid: packageSid, allow: true, inherited: false, mask: 0x1f01ff }
    },
    (v: Record<string, unknown>) => {
      ;(v.benchmark as { flags: number[] }).flags[3] = 11
    },
    (v: Record<string, unknown>) => {
      ;(v.aces as HostRootPolicy.Ace[])[3] = { sid: packageSid, allow: true, inherited: true, mask: 0x1301bf }
    },
    (v: Record<string, unknown>) => {
      ;(v.aces as HostRootPolicy.Ace[]).push({ sid: packageSid, allow: true, inherited: false, mask: 0x1301bf })
      ;(v.benchmark as { flags: number[] }).flags.push(3)
    },
    (v: Record<string, unknown>) => {
      ;(v.aces as HostRootPolicy.Ace[])[3] = { sid: otherSid, allow: true, inherited: false, mask: 0x1301bf }
    },
  ]) {
    f.mutate(change)
    const authority = f.make()
    expect(() =>
      HostRootPolicy.makeProduction({ ...f.roots, probe: authority.probe, benchmarkWriteGrant: authority.writeGrant }),
    ).toThrow()
  }
})

test("benchmark authority does not transfer an authorized ACE to a different root or replacement directory", () => {
  using f = fixture()
  const authority = f.make()
  const value = authority.probe(f.roots.dataRoot)
  expect(authority.writeGrant(f.roots.browserCacheRoot, value, value.aces[3]!)).toBe(false)
  fs.renameSync(f.roots.dataRoot, f.roots.dataRoot + "-parked")
  fs.mkdirSync(f.roots.dataRoot)
  expect(() => authority.probe(f.roots.dataRoot)).toThrow()
})

test("benchmark authority rechecks its frozen record on every policy verification", () => {
  using f = fixture()
  const authority = f.make()
  const policy = HostRootPolicy.makeProduction({
    ...f.roots,
    probe: authority.probe,
    benchmarkWriteGrant: authority.writeGrant,
  })
  fs.appendFileSync(f.recordFile, " ")
  expect(() => policy.verifyAll()).toThrow()
})

test("a completed native reply with invalid JSON is refused without pretending its resources are still active", () => {
  using f = fixture()
  f.malformed()
  const authority = f.make()
  expect(() => authority.probe(f.roots.dataRoot)).toThrow()
  expect(fs.readdirSync(f.roots.previewCapabilityRoot)).toEqual([])
})
