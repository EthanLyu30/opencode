import { afterAll, describe, expect, test } from "bun:test"
import { WorkflowVisualHost } from "@opencode-ai/core/workflow/visual-host"
import fs from "node:fs/promises"
import path from "node:path"
import { EvidenceLedger } from "../src/workflow/evidence-ledger"
import { HostRootPolicy } from "../src/workflow/host-root-policy"

const root = "D:\\OpenCode-Local\\tmp\\workflow-host-root-policy-tests"
const currentUser = "S-1-5-21-1000-1000-1000-1001"
const mask = {
  fullControl: 0x001f01ff,
  genericWrite: 0x40000000,
  writeData: 0x00000002,
  appendData: 0x00000004,
  delete: 0x00010000,
  writeDac: 0x00040000,
  writeOwner: 0x00080000,
  read: 0x00020089,
} as const

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
    expect(() => policy.verifyTempRoot(fixture.roots.tempRoot)).not.toThrow()
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
        snapshot.aces.push(rule("S-1-1-0", true, mask.writeData))
      },
    ],
    [
      "Builtin Users modify",
      (snapshot: MutableSnapshot) => {
        snapshot.aces.push(rule("S-1-5-32-545", true, mask.delete))
      },
    ],
    [
      "Authenticated Users change permissions",
      (snapshot: MutableSnapshot) => {
        snapshot.aces.push(rule("S-1-5-11", true, mask.writeDac))
      },
    ],
    [
      "anonymous change owner",
      (snapshot: MutableSnapshot) => {
        snapshot.aces.push(rule("S-1-5-7", true, mask.writeOwner))
      },
    ],
    [
      "non-allowlisted SID append",
      (snapshot: MutableSnapshot) => {
        snapshot.aces.push(rule("S-1-5-21-8-8-8-1002", true, mask.appendData))
      },
    ],
    [
      "inherited broad write ACE",
      (snapshot: MutableSnapshot) => {
        snapshot.aces.push(rule("S-1-1-0", true, mask.genericWrite, true))
      },
    ],
  ] as const)("fails closed for %s", async (_name, mutate) => {
    await using fixture = await setup()
    mutate(fixture.snapshot)

    expect(() => HostRootPolicy.make({ ...fixture.roots, probe: fixture.probe })).toThrow(TypeError)
  })

  test("permits non-applicable deny ACEs and trusted LocalSystem/Builtin Administrators write ACEs", async () => {
    await using fixture = await setup()
    fixture.snapshot.aces.push(
      rule("S-1-5-21-9-9-9-513", false, mask.fullControl),
      rule("S-1-5-18", true, mask.fullControl),
      rule("S-1-5-32-544", true, mask.fullControl),
    )

    expect(() => HostRootPolicy.make({ ...fixture.roots, probe: fixture.probe })).not.toThrow()
  })

  test("fails closed when an unqualified Builtin Administrators group allow is the only numeric write grant", async () => {
    await using fixture = await setup()
    const administrators = "S-1-5-32-544"
    const raw = {
      currentUserSid: currentUser,
      currentIdentitySids: [currentUser, administrators],
      ownerSid: currentUser,
      protected: true,
      descriptorSddl: `O:${currentUser}G:${currentUser}D:P(A;;FW;;;${administrators})`,
      aces: [{ sid: administrators, allow: true, inherited: false, mask: 0x00000002 }],
    }
    const probe = HostRootPolicy.productionProbe({
      tempRoot: fixture.roots.tempRoot,
      run: () => ({ exit: 0, stdout: JSON.stringify(raw), stderr: "" }),
    })

    expect(() => HostRootPolicy.make({ ...fixture.roots, probe })).toThrow(/direct current-user write/)
  })

  test("fails closed when an applicable group deny masks a direct numeric write allow", async () => {
    await using fixture = await setup()
    const group = "S-1-5-21-1000-1000-1000-513"
    const raw = {
      currentUserSid: currentUser,
      currentIdentitySids: [currentUser, group],
      ownerSid: currentUser,
      protected: true,
      descriptorSddl: `O:${currentUser}G:${currentUser}D:P(D;;FW;;;${group})(A;;FW;;;${currentUser})`,
      aces: [
        { sid: group, allow: false, inherited: false, mask: 0x00000002 },
        { sid: currentUser, allow: true, inherited: false, mask: 0x00000002 },
      ],
    }
    const probe = HostRootPolicy.productionProbe({
      tempRoot: fixture.roots.tempRoot,
      run: () => ({ exit: 0, stdout: JSON.stringify(raw), stderr: "" }),
    })

    expect(() => HostRootPolicy.make({ ...fixture.roots, probe })).toThrow(/direct current-user write/)
  })

  test("normalizes a direct generic write allow into the same domain as a concrete group deny", async () => {
    await using fixture = await setup()
    const group = "S-1-5-21-1000-1000-1000-513"
    fixture.snapshot.currentIdentitySids.push(group)
    fixture.snapshot.aces = [rule(currentUser, true, mask.genericWrite), rule(group, false, mask.fullControl)]

    expect(() => HostRootPolicy.make({ ...fixture.roots, probe: fixture.probe })).toThrow(/direct current-user write/)
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
    fixture.snapshot.aces.push(rule("S-1-1-0", true, mask.writeData))

    await expect(ledger.used("wfl_acl_boundary")).rejects.toBeInstanceOf(TypeError)
    await expect(ledger.used("wfl_acl_boundary")).rejects.toThrow(/closed/)
  })

  test("fails closed on any ACL descriptor fingerprint change, even when the replacement remains read-only", async () => {
    await using fixture = await setup()
    const policy = HostRootPolicy.make({ ...fixture.roots, probe: fixture.probe })
    const ledger = EvidenceLedger.open(fixture.roots.evidenceRoot, { rootPolicy: policy.verifyEvidenceRoot })
    fixture.snapshot.aces.push(rule("S-1-5-18", false, mask.read))
    let cause: unknown

    try {
      await ledger.used("wfl_acl_fingerprint")
    } catch (error) {
      cause = error
    } finally {
      await ledger.close()
    }
    expect(cause).toBeInstanceOf(TypeError)
  })

  test("fails closed when only ACL descriptor flags change", async () => {
    await using fixture = await setup()
    const policy = HostRootPolicy.make({ ...fixture.roots, probe: fixture.probe })
    fixture.snapshot.descriptorSddl = fixture.snapshot.descriptorSddl.replace("D:P(", "D:PAI(")

    expect(() => policy.verifyEvidenceRoot(fixture.roots.evidenceRoot)).toThrow(/descriptor changed/)
  })

  test("fails closed when a root is replaced at the same canonical path with the same ACL projection", async () => {
    await using fixture = await setup()
    const policy = HostRootPolicy.make({ ...fixture.roots, probe: fixture.probe })
    const parked = `${fixture.roots.evidenceRoot}-parked`
    await fs.rename(fixture.roots.evidenceRoot, parked)
    await fs.mkdir(fixture.roots.evidenceRoot)

    try {
      expect(() => policy.verifyEvidenceRoot(fixture.roots.evidenceRoot)).toThrow(/identity changed/)
    } finally {
      await fs.rm(fixture.roots.evidenceRoot, { recursive: true, force: true })
      await fs.rename(parked, fixture.roots.evidenceRoot)
    }
  })

  test("uses one evidence-root probe per side of an operation boundary instead of probing every host root", async () => {
    await using fixture = await setup()
    const policy = HostRootPolicy.make({ ...fixture.roots, probe: fixture.probe })
    const ledger = EvidenceLedger.open(fixture.roots.evidenceRoot, { rootPolicy: policy.verifyEvidenceRoot })
    const before = fixture.probeCalls

    const used = await ledger.used("wfl_acl_probe_bound")
    const probeCalls = fixture.probeCalls - before
    await ledger.close()

    expect(used).toBe(0)
    expect(probeCalls).toBe(2)
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
  currentIdentitySids: string[]
  ownerSid: string
  protected: boolean
  descriptorSddl: string
  aces: Array<{
    sid: string
    allow: boolean
    inherited: boolean
    mask: number
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
    currentIdentitySids: [currentUser, "S-1-1-0"],
    ownerSid: currentUser,
    protected: true,
    descriptorSddl: `O:${currentUser}G:${currentUser}D:P(A;;FA;;;${currentUser})`,
    aces: [rule(currentUser, true, mask.fullControl)],
  }
  let probeCalls = 0
  return {
    caseRoot,
    roots,
    snapshot,
    probe: () => {
      probeCalls++
      return structuredClone(snapshot)
    },
    get probeCalls() {
      return probeCalls
    },
    async [Symbol.asyncDispose]() {
      await fs.rm(caseRoot, { recursive: true, force: true })
    },
  }
}

function rule(sid: string, allow: boolean, accessMask: number, inherited = false) {
  return { sid, allow, inherited, mask: accessMask }
}
