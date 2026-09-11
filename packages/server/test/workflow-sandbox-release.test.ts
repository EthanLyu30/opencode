import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const serverRoot = path.resolve(import.meta.dir, "..")
const repositoryRoot = path.resolve(serverRoot, "..", "..")
const dockerfilePath = path.join(serverRoot, "sandbox", "Dockerfile")
const supervisorPath = path.join(serverRoot, "sandbox", "opencode-preview-supervisor.ts")
const releaseScriptPath = path.join(repositoryRoot, "scripts", "build-workflow-sandbox.ps1")
const releaseAclTestPath = path.join(repositoryRoot, "scripts", "test-build-workflow-sandbox.ps1")

describe("reviewed workflow sandbox release", () => {
  test("pins the exact Bun base and runs the shared image as uid 65532", async () => {
    const dockerfile = await fs.readFile(dockerfilePath, "utf8")

    expect(dockerfile).toContain(
      "FROM oven/bun@sha256:621f249399228db47cf34611ee662585e77e015250ed29d5d0932b2d3282f0b0",
    )
    expect(dockerfile).toContain("USER 65532:65532")
    expect(dockerfile).toContain("COPY --chmod=0555 opencode-preview-supervisor.ts")
    expect(dockerfile).toContain("ln -sf /usr/local/bin/bun /usr/local/bin/node")
    expect(dockerfile).not.toMatch(/\b(?:ARG|ENV)\s+[^\r\n]*(?:KEY|TOKEN|SECRET)/i)
    expect(dockerfile).not.toMatch(/COPY\s+\.\s+/i)
    expect(dockerfile).not.toContain(":latest")
  })

  test("ships a bounded loopback-only supervisor without a shell command boundary", async () => {
    const supervisor = await fs.readFile(supervisorPath, "utf8")

    expect(supervisor).toContain('listen.host !== "0.0.0.0"')
    expect(supervisor).toContain('target.host !== "127.0.0.1"')
    expect(supervisor).toContain("Bun.spawn(runtime")
    expect(supervisor).toContain("Bun.serve")
    expect(supervisor).toContain("AbortSignal.timeout")
    expect(supervisor).not.toContain("shell: true")
    expect(supervisor).not.toMatch(/https?:\/\/(?:localhost|[a-z])/i)
  })

  test("relays one real request to the fixed loopback target and returns the child exit", async () => {
    const temporaryParent = path.join(repositoryRoot, ".tmp-workflow-sandbox-release")
    await fs.mkdir(temporaryParent, { recursive: true })
    const temporary = await fs.mkdtemp(path.join(temporaryParent, "case-"))
    const target = path.join(temporary, "target.ts")
    await fs.writeFile(
      target,
      [
        'const server = Bun.serve({ hostname: "127.0.0.1", port: 18_081, fetch(request) {',
        '  if (new URL(request.url).pathname === "/redirect") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1:18081/final" } })',
        "  setTimeout(() => server.stop(true).then(() => process.exit(0)), 100)",
        '  return Response.json({ path: new URL(request.url).pathname, marker: request.headers.get("x-marker") })',
        "} })",
        "await new Promise(() => undefined)",
      ].join("\n"),
    )
    const bun = process.execPath
    const processHandle = Bun.spawn(
      [bun, supervisorPath, "--listen", "0.0.0.0:18080", "--target", "127.0.0.1:18081", "--", bun, target],
      { stdout: "pipe", stderr: "pipe" },
    )
    try {
      const redirect = await fetchUntilReady("http://127.0.0.1:18080/redirect", { redirect: "manual" })
      expect(redirect.headers.get("location")).toBe("http://127.0.0.1:18080/final")
      const response = await fetchUntilReady("http://127.0.0.1:18080/visual-check", {
        headers: { "x-marker": "sandbox-release" },
      })
      expect(await response.json()).toEqual({ path: "/visual-check", marker: "sandbox-release" })
      expect(await processHandle.exited).toBe(0)
    } finally {
      if (processHandle.exitCode === null) processHandle.kill()
      await processHandle.exited.catch(() => undefined)
      await fs.rm(temporary, { recursive: true, force: true })
      const remaining = await fs.readdir(temporaryParent)
      if (remaining.length === 0) await fs.rmdir(temporaryParent)
    }
  }, 15_000)

  test("release script proves D-backed Docker state and records a local digest plus OCI hash", async () => {
    const script = await fs.readFile(releaseScriptPath, "utf8")

    expect(script).toContain("registry@sha256:46faa9a1ae6813194b53921a370f2f4f8c5e1aae228a89bceafef5847a6a3278")
    expect(script).toContain("127.0.0.1:5000/opencode/workflow-sandbox@sha256:")
    expect(script).toContain('@("network", "create", "--driver", "bridge", $registryNetwork)')
    expect(script).not.toContain('@("network", "create", "--driver", "bridge", "--internal", $registryNetwork)')
    expect(script).toContain("--pull=never")
    expect(script).toContain('"--read-only"')
    expect(script).toContain('"--cap-drop", "ALL"')
    expect(script).toContain('"--security-opt", "no-new-privileges=true"')
    expect(script).toContain("docker_data.vhdx")
    expect(script).toContain("ext4.vhdx")
    expect(script).toContain("engineSha256")
    expect(script).toContain("Get-FileHash")
    expect(script).toContain("workflow-sandbox.oci.tar")
    expect(script).toContain('"workflow-sandbox.$archiveSha256.oci.tar"')
    expect(script).toContain("Publish-ImmutableFile")
    expect(script).toContain("RepoDigests")
    expect(script).toContain('"index.json"')
    expect(script).toContain("Assert-OciDigest")
    expect(script).toContain("oci-mediatypes=true")
    expect(script).toContain('"DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"')
    expect(script).toContain('SetEnvironmentVariable($name, $null, "Process")')
    expect(script).toContain('$env:DOCKER_CONTEXT = "default"')
    expect(script).toContain('"--builder", "default"')
    expect(script).toContain('"BUILDX_BUILDER", "BUILDKIT_HOST", "BUILDX_CONFIG"')
    expect(script).toContain('"BUN_INSTALL_CACHE_DIR"')
    expect(script).toContain("$env:BUN_INSTALL_CACHE_DIR = $bunCache")
    expect(script).toContain("$env:PATH = $releasePath")
    expect(script).toContain('"PATH"')
    expect(script).toContain("$preserveStage")
    expect(script).toContain("$cursor.Directory")
    expect(script).toContain("D:\\OpenCode-Toolchain\\bun-1.3.14\\bun-windows-x64\\bun.exe")
    expect(script).toContain("Assert-StagedRelease")
    expect(script).toContain("Restore-ManifestPublication")
    expect(script).toContain("Get-PathIdentity")
    expect(script).toContain("Assert-NoReparseTree")
    expect(script).toContain("Assert-NoUnknownReleaseState")
    expect(script).toContain("Assert-DockerResourceAbsent")
    expect(script).toContain("Assert-ReleaseSource")
    expect(script).toContain("Docker release engine identity changed before spawn")
    expect(script).toContain("Workflow sandbox release source changed during the build")
    expect(script).toContain("[IO.File]::Copy($sourceDockerfile")
    expect(script).toContain("[IO.File]::Copy($sourceSupervisor")
    expect(script).toContain("$stagedContext")
    expect(script).toContain("Workflow sandbox release and cleanup both failed")
    expect(script).toContain("Workflow sandbox release cleanup could not prove resource absence")
    expect(script).toContain("Assert-StrictDescendant -Parent $dockerTemporary -Child $bunCache")
    expect(script).toContain("Assert-StrictDescendant -Parent $stageRoot -Child $registryStorage")
    expect(script).toContain('ApprovedDockerRoot = "D:\\Applications\\Docker"')
    expect(script).toContain('ApprovedDockerDataRoot = "D:\\Applications\\DockerWSL"')
    expect(script).toContain('Join-Path $customRoot "disk\\docker_data.vhdx"')
    expect(script).toContain('Join-Path $resolvedBase "ext4.vhdx"')
    expect(script).toContain("Test-ContainsPath")
    expect(script).toContain("OCI descriptor blob hash differs from its digest")
    expect(script).toContain('"C:\\Windows\\System32\\tar.exe"')
    expect(script).toContain('imageLayoutVersion -cne "1.0.0"')
    expect(script).toContain('platform.os -cne "linux"')
    expect(script).toContain('platform.architecture -cne "amd64"')
    expect(script).not.toMatch(/Remove-Item[^\r\n]*-Recurse/i)
    expect(script).not.toContain(":latest")
  })

  test("fails closed before mutation when a protected root ACL or frozen Docker leaf is invalid", async () => {
    if (process.platform !== "win32") return
    const powershell = process.env.POWERSHELL_EXE ?? "pwsh.exe"
    const child = Bun.spawn([powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", releaseAclTestPath], {
      cwd: repositoryRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    expect(exitCode, `${stdout}\n${stderr}`).toBe(0)
    expect(stdout).toContain(
      "PASS: protected build roots and frozen Docker leaves fail closed before mutation or Docker",
    )
  }, 30_000)
})

async function fetchUntilReady(url: string, init: RequestInit) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(500) })
    } catch {
      await Bun.sleep(25)
    }
  }
  throw new Error("preview supervisor did not become ready")
}
