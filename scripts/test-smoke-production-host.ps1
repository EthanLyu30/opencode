[CmdletBinding()]
param(
  [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$BunRuntime = "D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe",
  [string]$TestRoot = "D:\OpenCode-Task23-Gates\smoke-production-host"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-ExactPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][ValidateSet("File", "Directory")][string]$Kind
  )

  $item = Get-Item -LiteralPath $Path -Force
  $resolved = $item.FullName
  if (-not [IO.Path]::IsPathFullyQualified($resolved) -or -not $resolved.StartsWith("D:\", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Test paths must remain on D:"
  }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Test path is a reparse point: $resolved" }
  if ($Kind -eq "File" -and -not $item.PSIsContainer) { return $resolved }
  if ($Kind -eq "Directory" -and $item.PSIsContainer) { return $resolved }
  throw "Test path kind differs: $resolved"
}

function Test-StrictDescendant {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child
  )

  $relative = [IO.Path]::GetRelativePath($Parent, $Child)
  return (
    $relative -ne "." -and
    -not [IO.Path]::IsPathFullyQualified($relative) -and
    $relative -ne ".." -and
    -not $relative.StartsWith("..\", [StringComparison]::Ordinal)
  )
}

function Remove-TestTreeLeafFirst {
  param(
    [Parameter(Mandatory = $true)][string]$ApprovedRoot,
    [Parameter(Mandatory = $true)][string]$Target
  )

  if (-not (Test-Path -LiteralPath $Target)) { return }
  $approved = Resolve-ExactPath -Path $ApprovedRoot -Kind Directory
  $targetPath = Resolve-ExactPath -Path $Target -Kind Directory
  if (-not (Test-StrictDescendant -Parent $approved -Child $targetPath)) {
    throw "Refusing cleanup outside the approved smoke-test root: $targetPath"
  }
  $entries = @(Get-ChildItem -LiteralPath $targetPath -Force -Recurse)
  foreach ($entry in $entries) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing cleanup through a reparse point: $($entry.FullName)"
    }
  }
  foreach ($file in @($entries | Where-Object { -not $_.PSIsContainer })) {
    [IO.File]::Delete($file.FullName)
  }
  foreach ($directory in @($entries | Where-Object { $_.PSIsContainer } | Sort-Object { $_.FullName.Length } -Descending)) {
    [IO.Directory]::Delete($directory.FullName, $false)
  }
  [IO.Directory]::Delete($targetPath, $false)
}

$repository = Resolve-ExactPath -Path $RepositoryRoot -Kind Directory
$bun = Resolve-ExactPath -Path $BunRuntime -Kind File
$script = Resolve-ExactPath -Path (Join-Path $repository "scripts\smoke-production-host.ts") -Kind File
$serverPackage = Resolve-ExactPath -Path (Join-Path $repository "packages\server") -Kind Directory

$testRootExisted = Test-Path -LiteralPath $TestRoot
[IO.Directory]::CreateDirectory($TestRoot) | Out-Null
$testBase = Resolve-ExactPath -Path $TestRoot -Kind Directory
$caseRoot = Join-Path $testBase ([Guid]::NewGuid().ToString("N"))
[IO.Directory]::CreateDirectory($caseRoot) | Out-Null
$caseRoot = Resolve-ExactPath -Path $caseRoot -Kind Directory
$driver = Join-Path $caseRoot "smoke-production-host.test.ts"

$moduleSpecifier = ([Uri]::new($script)).AbsoluteUri | ConvertTo-Json -Compress
$visualSpecifier = ([Uri]::new((Join-Path $repository "packages\core\src\workflow\visual-host.ts"))).AbsoluteUri | ConvertTo-Json -Compress

$driverSource = @'
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { runProductionHostSmoke } from __SMOKE_MODULE__
import { WorkflowVisualHost } from __VISUAL_MODULE__

const testRoot = __CASE_ROOT__
const deployment = path.join(testRoot, "deployment")
const workspaceParent = path.join(testRoot, "workspace-parent")
const enginePath = path.join(testRoot, "engine", "docker.exe")
const runtimeSandbox = path.join(deployment, "runtime", "sandbox")
const browserExecutablePath = path.join(deployment, "runtime", "playwright", "chromium", "chrome.exe")
const archiveBytes = new TextEncoder().encode("fake exact OCI archive")
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex")
const archivePath = path.join(runtimeSandbox, "workflow-sandbox." + archiveSha256 + ".oci.tar")
const image = "127.0.0.1:5000/opencode/workflow-sandbox@sha256:" + "a".repeat(64)
const roots = {
  data: path.join(deployment, "data", "workflow-host"),
  browserRuntime: path.join(deployment, "runtime", "playwright"),
  browserCache: path.join(deployment, "cache", "playwright"),
  preview: path.join(deployment, "tmp", "workflow-host"),
  dockerConfig: path.join(deployment, "config", "docker"),
  dockerTemp: path.join(deployment, "tmp", "workflow-sandbox"),
}
const environment = {
  OPENCODE_WORKFLOW_HOST_ROOT: deployment,
  OPENCODE_WORKFLOW_HOST_DATA: roots.data,
  OPENCODE_WORKFLOW_HOST_RUNTIME: roots.browserRuntime,
  OPENCODE_WORKFLOW_HOST_CACHE: roots.browserCache,
  OPENCODE_WORKFLOW_HOST_TEMP: roots.preview,
  OPENCODE_WORKFLOW_EVIDENCE_ROOT: roots.data,
  PLAYWRIGHT_BROWSERS_PATH: roots.browserRuntime,
  OPENCODE_WORKFLOW_SANDBOX_ENGINE: enginePath,
  OPENCODE_WORKFLOW_SANDBOX_IMAGE: image,
  OPENCODE_WORKFLOW_SANDBOX_CONFIG: roots.dockerConfig,
  OPENCODE_WORKFLOW_SANDBOX_TEMP: roots.dockerTemp,
}
const currentUserSid = "S-1-5-21-1000"
const goodAcl = {
  currentUserSid,
  currentIdentitySids: [currentUserSid],
  ownerSid: currentUserSid,
  protected: true,
  reparsePoint: false,
  descriptorSddl: "O:S-1-5-21-1000G:S-1-5-21-1000D:P(A;;FA;;;S-1-5-21-1000)(A;;FA;;;S-1-5-18)(A;;FA;;;S-1-5-32-544)",
  aces: [
    { sid: currentUserSid, allow: true, inherited: false, mask: 0x001f01ff },
    { sid: "S-1-5-18", allow: true, inherited: false, mask: 0x001f01ff },
    { sid: "S-1-5-32-544", allow: true, inherited: false, mask: 0x001f01ff },
  ],
}

beforeAll(async () => {
  await Promise.all(
    [
      deployment,
      workspaceParent,
      path.dirname(enginePath),
      runtimeSandbox,
      path.dirname(browserExecutablePath),
      ...Object.values(roots),
    ].map((directory) => fs.mkdir(directory, { recursive: true })),
  )
  await fs.writeFile(enginePath, "fake docker executable")
  await fs.writeFile(browserExecutablePath, "fake chromium executable")
  await fs.writeFile(archivePath, archiveBytes)
  await writeManifest(image)
})

afterAll(async () => {
  const remainingWorkspaces = await fs.readdir(workspaceParent)
  const remainingCapabilities = await fs.readdir(roots.preview)
  expect(remainingWorkspaces).toEqual([])
  expect(remainingCapabilities).toEqual([])
})

describe("production host smoke orchestration", () => {
  test("runs the pinned Docker preview through production Playwright and removes only its exact roots", async () => {
    const engine = new FakeEngine(image)
    const browser = fakeBrowser(WorkflowVisualHost.deterministicPng({ name: "smoke", width: 800, height: 600 }))

    const result = await runProductionHostSmoke(
      { environment, workspaceParent, timeoutMs: 10_000 },
      {
        aclProbe: () => structuredClone(goodAcl),
        engine,
        browserType: browser.type,
        browserExecutablePath,
        runID: () => "1".repeat(32),
        probeOrigin: async () => undefined,
      },
    )

    expect(result).toEqual({
      status: "ok",
      image,
      ingressSha256: "0".repeat(64),
      readySelector: "#ready",
      viewport: { width: 800, height: 600 },
      screenshotBytes: expect.any(Number),
      screenshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(result.screenshotBytes).toBeGreaterThan(8)
    expect(engine.sawPullNever).toBe(true)
    expect(engine.containerVisible).toBe(false)
    expect(engine.networkVisible).toBe(false)
    expect(browser.state.readySelector).toBe("#ready")
    expect(browser.state.browserClosed).toBe(true)
    expect(await fs.readdir(workspaceParent)).toEqual([])
    expect(await fs.readdir(roots.preview)).toEqual([])
  })

  test("stops Docker, closes Chromium, and removes exact roots when PNG validation fails", async () => {
    const engine = new FakeEngine(image)
    const browser = fakeBrowser(Uint8Array.from([1, 2, 3]))

    await expect(
      runProductionHostSmoke(
        { environment, workspaceParent, timeoutMs: 10_000 },
        {
          aclProbe: () => structuredClone(goodAcl),
          engine,
          browserType: browser.type,
          browserExecutablePath,
          runID: () => "2".repeat(32),
          probeOrigin: async () => undefined,
        },
      ),
    ).rejects.toThrow(/PNG/)

    expect(engine.containerVisible).toBe(false)
    expect(engine.networkVisible).toBe(false)
    expect(browser.state.browserClosed).toBe(true)
    expect(await fs.readdir(workspaceParent)).toEqual([])
    expect(await fs.readdir(roots.preview)).toEqual([])
  })

  test("rejects a manifest image mismatch before any Docker or workspace mutation", async () => {
    await writeManifest("127.0.0.1:5000/opencode/workflow-sandbox@sha256:" + "b".repeat(64))
    const engine = new FakeEngine(image)

    try {
      await expect(
        runProductionHostSmoke(
          { environment, workspaceParent, timeoutMs: 10_000 },
          {
            aclProbe: () => structuredClone(goodAcl),
            engine,
            browserType: fakeBrowser(WorkflowVisualHost.deterministicPng({ name: "smoke", width: 800, height: 600 })).type,
            browserExecutablePath,
            runID: () => "3".repeat(32),
            probeOrigin: async () => undefined,
          },
        ),
      ).rejects.toThrow(/manifest/i)
      expect(engine.invocations).toEqual([])
      expect(await fs.readdir(workspaceParent)).toEqual([])
      expect(await fs.readdir(roots.preview)).toEqual([])
    } finally {
      await writeManifest(image)
    }
  })

  test("rejects a broken protected-root ACL before creating smoke roots", async () => {
    const engine = new FakeEngine(image)

    await expect(
      runProductionHostSmoke(
        { environment, workspaceParent, timeoutMs: 10_000 },
        {
          aclProbe: () => ({ ...structuredClone(goodAcl), protected: false }),
          engine,
          browserType: fakeBrowser(WorkflowVisualHost.deterministicPng({ name: "smoke", width: 800, height: 600 })).type,
          browserExecutablePath,
          runID: () => "4".repeat(32),
          probeOrigin: async () => undefined,
        },
      ),
    ).rejects.toThrow(/ACL/)
    expect(engine.invocations).toEqual([])
    expect(await fs.readdir(workspaceParent)).toEqual([])
    expect(await fs.readdir(roots.preview)).toEqual([])
  })
})

class FakeEngine {
  readonly containerID = "c".repeat(64)
  readonly networkID = "d".repeat(64)
  readonly invocations: Array<{ readonly argv: readonly string[] }> = []
  readonly waiters: Array<() => void> = []
  containerName = ""
  networkName = ""
  containerLabels: Record<string, string> = {}
  networkLabels: Record<string, string> = {}
  containerVisible = false
  networkVisible = false
  containerRunning = false
  sawPullNever = false

  constructor(private readonly expectedImage: string) {}

  execute = async (input: { readonly argv: readonly string[] }) => {
    this.invocations.push(input)
    const [scope, action] = input.argv
    if (scope === "network" && action === "create") {
      this.networkName = input.argv.at(-1) ?? ""
      this.networkLabels = labels(input.argv)
      this.networkVisible = true
      return result({ stdout: this.networkID + "\n" })
    }
    if (scope === "network" && action === "inspect") {
      if (!this.networkVisible) return result({ exit: 1 })
      return result({
        stdout: JSON.stringify([
          { Id: this.networkID, Name: this.networkName, Internal: true, Driver: "bridge", Labels: this.networkLabels },
        ]),
      })
    }
    if (scope === "container" && action === "create") {
      this.containerName = valueAfter(input.argv, "--name")
      this.containerLabels = labels(input.argv)
      this.sawPullNever = valueAfter(input.argv, "--pull") === "never"
      if (!this.sawPullNever || !input.argv.includes(this.expectedImage)) throw new Error("unpinned Docker create")
      this.containerVisible = true
      return result({ stdout: this.containerID + "\n" })
    }
    if (scope === "container" && action === "start") {
      this.containerRunning = true
      return result()
    }
    if (scope === "container" && action === "inspect") {
      if (!this.containerVisible) return result({ exit: 1 })
      return result({
        stdout: JSON.stringify([
          {
            Id: this.containerID,
            Name: "/" + this.containerName,
            Config: { Labels: this.containerLabels },
            State: { Running: this.containerRunning, ExitCode: this.containerRunning ? 0 : 23 },
            HostConfig: { PortBindings: { "18080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } },
            NetworkSettings: { Ports: { "18080/tcp": [{ HostIp: "127.0.0.1", HostPort: "45123" }] } },
          },
        ]),
      })
    }
    if (scope === "container" && action === "wait") {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
      return result({ stdout: "23\n" })
    }
    if (scope === "container" && action === "logs") return result({ stdout: "smoke output" })
    if (scope === "container" && action === "kill") {
      this.containerRunning = false
      this.waiters.splice(0).forEach((resolve) => resolve())
      return result()
    }
    if (scope === "container" && action === "rm") {
      this.containerVisible = false
      return result()
    }
    if (scope === "network" && action === "rm") {
      this.networkVisible = false
      return result()
    }
    return result()
  }
}

function fakeBrowser(png: Uint8Array) {
  const state = { readySelector: "", browserClosed: false }
  return {
    state,
    type: {
      launch: async () => ({
        newContext: async () => ({
          route: async () => undefined,
          routeWebSocket: async () => undefined,
          newPage: async () => ({
            goto: async () => undefined,
            waitForSelector: async (selector: string) => {
              state.readySelector = selector
            },
            evaluate: async () => undefined,
            screenshot: async () => png,
          }),
          close: async () => undefined,
        }),
        close: async () => {
          state.browserClosed = true
        },
      }),
    },
  }
}

async function writeManifest(manifestImage: string) {
  const archive = await fs.readFile(archivePath)
  const engine = await fs.readFile(enginePath)
  const manifest = {
    schema: 1,
    image: manifestImage,
    engine: enginePath,
    engineSha256: createHash("sha256").update(engine).digest("hex"),
    base: "oven/bun@sha256:621f249399228db47cf34611ee662585e77e015250ed29d5d0932b2d3282f0b0",
    registry: "registry@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278",
    platform: "linux/amd64",
    archive: path.basename(archivePath),
    archiveSha256: createHash("sha256").update(archive).digest("hex"),
    dockerfileSha256: "e".repeat(64),
    supervisorSha256: "f".repeat(64),
    ingressSha256: "0".repeat(64),
  }
  await fs.writeFile(path.join(runtimeSandbox, "workflow-sandbox.manifest.json"), JSON.stringify(manifest) + "\n")
}

function labels(argv: readonly string[]) {
  return Object.fromEntries(valuesAfter(argv, "--label").map((value) => value.split("=", 2)))
}

function valuesAfter(values: readonly string[], flag: string) {
  return values.flatMap((value, index) =>
    value === flag && values[index + 1] !== undefined ? [values[index + 1]!] : [],
  )
}

function valueAfter(values: readonly string[], flag: string) {
  const found = valuesAfter(values, flag)
  if (found.length !== 1) throw new Error("expected one " + flag)
  return found[0]!
}

function result(overrides: Partial<{ exit: number; stdout: string; stderr: string; truncated: boolean }> = {}) {
  return { exit: 0, stdout: "", stderr: "", truncated: false, ...overrides }
}
'@

$driverSource = $driverSource.Replace("__SMOKE_MODULE__", $moduleSpecifier)
$driverSource = $driverSource.Replace("__VISUAL_MODULE__", $visualSpecifier)
$driverSource = $driverSource.Replace("__CASE_ROOT__", ($caseRoot | ConvertTo-Json -Compress))
[IO.File]::WriteAllText($driver, $driverSource, [Text.UTF8Encoding]::new($false))

$oldTemp = $env:TEMP
$oldTmp = $env:TMP
$oldBunCache = $env:BUN_INSTALL_CACHE_DIR
$oldBunRuntimeCache = $env:BUN_CACHE_DIR
try {
  $env:TEMP = $caseRoot
  $env:TMP = $caseRoot
  $env:BUN_INSTALL_CACHE_DIR = $caseRoot
  $env:BUN_CACHE_DIR = $caseRoot
  & $bun test $driver --timeout 30000
  if ($LASTEXITCODE -ne 0) { throw "Production host smoke tests failed with exit code $LASTEXITCODE" }
} finally {
  $env:TEMP = $oldTemp
  $env:TMP = $oldTmp
  $env:BUN_INSTALL_CACHE_DIR = $oldBunCache
  $env:BUN_CACHE_DIR = $oldBunRuntimeCache
  Remove-TestTreeLeafFirst -ApprovedRoot $testBase -Target $caseRoot
  if (-not $testRootExisted -and @(Get-ChildItem -LiteralPath $testBase -Force).Count -eq 0) {
    [IO.Directory]::Delete($testBase, $false)
  }
}
