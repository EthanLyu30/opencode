import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { DockerConfig } from "../src/workflow/docker-config"
import { ProductionHostRoots } from "../src/workflow/production-host-roots"
import { ProductionHostRuntime } from "../src/workflow/production-host-runtime"

const testRoot = "D:\\OpenCode-Local\\tmp\\workflow-production-host-roots-tests"
const currentUserSid = "S-1-5-21-1000-1000-1000-1001"

afterAll(async () => {
  if (path.resolve(testRoot) !== testRoot) throw new TypeError("Unexpected production-host-roots test root")
  await fs.rm(testRoot, { recursive: true, force: true })
})

describe("ProductionHostRoots", () => {
  test("decodes the eleven launcher variables into one canonical production topology", async () => {
    await using fixture = await setup()

    const contract = ProductionHostRoots.fromEnvironment(fixture.environment, { probe: fixture.probe })

    expect(contract.roots).toEqual({
      deploymentRoot: fixture.directories.deployment,
      dataRoot: fixture.directories.data,
      evidenceRoot: fixture.directories.data,
      runtimeRoot: fixture.directories.browserRuntime,
      browserRuntimeRoot: fixture.directories.browserRuntime,
      browserCacheRoot: fixture.directories.browserCache,
      previewCapabilityRoot: fixture.directories.preview,
      dockerConfigRoot: fixture.directories.dockerConfig,
      dockerTempRoot: fixture.directories.dockerTemp,
    })
    expect(contract.sandbox).toEqual({
      enginePath: fixture.environment.OPENCODE_WORKFLOW_SANDBOX_ENGINE,
      image: fixture.environment.OPENCODE_WORKFLOW_SANDBOX_IMAGE,
    })
    expect(fixture.probedRoots.toSorted()).toEqual(
      [
        fixture.directories.deployment,
        fixture.directories.data,
        fixture.directories.browserRuntime,
        fixture.directories.browserCache,
        fixture.directories.preview,
        fixture.directories.dockerConfig,
        fixture.directories.dockerTemp,
      ].toSorted(),
    )
  })

  test("derives every production Docker boundary from the same eleven-variable contract", async () => {
    await using fixture = await setup()

    const runtime = ProductionHostRuntime.load(fixture.environment, { probe: fixture.probe })

    expect(runtime.contract.roots.previewCapabilityRoot).toBe(fixture.directories.preview)
    expect(runtime.dockerConfig).toMatchObject({
      enginePath: fixture.environment.OPENCODE_WORKFLOW_SANDBOX_ENGINE,
      image: fixture.environment.OPENCODE_WORKFLOW_SANDBOX_IMAGE,
      dockerConfig: fixture.directories.dockerConfig,
      temp: fixture.directories.dockerTemp,
      isolationRoots: [
        fixture.directories.data,
        fixture.directories.browserRuntime,
        fixture.directories.browserCache,
        fixture.directories.preview,
      ],
      locationExcludedRoots: [fixture.directories.deployment],
    })
    expect(() => runtime.dockerConfig.verifyHostRoots?.()).not.toThrow()
    expect(DockerConfig.invocationEnvironment(runtime.dockerConfig)).toEqual({
      DOCKER_CONFIG: fixture.directories.dockerConfig,
      DOCKER_CONTEXT: "default",
      DOCKER_HOST: "",
      DOCKER_TLS_VERIFY: "",
      DOCKER_CERT_PATH: "",
      BUILDX_BUILDER: "",
      BUILDKIT_HOST: "",
      PATH: path.win32.dirname(fixture.environment.OPENCODE_WORKFLOW_SANDBOX_ENGINE),
      TEMP: fixture.directories.dockerTemp,
      TMP: fixture.directories.dockerTemp,
    })
  })

  test("routes both command launch and crash recovery through the production contract", async () => {
    const [commandSandbox, runtimeRecovery] = await Promise.all([
      fs.readFile(path.join(import.meta.dir, "..", "src", "workflow", "command-sandbox.ts"), "utf8"),
      fs.readFile(path.join(import.meta.dir, "..", "src", "workflow", "runtime-recovery.ts"), "utf8"),
    ])

    for (const source of [commandSandbox, runtimeRecovery]) {
      expect(source).toContain("ProductionHostRuntime")
      expect(source).not.toContain("DockerConfig.fromEnvironment(process.env)")
    }
  })

  test.each(
    ProductionHostRoots.environmentNames.flatMap((name) => [
      [name, undefined],
      [name, ""],
    ]) as ReadonlyArray<readonly [ProductionHostRoots.EnvironmentName, string | undefined]>,
  )("fails closed when %s is absent or empty", async (name, value) => {
    await using fixture = await setup()

    expect(() =>
      ProductionHostRoots.fromEnvironment({ ...fixture.environment, [name]: value }, { probe: fixture.probe }),
    ).toThrow(`${name} is required`)
  })

  test.each([
    "OPENCODE_WORKFLOW_HOST_ROOT",
    "OPENCODE_WORKFLOW_HOST_DATA",
    "OPENCODE_WORKFLOW_HOST_RUNTIME",
    "OPENCODE_WORKFLOW_HOST_CACHE",
    "OPENCODE_WORKFLOW_HOST_TEMP",
    "OPENCODE_WORKFLOW_EVIDENCE_ROOT",
    "PLAYWRIGHT_BROWSERS_PATH",
    "OPENCODE_WORKFLOW_SANDBOX_CONFIG",
    "OPENCODE_WORKFLOW_SANDBOX_TEMP",
  ] as const)("rejects a C-drive directory in %s before probing ACLs", async (name) => {
    await using fixture = await setup()

    expect(() =>
      ProductionHostRoots.fromEnvironment(
        { ...fixture.environment, [name]: `C:\\workflow-unsafe\\${name}` },
        { probe: fixture.probe },
      ),
    ).toThrow(/D-drive/)
    expect(fixture.probedRoots).toEqual([])
  })

  test("requires the data/evidence and runtime/Playwright aliases to resolve to the same canonical roots", async () => {
    await using fixture = await setup()
    const otherData = path.join(fixture.directories.deployment, "other-data")
    const otherRuntime = path.join(fixture.directories.deployment, "other-runtime")
    await fs.mkdir(otherData)
    await fs.mkdir(otherRuntime)

    expect(() =>
      ProductionHostRoots.fromEnvironment(
        { ...fixture.environment, OPENCODE_WORKFLOW_EVIDENCE_ROOT: otherData },
        { probe: fixture.probe },
      ),
    ).toThrow(/data and evidence/)
    expect(() =>
      ProductionHostRoots.fromEnvironment(
        { ...fixture.environment, PLAYWRIGHT_BROWSERS_PATH: otherRuntime },
        { probe: fixture.probe },
      ),
    ).toThrow(/runtime and Playwright/)
  })

  test.each([
    ["data/evidence", "OPENCODE_WORKFLOW_HOST_DATA", "OPENCODE_WORKFLOW_EVIDENCE_ROOT", "data"],
    ["runtime/Playwright", "OPENCODE_WORKFLOW_HOST_RUNTIME", "PLAYWRIGHT_BROWSERS_PATH", "playwright"],
  ] as const)("rejects a lexical dot-segment alias for %s before probing ACLs", async (_label, left, right, leaf) => {
    await using fixture = await setup()
    const canonical = fixture.environment[left]
    const alias = `${path.dirname(canonical)}\\..\\${path.basename(path.dirname(canonical))}\\${leaf}`

    expect(() =>
      ProductionHostRoots.fromEnvironment(
        { ...fixture.environment, [left]: alias, [right]: alias },
        { probe: fixture.probe },
      ),
    ).toThrow(/aliases or reparse/)
    expect(fixture.probedRoots).toEqual([])
  })

  test("rejects an alias or junction before any ACL probe", async () => {
    await using fixture = await setup()
    const outside = path.join(fixture.caseRoot, "outside")
    const alias = path.join(fixture.directories.deployment, "cache-alias")
    await fs.mkdir(outside)
    await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir")

    expect(() =>
      ProductionHostRoots.fromEnvironment(
        { ...fixture.environment, OPENCODE_WORKFLOW_HOST_CACHE: alias },
        { probe: fixture.probe },
      ),
    ).toThrow(/aliases or reparse/)
    expect(fixture.probedRoots).toEqual([])
  })

  test("requires all six capability leaves to be strict pairwise non-overlapping deployment descendants", async () => {
    await using fixture = await setup()
    const outside = path.join(fixture.caseRoot, "outside-leaf")
    await fs.mkdir(outside)

    expect(() =>
      ProductionHostRoots.fromEnvironment(
        { ...fixture.environment, OPENCODE_WORKFLOW_HOST_CACHE: outside },
        { probe: fixture.probe },
      ),
    ).toThrow(/strict deployment descendants/)
    expect(() =>
      ProductionHostRoots.fromEnvironment(
        { ...fixture.environment, OPENCODE_WORKFLOW_HOST_CACHE: fixture.directories.data },
        { probe: fixture.probe },
      ),
    ).toThrow(/pairwise isolated/)
  })

  test("excludes every Location overlapping the entire deployment tree", async () => {
    await using fixture = await setup()
    const nestedWorkspace = path.join(fixture.directories.deployment, "workspace")
    await fs.mkdir(nestedWorkspace)

    expect(() =>
      ProductionHostRoots.fromEnvironment(fixture.environment, {
        probe: fixture.probe,
        workspaceRoots: [nestedWorkspace],
      }),
    ).toThrow(/deployment tree/)
  })

  test("revalidates the protected ACL and stable identity of every production root", async () => {
    await using fixture = await setup()
    const contract = ProductionHostRoots.fromEnvironment(fixture.environment, { probe: fixture.probe })
    const parked = `${fixture.directories.browserCache}-parked`
    await fs.rename(fixture.directories.browserCache, parked)
    await fs.mkdir(fixture.directories.browserCache)

    try {
      expect(() => contract.policy.verifyAll()).toThrow(/identity changed/)
    } finally {
      await fs.rm(fixture.directories.browserCache, { recursive: true, force: true })
      await fs.rename(parked, fixture.directories.browserCache)
    }
    fixture.snapshot.protected = false
    expect(() => contract.policy.verifyAll()).toThrow(/ACL/)
  })

  test("requires explicit current-user, LocalSystem, and Administrators host authority on all seven roots", async () => {
    await using fixture = await setup()
    fixture.snapshot.aces = fixture.snapshot.aces.filter((ace) => ace.sid !== "S-1-5-18")

    expect(() => ProductionHostRoots.fromEnvironment(fixture.environment, { probe: fixture.probe })).toThrow(
      /trusted host authority/,
    )
  })

  test("requires full control rather than one incidental write bit for every trusted production SID", async () => {
    await using fixture = await setup()
    fixture.snapshot.aces = fixture.snapshot.aces.map((ace) => ({ ...ace, mask: 0x00000100 }))

    expect(() => ProductionHostRoots.fromEnvironment(fixture.environment, { probe: fixture.probe })).toThrow(
      /full control/,
    )
  })

  test("rejects a trusted production SID whose full-control allow is masked by an explicit deny", async () => {
    await using fixture = await setup()
    fixture.snapshot.aces.unshift({ sid: "S-1-5-18", allow: false, inherited: false, mask: 0x001f01ff })

    expect(() => ProductionHostRoots.fromEnvironment(fixture.environment, { probe: fixture.probe })).toThrow(
      /effective full control/,
    )
  })

  test("fails closed unless the production ACL probe explicitly proves a non-reparse directory", async () => {
    await using fixture = await setup()
    fixture.snapshot.reparsePoint = true

    expect(() => ProductionHostRoots.fromEnvironment(fixture.environment, { probe: fixture.probe })).toThrow(
      /reparse point/,
    )
  })

  test("mints cleanup authority only for an ordinary strict descendant of preview capability temp", async () => {
    await using fixture = await setup()
    const contract = ProductionHostRoots.fromEnvironment(fixture.environment, { probe: fixture.probe })
    const target = path.join(fixture.directories.preview, "host-1")
    const workspace = path.join(fixture.caseRoot, "workspace")
    await fs.mkdir(target)
    await fs.mkdir(workspace)

    const authority = contract.policy.authorizeCleanupTarget({ target, workspace })

    expect(contract.policy.verifyCleanupTarget(authority)).toBe(target)
    for (const rejected of [
      fixture.directories.deployment,
      fixture.directories.preview,
      fixture.directories.data,
      fixture.directories.browserRuntime,
      fixture.directories.browserCache,
      fixture.directories.dockerConfig,
      fixture.directories.dockerTemp,
      workspace,
    ]) {
      expect(() => contract.policy.authorizeCleanupTarget({ target: rejected, workspace })).toThrow(TypeError)
      expect(await fs.exists(rejected)).toBe(true)
    }
  })

  test("grants zero cleanup authority to a junction, hardlink, or case alias", async () => {
    await using fixture = await setup()
    const contract = ProductionHostRoots.fromEnvironment(fixture.environment, { probe: fixture.probe })
    const outside = path.join(fixture.caseRoot, "outside-cleanup")
    const marker = path.join(outside, "marker.txt")
    const junction = path.join(fixture.directories.preview, "junction")
    await fs.mkdir(outside)
    await fs.writeFile(marker, "keep")
    await fs.symlink(outside, junction, process.platform === "win32" ? "junction" : "dir")
    expect(() => contract.policy.authorizeCleanupTarget({ target: junction })).toThrow(TypeError)
    expect(await fs.readFile(marker, "utf8")).toBe("keep")

    const original = path.join(fixture.directories.preview, "original.txt")
    const hardlink = path.join(fixture.directories.preview, "hardlink.txt")
    await fs.writeFile(original, "keep")
    await fs.link(original, hardlink)
    expect(() => contract.policy.authorizeCleanupTarget({ target: hardlink })).toThrow(TypeError)
    expect(await fs.readFile(original, "utf8")).toBe("keep")

    const target = path.join(fixture.directories.preview, "Case-Sensitive-Host")
    await fs.mkdir(target)
    const caseAlias = path.join(fixture.directories.preview, "case-sensitive-host")
    expect(() => contract.policy.authorizeCleanupTarget({ target: caseAlias })).toThrow(TypeError)
    expect(await fs.exists(target)).toBe(true)
  })

  test("invalidates a cleanup authority if its target identity changes before deletion", async () => {
    await using fixture = await setup()
    const contract = ProductionHostRoots.fromEnvironment(fixture.environment, { probe: fixture.probe })
    const target = path.join(fixture.directories.preview, "host-replaced")
    const parked = `${target}-parked`
    await fs.mkdir(target)
    const authority = contract.policy.authorizeCleanupTarget({ target })
    await fs.rename(target, parked)
    await fs.mkdir(target)

    expect(() => contract.policy.verifyCleanupTarget(authority)).toThrow(/identity changed/)
    expect(await fs.exists(target)).toBe(true)
    expect(await fs.exists(parked)).toBe(true)
  })

  test("keeps Docker leaf isolation separate from whole-deployment Location exclusion", async () => {
    await using fixture = await setup()
    const contract = ProductionHostRoots.fromEnvironment(fixture.environment, { probe: fixture.probe })

    const validated = await DockerConfig.validate(DockerConfig.fromProductionHostRoots(contract))

    expect(validated.dockerConfig).toBe(fixture.directories.dockerConfig)
    expect(validated.temp).toBe(fixture.directories.dockerTemp)
    expect(validated.isolationRoots).toEqual([
      fixture.directories.data,
      fixture.directories.browserRuntime,
      fixture.directories.browserCache,
      fixture.directories.preview,
    ])
    expect(validated.locationExcludedRoots).toEqual([fixture.directories.deployment])
    const workspace = path.join(fixture.caseRoot, "workspace-allowed")
    await fs.mkdir(workspace)
    await expect(DockerConfig.admitWorkspace(validated, workspace)).resolves.toBe(workspace)
    await expect(DockerConfig.admitWorkspace(validated, fixture.directories.deployment)).rejects.toThrow(/protected/)
  })

  test("accepts one digest-pinned image from an explicit loopback installation registry", async () => {
    await using fixture = await setup()
    const environment = {
      ...fixture.environment,
      OPENCODE_WORKFLOW_SANDBOX_IMAGE: `127.0.0.1:5000/opencode/workflow-sandbox@sha256:${"b".repeat(64)}`,
    }
    const contract = ProductionHostRoots.fromEnvironment(environment, { probe: fixture.probe })

    const validated = await DockerConfig.validate(DockerConfig.fromProductionHostRoots(contract))

    expect(validated.image).toBe(environment.OPENCODE_WORKFLOW_SANDBOX_IMAGE)
  })

  test("rechecks the seven-root ACL contract at every Docker revalidation boundary", async () => {
    await using fixture = await setup()
    const contract = ProductionHostRoots.fromEnvironment(fixture.environment, { probe: fixture.probe })
    const validated = await DockerConfig.validate(DockerConfig.fromProductionHostRoots(contract))
    fixture.snapshot.protected = false

    await expect(DockerConfig.revalidate(validated)).rejects.toThrow(/ACL/)
  })

  test("the raw environment adapter permits Docker config/temp under deployment without weakening isolation", async () => {
    await using fixture = await setup()

    const validated = await DockerConfig.validate(DockerConfig.fromEnvironment(fixture.environment))

    expect(validated.locationExcludedRoots).toEqual([fixture.directories.deployment])
    expect(validated.isolationRoots).toEqual([
      fixture.directories.data,
      fixture.directories.browserRuntime,
      fixture.directories.browserCache,
      fixture.directories.preview,
    ])
  })

  test("rejects Docker engine/config/temp overlap with an exact workflow leaf", async () => {
    await using fixture = await setup()
    const base = DockerConfig.fromEnvironment(fixture.environment)
    const nestedEngine = path.join(fixture.directories.data, "docker.exe")
    await fs.writeFile(nestedEngine, "nested engine")

    await expect(
      DockerConfig.validate({ ...base, enginePath: nestedEngine, isolationRoots: [fixture.directories.data] }),
    ).rejects.toThrow(/isolated/)
    await expect(
      DockerConfig.validate({
        ...base,
        dockerConfig: fixture.directories.data,
        isolationRoots: [fixture.directories.data],
      }),
    ).rejects.toThrow(/isolated/)
    await expect(
      DockerConfig.validate({ ...base, temp: fixture.directories.data, isolationRoots: [fixture.directories.data] }),
    ).rejects.toThrow(/isolated/)
  })

  test.each(["dockerConfig", "dockerTemp"] as const)(
    "revalidation detects replacement of the %s directory identity",
    async (name) => {
      await using fixture = await setup()
      const validated = await DockerConfig.validate(DockerConfig.fromEnvironment(fixture.environment))
      const target = fixture.directories[name]
      const parked = `${target}-parked`
      await fs.rename(target, parked)
      await fs.mkdir(target)

      try {
        await expect(DockerConfig.revalidate(validated)).rejects.toThrow(/identity changed/)
      } finally {
        await fs.rm(target, { recursive: true, force: true })
        await fs.rename(parked, target)
      }
    },
  )
})

async function setup() {
  await fs.mkdir(testRoot, { recursive: true })
  const caseRoot = await fs.realpath(await fs.mkdtemp(path.join(testRoot, "case-")))
  const deployment = path.join(caseRoot, "deployment")
  const directories = {
    deployment,
    data: path.join(deployment, "data"),
    browserRuntime: path.join(deployment, "runtime", "playwright"),
    browserCache: path.join(deployment, "cache", "browser"),
    preview: path.join(deployment, "temp", "preview"),
    dockerConfig: path.join(deployment, "sandbox", "config"),
    dockerTemp: path.join(deployment, "sandbox", "temp"),
  }
  await Promise.all(Object.values(directories).map((directory) => fs.mkdir(directory, { recursive: true })))
  const enginePath = path.join(caseRoot, "docker.exe")
  await fs.writeFile(enginePath, "test docker engine")
  const environment = {
    OPENCODE_WORKFLOW_HOST_ROOT: deployment,
    OPENCODE_WORKFLOW_HOST_DATA: directories.data,
    OPENCODE_WORKFLOW_HOST_RUNTIME: directories.browserRuntime,
    OPENCODE_WORKFLOW_HOST_CACHE: directories.browserCache,
    OPENCODE_WORKFLOW_HOST_TEMP: directories.preview,
    OPENCODE_WORKFLOW_EVIDENCE_ROOT: directories.data,
    PLAYWRIGHT_BROWSERS_PATH: directories.browserRuntime,
    OPENCODE_WORKFLOW_SANDBOX_ENGINE: enginePath,
    OPENCODE_WORKFLOW_SANDBOX_IMAGE: `opencode/workflow-sandbox@sha256:${"a".repeat(64)}`,
    OPENCODE_WORKFLOW_SANDBOX_CONFIG: directories.dockerConfig,
    OPENCODE_WORKFLOW_SANDBOX_TEMP: directories.dockerTemp,
  } as const
  const snapshot = {
    currentUserSid,
    currentIdentitySids: [currentUserSid],
    ownerSid: currentUserSid,
    protected: true,
    reparsePoint: false,
    descriptorSddl: `O:${currentUserSid}G:${currentUserSid}D:P(A;;FA;;;${currentUserSid})(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)`,
    aces: [
      { sid: currentUserSid, allow: true, inherited: false, mask: 0x001f01ff },
      { sid: "S-1-5-18", allow: true, inherited: false, mask: 0x001f01ff },
      { sid: "S-1-5-32-544", allow: true, inherited: false, mask: 0x001f01ff },
    ],
  }
  const probedRoots: string[] = []
  return {
    caseRoot,
    directories,
    environment,
    snapshot,
    probedRoots,
    probe: (root: string) => {
      probedRoots.push(root)
      return structuredClone(snapshot)
    },
    async [Symbol.asyncDispose]() {
      await fs.rm(caseRoot, { recursive: true, force: true })
    },
  }
}
