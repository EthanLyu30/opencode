import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { pathToFileURL } from "node:url"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { FileIdentity, requireDPath, type EngineSession } from "./contracts"
import { fileIdentity } from "./storage"
import { revalidateSession } from "./preflight"
import { makeDockerRunner } from "./docker"
import { readControllerJson, type ReadinessIndex } from "./readiness"
import { makeLinuxBackend } from "./linux-backend"
import { makeLinuxBrowser, validateBrowserProbe, loadLinuxBrowserRelease } from "./browser"
import { startLinuxPreview } from "./preview"
import {
  decodeTaskExecutionProfile,
  decodeEvaluationIdentity,
  type TaskExecutionProfile,
  CheckCommand,
  DependencyResolution,
  EvaluationIdentityV2,
  safePath,
} from "../corpus/evaluation-profile"
import { captureCandidate } from "../evaluator/independent/snapshot"
import { makeLinuxEvaluationHost, authorizeLinuxHost, type LinuxAuthority } from "./evaluation-host"
import { makeControllerFactsObserver, type RequirementProbePlan, type InteractionAssertion } from "./controller-facts"
import { evaluateLinux } from "./linux-evaluator"
import { resolveTaskDependency, type ResolvedImages } from "./dependencies"
import { loadEvaluationBundle, directRoot } from "../corpus/evaluation-bundle"
import { finalizeLinuxCorpus, type ExecutionPlan, type ReferencePlan } from "../corpus/evaluation-finalize"
import { calibrateLinuxCorpus } from "./calibration"
import {
  acceptLinuxEngine,
  restoreEngineReceipt,
  type EngineReceipt,
  type ProjectAcceptanceEvidence,
} from "./engine-evidence"
import {
  loadHostIsolationAdapter,
  verifyBinaryCapabilities,
  type CapabilityReceipt,
  type PublicMcpConnection,
  type HostIsolationAdapter,
  makeBrowserIsolationRunner,
} from "./capability"
import { makePublicToolHost } from "./public-tools"
import { startPublicToolLoopback } from "./mcp-server"
import { publishImmutable } from "../offline/atomic"
import { bindEvidenceFile } from "../evaluator/evidence"
import { FixtureReply } from "./fixture-provider"
import { Sha256 } from "../schema"
import { verifyControllerIdentity } from "./controller-identity"
import {
  createDependencyAuditors,
  auditDependencySet,
  stopDependencyAuditors,
  type DependencyAuditSet,
} from "./dependency-auditors"
import { verifyBinaryBuildRecords } from "./binary-build"
import { observeBrowserFonts } from "./fonts"

type Profiles = Parameters<typeof makeLinuxBackend>[0]["profiles"]
export async function dispatchAcceptanceProbe<T>(input: {
  mode: "node" | "pdf" | "browser"
  browser: () => Promise<T>
  linux: () => Promise<T>
}) {
  return input.mode === "browser" ? input.browser() : input.linux()
}
const Strings = Schema.Array(Schema.String)
const Modes = Schema.Record(Schema.String, Schema.Literals(["node", "browser", "pdf"]))
const Build = Schema.Struct({
  identity: EvaluationIdentityV2,
  candidate: Schema.Struct({
    archiveFile: Schema.String,
    archiveSha256: Sha256,
    candidateSha256: Sha256,
    configSha256: Sha256,
  }),
  profileSha256: Sha256,
  timeoutMs: Schema.Literal(300000),
  commands: Schema.Array(CheckCommand),
  dependency: DependencyResolution,
})
const Arm = Schema.Struct({
  armID: Schema.Literals(["A", "B", "C", "D", "E"]),
  campaignID: Schema.String,
  runID: Schema.String,
  binary: Schema.Struct({
    runtime: Schema.Literals(["modified", "upstream"]),
    executable: Schema.String,
    version: Schema.String,
    sha256: Sha256,
  }),
  roots: Schema.Struct({
    runRoot: Schema.String,
    repo: Schema.String,
    data: Schema.String,
    config: Schema.String,
    cache: Schema.String,
    temp: Schema.String,
    output: Schema.String,
  }),
  prompt: Schema.String,
  referenceFiles: Strings,
  brokerOrigin: Schema.String,
  brokerGrant: Schema.String,
  grantExpiresAt: Schema.Finite,
  budget: Schema.Struct({
    aggregateInputTokens: Schema.Int,
    aggregateOutputTokens: Schema.Int,
    maxToolCalls: Schema.Int,
    maxRetries: Schema.Int,
    maxDurationMs: Schema.Int,
  }),
})
// This is preparation data, not executable adapters or a source of expected scores.
const Config = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  browser: Schema.Struct({
    root: Schema.String,
    helper: FileIdentity,
    fonts: Schema.NonEmptyArray(FileIdentity),
    fontRegistrySha256: Sha256,
  }),
  profiles: Schema.Array(
    Schema.Struct({
      profile: Schema.Unknown,
      outputs: Strings,
      probeModes: Schema.optionalKey(Modes),
      service: Schema.optionalKey(
        Schema.Struct({
          entry: Schema.String,
          port: Schema.Int,
          policy: Schema.Struct({ methods: Strings, paths: Strings }),
        }),
      ),
    }),
  ),
  projects: Schema.Array(
    Schema.Struct({ kind: Schema.Literals(["chart", "http", "pdf"]), build: Build, probe: Schema.Unknown }),
  ),
  capabilities: Schema.Array(
    Schema.Struct({
      armID: Schema.Literals(["A", "B", "C", "D", "E"]),
      binary: FileIdentity,
      cases: Schema.Array(
        Schema.Struct({
          kind: Schema.Literals(["visual", "coding"]),
          input: Arm,
          checks: Schema.optionalKey(Schema.Unknown),
          scripts: Schema.Struct({
            main: Schema.NonEmptyArray(FixtureReply),
            readonly: Schema.NonEmptyArray(FixtureReply),
          }),
          profile: Schema.Unknown,
          outputs: Strings,
        }),
      ),
    }),
  ),
  corpus: Schema.Struct({
    authoredRoot: Schema.String,
    outputRoot: Schema.String,
    executionPlans: Schema.Record(
      Schema.String,
      Schema.Struct({ outputs: Strings, probeModes: Modes, previewEntry: Schema.NullOr(Schema.String) }),
    ),
    requirementPlans: Schema.Record(Schema.String, Schema.Unknown),
    interactionAssertions: Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ id: Schema.String, observation: Schema.String, value: Schema.Unknown })),
    ),
    referencePlans: Schema.Record(
      Schema.String,
      Schema.Struct({
        mode: Schema.Literals(["retained-source", "correct-control"]),
        sourceSha256: Sha256,
        candidateSha256: Sha256,
        visualPolicy: Schema.Struct({
          masks: Schema.Array(
            Schema.Struct({ x: Schema.Finite, y: Schema.Finite, width: Schema.Finite, height: Schema.Finite }),
          ),
          tolerance: Schema.Finite,
        }),
      }),
    ),
    references: Schema.Record(
      Schema.String,
      Schema.Struct({ sourceRoot: Schema.String, identity: EvaluationIdentityV2 }),
    ),
  }),
})
export function decodeLinuxRuntimeConfig(input: unknown) {
  const value = Schema.decodeUnknownSync(Config)(input, { onExcessProperty: "error" })
  const profiles = value.profiles.map((v) => ({ ...v, profile: decodeTaskExecutionProfile(v.profile) }))
  const projects = value.projects.map((v) => {
    validateBrowserProbe(v.probe)
    return { ...v, probe: v.probe }
  })
  const capabilities = value.capabilities.map((v) => ({
    ...v,
    cases: v.cases.map((c) => ({ ...c, profile: decodeTaskExecutionProfile(c.profile) })),
  }))
  for (const v of profiles) {
    v.outputs.forEach(safePath)
    if (v.service) {
      safePath(v.service.entry)
      if (v.service.port < 1024 || v.service.port > 65535) throw new TypeError("TASK24_RUNTIME_SERVICE_PORT")
    }
  }
  for (const c of capabilities) for (const v of c.cases) Object.values(v.input.roots).forEach(requireDPath)
  for (const v of Object.values(value.corpus.references)) requireDPath(v.sourceRoot)
  return {
    ...value,
    profiles,
    projects,
    capabilities,
    corpus: {
      ...value.corpus,
      requirementPlans: value.corpus.requirementPlans as Readonly<Record<string, readonly RequirementProbePlan[]>>,
    },
  }
}
export async function openLinuxRuntime(session: EngineSession) {
  const state = await revalidateSession(session)
  if (state.manifest.phase !== "accept") throw new TypeError("TASK24_RUNTIME_ACCEPT_PHASE")
  const manifest = state.manifest
  const artifact = (id: string) => {
    const a = manifest.artifacts.find((a) => a.id === id)
    if (!a || !a.path) throw new TypeError("TASK24_RUNTIME_ARTIFACT_MISSING")
    return a
  }
  await verifyControllerIdentity(manifest)
  const configArtifact = artifact("runtime-config")
  if ((await fileIdentity(configArtifact.path!)).sha256 !== configArtifact.sha256)
    throw new TypeError("TASK24_RUNTIME_CONFIG_STALE")
  const config = decodeLinuxRuntimeConfig(await readControllerJson(configArtifact.path!))
  let isolation: HostIsolationAdapter | undefined
  async function ensureIsolation() {
    return (isolation ??= await loadHostIsolationAdapter({
      session,
      file: await fileIdentity(artifact("host-isolation").path!),
    }))
  }
  const dependencies = artifact("dependencies"),
    original = (await readControllerJson(dependencies.path!)) as ResolvedImages
  if (
    sha256Text(canonicalJson(original)) !== dependencies.sha256 ||
    original.schemaVersion !== 2 ||
    original.platform !== `linux/${manifest.architecture}` ||
    original.tasks.length !== 16 ||
    new Set(original.tasks.map((t) => t.taskID)).size !== 16 ||
    original.tasks.some(
      (t) =>
        t.assurance !== "linux-attested" || !manifest.artifacts.some((a) => a.kind === "image" && a.image === t.image),
    )
  )
    throw new TypeError("TASK24_RUNTIME_DEPENDENCIES")
  // The accept manifest freezes the original prepare metadata. Rebinding is local, never persisted over it.
  const images = { ...original, manifestSha256: session.manifestSha256 }
  const auditorFile = path.join(manifest.roots.evidence, "linux-dependency-auditors.json")
  let auditors: DependencyAuditSet | undefined = (await fs.lstat(auditorFile).catch(() => null))
    ? ((await readControllerJson(auditorFile)) as DependencyAuditSet)
    : undefined
  const identityGuard = async () => {
    await revalidateSession(session)
    await verifyControllerIdentity(manifest)
    await verifyRuntimeFiles()
  }
  const guard = async () => {
    await identityGuard()
    if (!auditors) throw new TypeError("TASK24_DEPENDENCY_AUDITORS_REQUIRED")
    await auditDependencySet({ session, runner, guard: identityGuard, images, set: auditors })
  }
  const runner = makeDockerRunner({
    request: state.inspection.request,
    session,
    guard: async () => {
      await revalidateSession(session)
    },
  })
  async function verifyRuntimeFiles() {
    await verifyBinaryBuildRecords({ manifest })
    loadLinuxBrowserRelease(config.browser.root, manifest.artifacts.find((a) => a.id === "browser")!.sha256)
    if ((await fileIdentity(configArtifact.path!)).sha256 !== configArtifact.sha256)
      throw new TypeError("TASK24_RUNTIME_CONFIG_STALE")
    if ((await fileIdentity(dependencies.path!)).sha256 !== dependencies.sha256)
      throw new TypeError("TASK24_RUNTIME_DEPENDENCIES_STALE")
    const fonts = await observeBrowserFonts(manifest)
    if (
      canonicalJson(fonts.files) !== canonicalJson(config.browser.fonts) ||
      fonts.registrySha256 !== config.browser.fontRegistrySha256
    )
      throw new TypeError("TASK24_RUNTIME_FONTS_STALE")
    if (fonts.fontSha256 !== manifest.artifacts.find((a) => a.id === "fonts")?.sha256)
      throw new TypeError("TASK24_RUNTIME_FONT_BINDING")
    if (
      canonicalJson(await fileIdentity(config.browser.helper.path)) !== canonicalJson(config.browser.helper) ||
      config.browser.helper.sha256 !== manifest.artifacts.find((a) => a.id === "browser-helper")?.sha256
    )
      throw new TypeError("TASK24_RUNTIME_BROWSER_HELPER")
  }
  await verifyRuntimeFiles()
  function browser(evidenceRoot: string, references: string) {
    const base = loadLinuxBrowserRelease(
      config.browser.root,
      manifest.artifacts.find((a) => a.id === "browser")!.sha256,
    )
    return makeLinuxBrowser({
      release: {
        base,
        helper: config.browser.helper,
        fontSha256: manifest.artifacts.find((a) => a.id === "fonts")!.sha256,
      },
      previewRegistry: {
        get() {
          throw new TypeError("TASK24_RUNTIME_PREVIEW_UNREGISTERED")
        },
      },
      roots: { temp: manifest.roots.temp, evidence: evidenceRoot, references },
      env: {
        SystemRoot: "C:\\Windows",
        PATH: "C:\\Windows\\System32",
        HOME: manifest.roots.config,
        USERPROFILE: manifest.roots.config,
        XDG_CACHE_HOME: manifest.roots.temp,
        XDG_CONFIG_HOME: manifest.roots.config,
      },
      requirementPlans: config.corpus.requirementPlans,
      async runner(lease) {
        if (!isolation) throw new TypeError("TASK24_BROWSER_OS_ISOLATION_REQUIRED")
        return makeBrowserIsolationRunner({
          session,
          adapter: isolation,
          helper: config.browser.helper,
          browser: await fileIdentity(base.browserExecutable),
          node: await fileIdentity(base.nodeExecutable),
          cwd: manifest.roots.temp,
          env: {
            SystemRoot: "C:\\Windows",
            PATH: "C:\\Windows\\System32",
            HOME: manifest.roots.config,
            USERPROFILE: manifest.roots.config,
            APPDATA: manifest.roots.config,
            LOCALAPPDATA: manifest.roots.temp,
            TEMP: manifest.roots.temp,
            TMP: manifest.roots.temp,
            NODE_DISABLE_COMPILE_CACHE: "1",
          },
          previewID: lease.previewID,
          previewURL: lease.url,
        })
      },
    })
  }
  function backend(profiles: Profiles, evidenceRoot = manifest.roots.evidence) {
    return makeLinuxBackend({
      session,
      runner,
      guard: identityGuard,
      images,
      profiles,
      evidenceRoot,
      async taskGuard(taskID) {
        if (!auditors) throw new TypeError("TASK24_DEPENDENCY_AUDITORS_REQUIRED")
        await auditDependencySet({ session, runner, guard: identityGuard, images, set: auditors, taskID })
      },
    })
  }
  async function captureReference(
    profile: TaskExecutionProfile,
    sourceRoot: string,
    rawIdentity: EvaluationIdentityV2,
    outputs: readonly string[],
  ) {
    await guard()
    const work = await fs.mkdtemp(path.join(manifest.roots.temp, "reference-"))
    const raw = backend([{ profile, outputs }]),
      web = browser(manifest.roots.evidence, sourceRoot)
    try {
      const snapshot = await captureCandidate({ sourceRoot, workRoot: path.join(work, "snapshot"), profile })
      const identity = decodeEvaluationIdentity({
        ...rawIdentity,
        taskID: profile.taskID,
        profileSha256: sha256Text(canonicalJson(profile)),
        candidateSha256: snapshot.candidateSha256,
      })
      const dep = resolveTaskDependency({ profile, images })
      if (dep.kind !== "ready") throw new TypeError("TASK24_RUNTIME_REFERENCE_DEPENDENCY")
      const common = { identity, candidate: snapshot, profileSha256: identity.profileSha256, timeoutMs: 30000 }
      const built = await raw.build({ ...common, timeoutMs: 300000, commands: profile.checks, dependency: dep.value })
      if (built.payload.kind !== "ok" || !profile.preview) throw new TypeError("TASK24_RUNTIME_REFERENCE_BUILD")
      const source = await raw.previewSource({ ...common, build: built.payload.build, preview: profile.preview })
      const lease = await startLinuxPreview({
        source,
        policy: { methods: ["GET", "HEAD"], paths: source.files.map((f) => "/" + f.path) },
        guard,
        signal: new AbortController().signal,
      })
      try {
        web.register(identity, lease)
        const captures = []
        for (const viewportID of ["mobile", "tablet", "desktop"] as const)
          captures.push({
            identity,
            capture: await web.runtime.capture({
              runID: identity.runID,
              previewID: lease.previewID,
              previewURL: lease.url + profile.preview.entry,
              viewportID,
              readySelector: "body",
              interactionScriptID: profile.preview.interaction,
              timeoutMs: 30000,
              signal: new AbortController().signal,
            }),
          })
        return captures
      } finally {
        await lease.stop()
      }
    } finally {
      await raw.dispose()
      await directRoot(work)
      if (path.dirname(work) !== manifest.roots.temp || !path.basename(work).startsWith("reference-"))
        throw new TypeError("TASK24_RUNTIME_CLEANUP")
      await fs.rm(work, { recursive: true })
    }
  }
  const capabilities: CapabilityReceipt[] = []
  async function verifyCapabilities() {
    if (
      config.capabilities.length !== 5 ||
      config.capabilities
        .map((c) => c.armID)
        .sort()
        .join("") !== "ABCDE"
    )
      throw new TypeError("TASK24_RUNTIME_CAPABILITY_COVERAGE")
    const isolation = await ensureIsolation()
    for (const c of config.capabilities) {
      const result = await verifyBinaryCapabilities({
        binary: c.binary,
        armID: c.armID,
        session,
        isolation,
        cases: c.cases,
        publicTools: {
          async open(item) {
            const entry = c.cases.find((v) => v === item)
            if (!entry) throw new TypeError("TASK24_RUNTIME_TOOL_CASE")
            const profile = decodeTaskExecutionProfile(entry.profile),
              root = await fs.mkdtemp(path.join(manifest.roots.temp, "capability-")),
              raw = backend([{ profile, outputs: entry.outputs }]),
              web = browser(manifest.roots.evidence, root)
            const lifecycle = new AbortController()
            let readonly = false,
              current: Awaited<ReturnType<typeof snapshotRequest>> | undefined,
              lease: Awaited<ReturnType<typeof startLinuxPreview>> | undefined
            async function snapshotRequest() {
              const snapshot = await captureCandidate({
                sourceRoot: entry!.input.roots.repo,
                workRoot: path.join(root, randomBytes(16).toString("hex")),
                profile,
              })
              const identity = decodeEvaluationIdentity({
                ...config.projects[0]!.build.identity,
                runID: entry!.input.runID,
                attemptID: "capability-" + randomBytes(16).toString("hex"),
                taskID: profile.taskID,
                profileSha256: sha256Text(canonicalJson(profile)),
                candidateSha256: snapshot.candidateSha256,
              })
              return { identity, candidate: snapshot, profileSha256: identity.profileSha256, timeoutMs: 30000 }
            }
            const tools = makePublicToolHost({
              workspace: entry.input.roots.repo,
              profile,
              maxCalls: entry.input.budget.maxToolCalls,
              signal: lifecycle.signal,
              async guard() {
                lifecycle.signal.throwIfAborted()
                await guard()
                lifecycle.signal.throwIfAborted()
              },
              backend: {
                async check(id) {
                  current = await snapshotRequest()
                  const dep = resolveTaskDependency({ profile, images })
                  if (dep.kind !== "ready") throw new TypeError("TASK24_PUBLIC_DEPENDENCY")
                  if (!profile.checks.some((c) => c.id === id)) throw new TypeError("TASK24_PUBLIC_COMMAND")
                  const build = await raw.build({
                    ...current,
                    timeoutMs: 300000,
                    commands: profile.checks,
                    dependency: dep.value,
                  })
                  return {
                    status: build.payload.kind,
                    commands: build.payload.kind === "ok" ? build.payload.commands : [],
                  }
                },
                async preview(entry) {
                  if (!current || !profile.preview || entry !== profile.preview.entry)
                    throw new TypeError("TASK24_PUBLIC_PREVIEW")
                  const dep = resolveTaskDependency({ profile, images })
                  if (dep.kind !== "ready") throw new TypeError("TASK24_PUBLIC_DEPENDENCY")
                  const built = await raw.build({
                    ...current,
                    timeoutMs: 300000,
                    commands: profile.checks,
                    dependency: dep.value,
                  })
                  if (built.payload.kind !== "ok") throw new TypeError("TASK24_PUBLIC_BUILD")
                  if (lease) await lease.stop()
                  const source = await raw.previewSource({
                    ...current,
                    build: built.payload.build,
                    preview: profile.preview,
                  })
                  lease = await startLinuxPreview({
                    source,
                    policy: { methods: ["GET", "HEAD"], paths: source.files.map((f) => "/" + f.path) },
                    guard,
                    signal: lifecycle.signal,
                  })
                  web.register(current.identity, lease)
                  return { previewID: lease.previewID }
                },
                async capture(previewID, viewport) {
                  if (
                    !current ||
                    !lease ||
                    lease.previewID !== previewID ||
                    !["mobile", "tablet", "desktop"].includes(viewport) ||
                    !profile.preview
                  )
                    throw new TypeError("TASK24_PUBLIC_CAPTURE")
                  const result = await web.runtime.capture({
                    runID: current.identity.runID,
                    previewID,
                    previewURL: lease.url + profile.preview.entry,
                    viewportID: viewport as "mobile" | "tablet" | "desktop",
                    readySelector: "body",
                    interactionScriptID: profile.preview.interaction,
                    timeoutMs: 30000,
                    signal: lifecycle.signal,
                  })
                  return {
                    screenshotSha256: result.screenshotSha256,
                    evidenceSha256: result.evidenceSha256,
                    identity: { previewID, viewportID: viewport, candidateSha256: current.identity.candidateSha256 },
                    image: {
                      mimeType: "image/png",
                      data: (await fs.readFile(result.screenshot)).toString("base64"),
                      sha256: result.screenshotSha256,
                      bytes: result.screenshotBytes,
                    },
                  }
                },
              },
            })
            const pipe = await startPublicToolLoopback({
              lifecycle,
              host: {
                ...tools,
                async write(r) {
                  if (readonly) throw new TypeError("TASK24_PUBLIC_READONLY")
                  return tools.write(r)
                },
              },
            })
            const connection: PublicMcpConnection = {
              host: pipe.host,
              port: pipe.port,
              capability: pipe.capability,
              bun: await fileIdentity(artifact("controller-bun").path!),
              entry: await fileIdentity(artifact("public-mcp").path!),
            }
            return {
              connection,
              setReadonly() {
                readonly = true
              },
              async dispose() {
                await pipe.close()
                if (lease) await lease.stop()
                await raw.dispose()
                await directRoot(root)
                if (path.dirname(root) !== manifest.roots.temp || !path.basename(root).startsWith("capability-"))
                  throw new TypeError("TASK24_RUNTIME_CLEANUP")
                await fs.rm(root, { recursive: true })
              },
            }
          },
        },
      })
      if (result.status !== "passed") throw new TypeError("TASK24_RUNTIME_CAPABILITY_BLOCKED")
      capabilities.push(result)
    }
    return capabilities
  }
  async function verifyProjects() {
    if (
      config.projects.length !== 3 ||
      config.projects
        .map((p) => p.kind)
        .sort()
        .join(",") !== "chart,http,pdf"
    )
      throw new TypeError("TASK24_RUNTIME_PROJECT_COVERAGE")
    const results: ProjectAcceptanceEvidence[] = []
    for (const p of config.projects) {
      const raw = backend(config.profiles),
        web = browser(manifest.roots.evidence, manifest.roots.temp)
      let lease: Awaited<ReturnType<typeof startLinuxPreview>> | undefined
      try {
        const build = await raw.build(p.build)
        if (build.payload.kind !== "ok") throw new TypeError("TASK24_RUNTIME_PROJECT_BUILD")
        const profile = raw.describe(p.build)
        if (!profile.preview) throw new TypeError("TASK24_RUNTIME_PROJECT_PREVIEW")
        const source = await raw.previewSource({ ...p.build, build: build.payload.build, preview: profile.preview })
        lease = await startLinuxPreview({
          source,
          policy: { methods: ["GET", "HEAD", "POST"], paths: source.files.map((f) => "/" + f.path) },
          guard,
          signal: new AbortController().signal,
        })
        web.register(p.build.identity, lease)
        const probe = await dispatchAcceptanceProbe<ProjectAcceptanceEvidence["probe"]>({
          mode: raw.probeMode(p.probe),
          linux: () => raw.probe(p.probe),
          browser: async () => ({ payload: { kind: "ok", response: await web.probe(p.probe) }, browser: true }),
        })
        const captures = []
        for (const viewportID of ["mobile", "tablet", "desktop"] as const)
          captures.push(
            await web.runtime.capture({
              runID: p.build.identity.runID,
              previewID: lease.previewID,
              previewURL: lease.url + profile.preview.entry,
              viewportID,
              readySelector: "body",
              interactionScriptID: profile.preview.interaction,
              timeoutMs: 30000,
              signal: new AbortController().signal,
            }),
          )
        const nonce = randomBytes(32).toString("hex"),
          file = path.join(manifest.roots.temp, "browser-canary-" + nonce + ".txt")
        await fs.writeFile(file, nonce, { flag: "wx" })
        let hits = 0
        const canary = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch(r) {
            if (new URL(r.url).pathname === "/" + nonce) {
              hits++
              return new Response("own-healthy-browser-canary")
            }
            return new Response(null, { status: 404 })
          },
        })
        try {
          const canaryURL = `http://127.0.0.1:${canary.port}/${nonce}`,
            healthy = (await (await fetch(canaryURL)).text()) === "own-healthy-browser-canary" && hits === 1
          hits = 0
          const result = await web.admission(p.build.identity, { canaryURL, fileURL: pathToFileURL(file).href })
          results.push({
            kind: p.kind,
            identity: p.build.identity,
            build,
            probe,
            captures,
            operations: raw.receipts(),
            admission: { result, canaryHealthy: healthy, canaryHits: hits },
          })
        } finally {
          canary.stop(true)
          if (path.dirname(file) !== manifest.roots.temp || !path.basename(file).startsWith("browser-canary-"))
            throw new TypeError("TASK24_RUNTIME_CLEANUP")
          await fs.unlink(file)
        }
      } finally {
        if (lease) await lease.stop()
        await raw.dispose()
      }
    }
    return results
  }
  return {
    config,
    images,
    guard,
    runner,
    async accept() {
      await ensureIsolation()
      await identityGuard()
      const created = !auditors
      auditors ??= await createDependencyAuditors({ session, runner, guard: identityGuard, images })
      const result = await acceptLinuxEngine({
        session,
        manifest,
        approval: state.approval,
        runner,
        guard,
        projectVerifier: verifyProjects,
        capabilityVerifier: verifyCapabilities,
        dependencyVerifier: () => auditDependencySet({ session, runner, guard: identityGuard, images, set: auditors! }),
      })
      if (result.status !== "passed" && created) {
        await stopDependencyAuditors({ session, runner, guard: identityGuard, images, set: auditors })
        if (canonicalJson(await readControllerJson(auditorFile)) !== canonicalJson(auditors))
          throw new TypeError("TASK24_DEPENDENCY_AUDITOR_CLEANUP_IDENTITY")
        await fs.unlink(auditorFile)
        auditors = undefined
      }
      if (result.status === "passed")
        await publishImmutable(
          path.join(manifest.roots.evidence, "linux-acceptance-input.json"),
          canonicalJson({
            schemaVersion: 2,
            manifestSha256: session.manifestSha256,
            engineSha256: result.receipt.receiptSha256,
            capabilitySha256: capabilities.map((c) => c.receiptSha256),
          }),
        )
      return result
    },
    async calibrate() {
      await ensureIsolation()
      const anchor = Schema.decodeUnknownSync(
        Schema.Struct({
          schemaVersion: Schema.Literal(2),
          manifestSha256: Schema.String,
          engineSha256: Schema.String,
          capabilitySha256: Schema.Array(Schema.String),
        }),
      )(await readControllerJson(path.join(manifest.roots.evidence, "linux-acceptance-input.json")), {
        onExcessProperty: "error",
      })
      if (anchor.manifestSha256 !== session.manifestSha256) throw new TypeError("TASK24_RUNTIME_ACCEPTANCE_STALE")
      const receipt = await restoreEngineReceipt({
          session,
          expectedSha256: anchor.engineSha256,
          receipt: (await readControllerJson(
            path.join(manifest.roots.evidence, `engine-${anchor.engineSha256}.json`),
          )) as EngineReceipt,
        }),
        authority = authorizeLinuxHost({ manifest, engineReceipt: receipt, evidenceRoot: manifest.roots.evidence })
      const corpus = await finalizeLinuxCorpus({
        ...config.corpus,
        manifest,
        authority,
        images: original,
        referenceCapturer: {
          async capture(v) {
            const ref = config.corpus.references[v.taskID],
              plan = config.corpus.executionPlans[v.taskID]
            if (!ref || !plan) throw new TypeError("TASK24_RUNTIME_REFERENCE_MAPPING")
            return captureReference(v.profile, ref.sourceRoot, ref.identity, plan.outputs)
          },
        },
      })
      const report = await calibrateLinuxCorpus({
        corpus,
        authority,
        images,
        evaluator: {
          async create(v) {
            const bundle = await loadEvaluationBundle(v.bundleRoot),
              raw = backend(
                [{ profile: bundle.profile, outputs: v.executionPlan.outputs, probeModes: v.executionPlan.probeModes }],
                v.evidenceRoot,
              ),
              web = browser(v.evidenceRoot, path.join(v.bundleRoot, "private")),
              host = makeLinuxEvaluationHost({ backend: raw, authority, browser: web }),
              observer = makeControllerFactsObserver({
                requirementPlans: config.corpus.requirementPlans,
                interactionAssertions: config.corpus.interactionAssertions,
                authority,
                evidenceRoot: v.evidenceRoot,
                browser: web,
                policyObserver: makeCalibrationPolicyObserver(authority, v.evidenceRoot),
              })
            return {
              evaluate(input) {
                return evaluateLinux(input, { host, browser: web, controllerFactsObserver: observer })
              },
              dispose: host.dispose,
            }
          },
        },
        signal: new AbortController().signal,
      })
      const index: ReadinessIndex = {
        ...anchor,
        corpusSha256: corpus.corpusSha256,
        calibrationSha256: report.reportSha256,
      }
      await publishImmutable(path.join(manifest.roots.evidence, "linux-readiness-input.json"), canonicalJson(index))
      return report
    },
  }
}
/** Calibration policy is an exact registered source audit, not a claim of universal malware detection. */
function makeCalibrationPolicyObserver(authority: LinuxAuthority, evidenceRoot: string) {
  return {
    async observe(
      value: Parameters<NonNullable<Parameters<typeof makeControllerFactsObserver>[0]["policyObserver"]>["observe"]>[0],
    ) {
      const { input } = value
      if (input.identity.campaignID !== "linux-oracle-calibration")
        throw new TypeError("TASK24_POLICY_JOURNAL_REQUIRED")
      const supported = ["hidden-gold-access", "external-network", "test-mutation", "reference-embedding"]
      if (input.bundle.oracle.policy.some((p) => !supported.includes(p)))
        throw new TypeError("TASK24_POLICY_UNOBSERVED")
      // Byte-exact control audit is supplementary to the actual Linux confinement receipts.
      const events: { code: "external-network" }[] =
        value.build.kind === "candidate_failure" && value.build.reason === "POLICY_REJECTED"
          ? [{ code: "external-network" }]
          : []
      if (
        !value.receipts.length ||
        value.receipts.some((r) => r.assurance !== "linux-attested" || r.manifestSha256 !== authority.manifestSha256)
      )
        throw new TypeError("TASK24_POLICY_UNOBSERVED")
      const record = {
        events: [...new Map(events.map((e) => [e.code, e])).values()],
        observed: input.bundle.oracle.policy,
        humanEdits: 0,
        processEnded: true,
      }
      const body = { identity: input.identity, ...record },
        file = path.join(evidenceRoot, `policy-${sha256Text(canonicalJson(body))}.json`)
      await publishImmutable(file, canonicalJson(body))
      return { record, evidence: [bindEvidenceFile(evidenceRoot, file, "policy-observation")] }
    },
  }
}
