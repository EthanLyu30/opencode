import { afterAll, describe, expect, test } from "bun:test"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import fs from "node:fs/promises"
import path from "node:path"
import { EvidenceLedger } from "../src/workflow/evidence-ledger"
import { HostRootPolicy } from "../src/workflow/host-root-policy"

const root = "D:\\OpenCode-Local\\tmp\\workflow-host-root-policy-tests"
const currentUser = "S-1-5-21-1000-1000-1000-1001"

afterAll(async () => {
  if (path.resolve(root) !== root) throw new TypeError("Unexpected host-root policy test root")
  await fs.rm(root, { recursive: true, force: true })
})

describe("HostRootPolicy", () => {
  test("accepts protected D-drive roots owned and writable only by trusted host identities", async () => {
    await using fixture = await setup()

    const policy = HostRootPolicy.make({ ...fixture.roots, probe: fixture.probe })

    expect(policy.roots).toEqual(fixture.roots)
    expect(() => policy.verifyHostRoot(fixture.roots.hostRoot)).not.toThrow()
    expect(() => policy.verifyEvidenceRoot(fixture.roots.evidenceRoot)).not.toThrow()
  })

  test.each([
    [
      "owner mismatch",
      (snapshot: MutableSnapshot) => {
        snapshot.ownerSid = "S-1-5-21-9-9-9-1001"
      },
    ],
    [
      "unprotected inheritance",
      (snapshot: MutableSnapshot) => {
        snapshot.protected = false
      },
    ],
    [
      "Everyone write",
      (snapshot: MutableSnapshot) => {
        snapshot.aces.push(rule("S-1-1-0", true, ["write_data"]))
      },
    ],
    [
      "Builtin Users modify",
      (snapshot: MutableSnapshot) => {
        snapshot.aces.push(rule("S-1-5-32-545", true, ["delete"]))
      },
    ],
    [
      "Authenticated Users change permissions",
      (snapshot: MutableSnapshot) => {
        snapshot.aces.push(rule("S-1-5-11", true, ["write_dac"]))
      },
    ],
    [
      "anonymous change owner",
      (snapshot: MutableSnapshot) => {
        snapshot.aces.push(rule("S-1-5-7", true, ["write_owner"]))
      },
    ],
    [
      "non-allowlisted SID append",
      (snapshot: MutableSnapshot) => {
        snapshot.aces.push(rule("S-1-5-21-8-8-8-1002", true, ["append_data"]))
      },
    ],
    [
      "inherited broad write ACE",
      (snapshot: MutableSnapshot) => {
        snapshot.aces.push(rule("S-1-1-0", true, ["generic_write"], true))
      },
    ],
  ] as const)("fails closed for %s", async (_name, mutate) => {
    await using fixture = await setup()
    mutate(fixture.snapshot)

    expect(() => HostRootPolicy.make({ ...fixture.roots, probe: fixture.probe })).toThrow(TypeError)
  })

  test("permits deny ACEs and trusted LocalSystem/Builtin Administrators write ACEs", async () => {
    await using fixture = await setup()
    fixture.snapshot.aces.push(
      rule("S-1-1-0", false, ["generic_all"]),
      rule("S-1-5-18", true, ["generic_all"]),
      rule("S-1-5-32-544", true, ["generic_all"]),
    )

    expect(() => HostRootPolicy.make({ ...fixture.roots, probe: fixture.probe })).not.toThrow()
  })

  test.each(["hostRoot", "evidenceRoot", "browserRoot", "tempRoot"] as const)("rejects a C-drive %s", async (name) => {
    await using fixture = await setup()
    expect(() =>
      HostRootPolicy.make({ ...fixture.roots, [name]: `C:\\unsafe\\${name}`, probe: fixture.probe }),
    ).toThrow(TypeError)
  })

  test("rejects host roots overlapping a workspace-controlled tree", async () => {
    await using fixture = await setup()

    expect(() =>
      HostRootPolicy.make({ ...fixture.roots, workspaceRoots: [fixture.roots.hostRoot], probe: fixture.probe }),
    ).toThrow(TypeError)
  })

  test("rejects a junction alias before probing its outside target", async () => {
    await using fixture = await setup()
    const outside = path.join(root, `outside-${crypto.randomUUID()}`)
    const alias = path.join(fixture.caseRoot, "evidence-alias")
    await fs.mkdir(outside)
    await fs.symlink(outside, alias, "junction")
    let probed = false

    expect(() =>
      HostRootPolicy.make({
        ...fixture.roots,
        evidenceRoot: alias,
        probe: () => {
          probed = true
          return fixture.snapshot
        },
      }),
    ).toThrow(TypeError)
    expect(probed).toBe(false)
    await fs.rm(outside, { recursive: true, force: true })
  })

  test("rechecks ACL identity at every evidence operation boundary and closes on mutation", async () => {
    await using fixture = await setup()
    const policy = HostRootPolicy.make({ ...fixture.roots, probe: fixture.probe })
    const ledger = EvidenceLedger.open(fixture.roots.evidenceRoot, { rootPolicy: policy.verifyEvidenceRoot })
    expect(await ledger.reserve("wfl_acl_boundary", 1, WorkflowVisualHost.MAX_WORKFLOW_EVIDENCE_BYTES)).toBe(true)
    fixture.snapshot.aces.push(rule("S-1-1-0", true, ["write_data"]))

    await expect(ledger.used("wfl_acl_boundary")).rejects.toBeInstanceOf(TypeError)
    await expect(ledger.used("wfl_acl_boundary")).rejects.toThrow(/closed/)
  })

  test("production probe uses only fixed PowerShell code/argv and a minimal D-temp environment", async () => {
    await using fixture = await setup()
    let invocation: HostRootPolicy.ProbeInvocation | undefined
    const probe = HostRootPolicy.productionProbe({
      tempRoot: fixture.roots.tempRoot,
      run: (input) => {
        invocation = input
        return { exit: 0, stdout: JSON.stringify(fixture.snapshot), stderr: "" }
      },
    })

    expect(probe(fixture.roots.evidenceRoot)).toEqual(fixture.snapshot)
    expect(invocation?.executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    expect(invocation?.argv.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
    expect(invocation?.argv.at(-1)).toBe(fixture.roots.evidenceRoot)
    expect(invocation?.argv[4]).not.toContain(fixture.roots.evidenceRoot)
    expect(invocation?.env).toEqual({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: fixture.roots.tempRoot,
      TMP: fixture.roots.tempRoot,
    })
  })
})

type MutableSnapshot = {
  currentUserSid: string
  ownerSid: string
  protected: boolean
  aces: Array<{
    sid: string
    allow: boolean
    inherited: boolean
    rights: HostRootPolicy.Right[]
  }>
}

async function setup() {
  await fs.mkdir(root, { recursive: true })
  const caseRoot = await fs.realpath(await fs.mkdtemp(path.join(root, "case-")))
  const hostRoot = path.join(caseRoot, "host")
  const evidenceRoot = path.join(hostRoot, "evidence")
  const browserRoot = path.join(hostRoot, "browser")
  const tempRoot = path.join(hostRoot, "temp")
  await Promise.all(
    [hostRoot, evidenceRoot, browserRoot, tempRoot].map((directory) => fs.mkdir(directory, { recursive: true })),
  )
  const roots = { hostRoot, evidenceRoot, browserRoot, tempRoot }
  const snapshot: MutableSnapshot = {
    currentUserSid: currentUser,
    ownerSid: currentUser,
    protected: true,
    aces: [rule(currentUser, true, ["generic_all"])],
  }
  return {
    caseRoot,
    roots,
    snapshot,
    probe: () => structuredClone(snapshot),
    async [Symbol.asyncDispose]() {
      await fs.rm(caseRoot, { recursive: true, force: true })
    },
  }
}

function rule(sid: string, allow: boolean, rights: HostRootPolicy.Right[], inherited = false) {
  return { sid, allow, inherited, rights }
}
