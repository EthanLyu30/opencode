import { createHash, randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { PreviewPlan } from "../packages/core/src/workflow/preview-plan"
import { WorkflowVisualHost } from "../packages/core/src/workflow/visual-host"
import { Location } from "../packages/schema/src/location"
import { AbsolutePath } from "../packages/schema/src/schema"
import { Workflow } from "../packages/schema/src/workflow"
import { Docker } from "../packages/server/src/workflow/docker"
import { DockerProcessOwnership } from "../packages/server/src/workflow/docker-process-ownership"
import { HostRootPolicy } from "../packages/server/src/workflow/host-root-policy"
import { PlaywrightCapture } from "../packages/server/src/workflow/playwright"
import { ProcessOwnership } from "../packages/server/src/workflow/process-ownership"
import { ProductionHostRoots } from "../packages/server/src/workflow/production-host-roots"
import { ProductionHostRuntime } from "../packages/server/src/workflow/production-host-runtime"

const sha256Pattern = /^[a-f0-9]{64}$/
const imagePattern = /^(?:[a-z0-9][a-z0-9._/-]*|127\.0\.0\.1:5000\/[a-z0-9][a-z0-9._/-]*)@sha256:[a-f0-9]{64}$/
const manifestKeys = [
  "archive",
  "archiveSha256",
  "base",
  "dockerfileSha256",
  "engine",
  "engineSha256",
  "image",
  "ingressSha256",
  "platform",
  "registry",
  "schema",
  "supervisorSha256",
] as const
const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export interface SmokeInput {
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly workspaceParent: string
  readonly timeoutMs?: number
}

export interface SmokeDependencies {
  readonly aclProbe?: HostRootPolicy.Probe
  readonly engine?: Docker.Engine
  readonly browserType?: PlaywrightCapture.BrowserType
  readonly browserExecutablePath?: string
  readonly runID?: () => string
  readonly probeOrigin?: (input: {
    readonly origin: string
    readonly signal: AbortSignal
    readonly deadline: number
    readonly exited: Promise<number>
  }) => Promise<void>
}

export interface SmokeResult {
  readonly status: "ok"
  readonly image: string
  readonly ingressSha256: string
  readonly readySelector: "#ready"
  readonly viewport: { readonly width: 800; readonly height: 600 }
  readonly screenshotBytes: number
  readonly screenshotSha256: string
}

/**
 * Exercises the release-pinned Docker and Chromium adapters without invoking a
 * provider. Every mutable smoke leaf is created on D: and removed at an exact,
 * identity-checked boundary.
 */
export async function runProductionHostSmoke(
  input: SmokeInput,
  dependencies: SmokeDependencies = {},
): Promise<SmokeResult> {
  const environment = productionEnvironment(input.environment)
  const timeoutMs = positiveTimeout(input.timeoutMs ?? 60_000)
  const workspaceParent = await canonicalDDirectory(input.workspaceParent, "smoke workspace parent")
  const initial = ProductionHostRuntime.load(environment, {
    probe: dependencies.aclProbe,
    workspaceRoots: [workspaceParent],
  })
  initial.contract.policy.verifyAll()
  const release = await validateReleaseManifest(initial, environment)

  const runID = validateRunID((dependencies.runID ?? (() => randomBytes(16).toString("hex")))())
  const hostID = digest(`host\0${runID}`)
  const workspace = path.join(workspaceParent, `opencode-production-smoke-${runID}`)
  const capabilityRoot = path.join(initial.contract.roots.previewCapabilityRoot, hostID)
  const capabilityTemp = path.join(capabilityRoot, ".tmp")
  assertStrictDescendant(workspaceParent, workspace, "smoke workspace")
  assertStrictDescendant(initial.contract.roots.previewCapabilityRoot, capabilityRoot, "smoke capability")

  let browser: PlaywrightCapture.Runtime | undefined
  let ownership: ProcessOwnership.Service | undefined
  let identity: ProcessOwnership.Identity | undefined
  let process: ProcessOwnership.OwnedProcess | undefined
  let cleanupAuthority: HostRootPolicy.CleanupAuthority | undefined
  let cleanupPolicy: HostRootPolicy.ProductionPolicy | undefined
  let workspaceCreated = false
  let capabilityCreated = false
  let result: SmokeResult | undefined
  let failure: unknown
  const cleanupFailures: unknown[] = []
  const controller = new AbortController()
  const deadline = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    await fs.mkdir(workspace)
    workspaceCreated = true
    await writeSmokeWorkspace(workspace)
    await fs.mkdir(capabilityRoot)
    capabilityCreated = true
    cleanupPolicy = initial.contract.policy
    cleanupAuthority = initial.contract.policy.authorizeCleanupTarget({ target: capabilityRoot, workspace })
    await fs.mkdir(capabilityTemp)

    const runtime = ProductionHostRuntime.load(environment, {
      probe: dependencies.aclProbe,
      workspaceRoots: [workspace],
    })
    runtime.contract.policy.verifyAll()
    cleanupPolicy = runtime.contract.policy
    cleanupAuthority = runtime.contract.policy.authorizeCleanupTarget({ target: capabilityRoot, workspace })

    const plan = PreviewPlan.freeze({
      authority: "admission",
      location: Location.Ref.make({ directory: AbsolutePath.make(workspace) }),
      preview: { kind: "script", argv: ["bun", "run", "--no-env-file", "smoke"] },
    })
    identity = Object.freeze({
      workflowID: Workflow.ID.make(`wfl_production_smoke_${runID}`),
      stageID: Workflow.StageID.make(`wfs_production_smoke_${runID}`),
      attempt: 1,
      leaseOwner: `production-smoke-${runID}`,
      leaseExpiresAt: deadline,
      hostID: WorkflowVisualHost.HostID.make(hostID),
      nonce: digest(`nonce\0${runID}`),
    })
    ownership = DockerProcessOwnership.make({
      engine: dependencies.engine ?? Docker.production,
      config: runtime.dockerConfig,
      hostRoot: runtime.contract.roots.previewCapabilityRoot,
      relayIngress: dependencies.engine === undefined,
    })
    browser = PlaywrightCapture.productionRuntime({
      browserRoot: runtime.contract.roots.browserRuntimeRoot,
      tempRoot: runtime.contract.roots.browserCacheRoot,
      timeoutMs: Math.min(timeoutMs, 15_000),
      browserRuntimePolicy: runtime.contract.policy.verifyBrowserRuntimeRoot,
      browserCachePolicy: runtime.contract.policy.verifyBrowserCacheRoot,
      ...(dependencies.browserType === undefined ? {} : { browserType: dependencies.browserType }),
      ...(dependencies.browserExecutablePath === undefined
        ? {}
        : { browserExecutablePath: dependencies.browserExecutablePath }),
    })

    timer = setTimeout(() => controller.abort(new Error("Production host smoke timed out")), timeoutMs)
    process = await ownership.start({
      identity,
      plan,
      workspaceRoot: workspace,
      tempRoot: capabilityTemp,
      signal: controller.signal,
      deadline,
    })
    await (dependencies.probeOrigin ?? probeOwnedOrigin)({
      origin: process.origin,
      signal: controller.signal,
      deadline,
      exited: process.exited,
    })
    const viewport = { width: 800 as const, height: 600 as const }
    const bytes = await browser.capture({
      url: process.origin,
      viewport,
      readySelector: "#ready",
      allowedOrigins: [],
      signal: controller.signal,
    })
    validatePng(bytes)
    result = Object.freeze({
      status: "ok",
      image: release.image,
      ingressSha256: release.ingressSha256,
      readySelector: "#ready",
      viewport,
      screenshotBytes: bytes.byteLength,
      screenshotSha256: digest(bytes),
    })
  } catch (cause) {
    failure = cause
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
    if (browser !== undefined) {
      try {
        await browser.close()
      } catch (cause) {
        cleanupFailures.push(cause)
      }
    }
    if (ownership !== undefined && identity !== undefined && process !== undefined) {
      try {
        await ownership.stop({ identity, process })
      } catch (cause) {
        cleanupFailures.push(cause)
      }
    }
    if (capabilityCreated && cleanupAuthority !== undefined && cleanupPolicy !== undefined) {
      try {
        const verified = cleanupPolicy.verifyCleanupTarget(cleanupAuthority)
        await removeExactTree(verified, initial.contract.roots.previewCapabilityRoot)
      } catch (cause) {
        cleanupFailures.push(cause)
      }
    }
    if (workspaceCreated) {
      try {
        await removeExactTree(workspace, workspaceParent)
      } catch (cause) {
        cleanupFailures.push(cause)
      }
    }
  }
  if (cleanupFailures.length > 0) {
    const causes = failure === undefined ? cleanupFailures : [failure, ...cleanupFailures]
    throw new AggregateError(
      causes,
      "Production host smoke cleanup failed",
      failure === undefined ? {} : { cause: failure },
    )
  }
  if (failure !== undefined) throw failure
  if (result === undefined) throw new Error("Production host smoke completed without a result")
  return result
}

interface ReleaseManifest {
  readonly schema: 1
  readonly image: string
  readonly engine: string
  readonly engineSha256: string
  readonly base: string
  readonly registry: string
  readonly platform: "linux/amd64"
  readonly archive: string
  readonly archiveSha256: string
  readonly dockerfileSha256: string
  readonly supervisorSha256: string
}

async function validateReleaseManifest(
  runtime: ProductionHostRuntime.Runtime,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<ReleaseManifest> {
  const root = path.join(runtime.contract.roots.browserRuntimeRoot, "..", "sandbox")
  const sandboxRoot = await canonicalDDirectory(root, "workflow sandbox release")
  const manifestPath = path.join(sandboxRoot, "workflow-sandbox.manifest.json")
  const value: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"))
  if (!isRecord(value) || !sameKeys(value, manifestKeys))
    throw new TypeError("Workflow sandbox manifest shape is invalid")
  const manifest = value as unknown as ReleaseManifest
  if (
    manifest.schema !== 1 ||
    manifest.image !== environment.OPENCODE_WORKFLOW_SANDBOX_IMAGE ||
    manifest.engine !== environment.OPENCODE_WORKFLOW_SANDBOX_ENGINE ||
    manifest.platform !== "linux/amd64" ||
    !imagePattern.test(manifest.image) ||
    !imagePattern.test(manifest.base) ||
    !imagePattern.test(manifest.registry) ||
    !sha256Pattern.test(manifest.engineSha256) ||
    !sha256Pattern.test(manifest.archiveSha256) ||
    !sha256Pattern.test(manifest.dockerfileSha256) ||
    !sha256Pattern.test(manifest.ingressSha256) ||
    !sha256Pattern.test(manifest.supervisorSha256) ||
    manifest.archive !== `workflow-sandbox.${manifest.archiveSha256}.oci.tar`
  ) {
    throw new TypeError("Workflow sandbox manifest does not match the production contract")
  }
  const archivePath = path.join(sandboxRoot, manifest.archive)
  if (path.dirname(archivePath) !== sandboxRoot)
    throw new TypeError("Workflow sandbox manifest archive escapes its root")
  const [engineSha256, archiveSha256] = await Promise.all([hashFile(manifest.engine), hashFile(archivePath)])
  if (engineSha256 !== manifest.engineSha256 || archiveSha256 !== manifest.archiveSha256) {
    throw new TypeError("Workflow sandbox manifest release hash differs from disk")
  }
  return Object.freeze({ ...manifest })
}

function productionEnvironment(source: Readonly<Record<string, string | undefined>>) {
  return Object.freeze(
    Object.fromEntries(ProductionHostRoots.environmentNames.map((name) => [name, source[name]])) as Record<
      ProductionHostRoots.EnvironmentName,
      string | undefined
    >,
  )
}

async function writeSmokeWorkspace(workspace: string): Promise<void> {
  const packageJson = JSON.stringify({ private: true, scripts: { smoke: "bun server.js" } }) + "\n"
  const server = [
    "const port = Number(process.env.OPENCODE_PREVIEW_PORT)",
    'if (!Number.isSafeInteger(port)) throw new Error("missing preview port")',
    'const html = "<!doctype html><html><body><main id=\\"ready\\">production host smoke</main></body></html>"',
    'Bun.serve({ hostname: "0.0.0.0", port, fetch: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }) })',
    "await new Promise(() => {})",
    "",
  ].join("\n")
  await Promise.all([
    fs.writeFile(path.join(workspace, "package.json"), packageJson, { flag: "wx" }),
    fs.writeFile(path.join(workspace, "server.js"), server, { flag: "wx" }),
  ])
}

async function probeOwnedOrigin(input: {
  readonly origin: string
  readonly signal: AbortSignal
  readonly deadline: number
  readonly exited: Promise<number>
}): Promise<void> {
  const exited = input.exited.then(
    () => "exited" as const,
    () => "exited" as const,
  )
  while (!input.signal.aborted && Date.now() < input.deadline) {
    const state = await Promise.race([
      fetch(input.origin, { redirect: "manual", signal: AbortSignal.timeout(1_000) }).then(
        (response) => (response.status >= 200 && response.status < 400 ? ("ready" as const) : ("retry" as const)),
        () => "retry" as const,
      ),
      exited,
    ])
    if (state === "ready") return
    if (state === "exited") break
    await Promise.race([Bun.sleep(50), exited])
  }
  throw new Error("Production preview did not become ready before its deadline")
}

function validatePng(bytes: Uint8Array): void {
  if (bytes.byteLength <= pngSignature.byteLength || pngSignature.some((byte, index) => bytes[index] !== byte)) {
    throw new TypeError("Production Playwright capture did not return a PNG")
  }
}

async function removeExactTree(targetInput: string, approvedParentInput: string): Promise<void> {
  const approvedParent = await canonicalDDirectory(approvedParentInput, "cleanup parent")
  const target = await canonicalDDirectory(targetInput, "cleanup target")
  assertStrictDescendant(approvedParent, target, "cleanup target")
  const directories: string[] = [target]
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index]!
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name)
      const stat = await fs.lstat(child)
      if (stat.isSymbolicLink()) throw new TypeError(`Refusing cleanup through a reparse point: ${child}`)
      if (stat.isDirectory()) directories.push(child)
      else if (stat.isFile()) await fs.unlink(child)
      else throw new TypeError(`Refusing cleanup of a non-regular filesystem entry: ${child}`)
    }
  }
  for (const directory of directories.toReversed()) await fs.rmdir(directory)
}

async function canonicalDDirectory(value: string, label: string): Promise<string> {
  if (!path.win32.isAbsolute(value) || !/^D:\\/i.test(value))
    throw new TypeError(`${label} must be an absolute D-drive directory`)
  const resolved = path.resolve(value)
  const canonical = await fs.realpath(resolved)
  const stat = await fs.lstat(canonical)
  if (resolved !== canonical || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError(`${label} must be a canonical directory without aliases`)
  }
  return canonical
}

function assertStrictDescendant(parent: string, child: string, label: string): void {
  const relative = path.relative(parent, child)
  if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new TypeError(`${label} is outside its approved parent`)
  }
}

async function hashFile(file: string): Promise<string> {
  return digest(await fs.readFile(file))
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Smoke timeout must be a positive integer")
  return value
}

function validateRunID(value: string): string {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new TypeError("Smoke run ID must be 32 lowercase hex characters")
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...expected].toSorted())
}

function parseArguments(argv: readonly string[]) {
  let workspaceParent: string | undefined
  let timeoutMs: number | undefined
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (value === undefined) throw new TypeError(`Missing value for ${name}`)
    if (name === "--workspace-parent") workspaceParent = value
    else if (name === "--timeout-ms") timeoutMs = Number(value)
    else throw new TypeError(`Unknown production smoke option: ${name}`)
  }
  if (workspaceParent === undefined) throw new TypeError("--workspace-parent is required")
  return { workspaceParent, timeoutMs }
}

if (import.meta.main) {
  const options = parseArguments(Bun.argv.slice(2))
  const result = await runProductionHostSmoke({
    environment: process.env,
    workspaceParent: options.workspaceParent,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
