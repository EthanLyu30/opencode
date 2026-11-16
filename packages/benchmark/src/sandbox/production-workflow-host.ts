import { Schema } from "effect"
import { EvaluationIdentityV2, freeze, safePath } from "../corpus/evaluation-profile"
import { canonicalJson } from "../campaign/canonical"
import { sha256Bytes } from "../hash"
import { sha256Text } from "../hash"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assertRunRoots } from "../arms/environment"
import { directRoot } from "../corpus/direct-root"
import { fileIdentity } from "./storage"
import { sessionState } from "./preflight"
import { requireFixtureCapabilityProvider } from "./fixture-provider"
import { startProductionCommandBridge, requireProductionCommandObservation } from "./production-command-bridge"
import { productionStaticSnapshotSha256 } from "./production-command-http"
import { requireBrowserTrace, type LinuxBrowser } from "./browser"
import { FIXED_VIEWPORTS, type ViewportID } from "../evaluator/browser-protocol"
import { bindEvidenceFile, type EvidenceReference } from "../evaluator/evidence"
import { publishImmutable } from "../offline/atomic"
import type { EngineSession, DockerRunner, AuthorityGuard, FileIdentity } from "./contracts"
import type { HostIsolationAdapter } from "./capability"
import type { ProductionWorkflowHost } from "./host-isolation/production"
import { WorkflowBenchmarkModels } from "../../../schema/src/workflow-benchmark-models"
import { randomBytes } from "node:crypto"
import { openProductionGit } from "./production-git"

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const Archive = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  archiveSha256: Digest,
  workspaceSha256: Digest,
  entries: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      type: Schema.Literals(["file", "executable"]),
      size: Schema.Int,
      sha256: Digest,
      contentBase64: Schema.String,
    }),
  ),
})
export const ProductionWorkflowCaseData = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  identity: EvaluationIdentityV2,
  image: Schema.String,
  publicImage: Schema.String,
  readonlyToolCallID: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)),
  gitStates: Schema.optionalKey(
    Schema.Array(Schema.Array(Schema.Struct({ path: Schema.String, contentBase64: Schema.String }))),
  ),
  commands: Schema.Array(
    Schema.Struct({
      argv: Schema.Array(Schema.String),
      workdir: Schema.String,
      interactive: Schema.optionalKey(Schema.Boolean),
      stdinBase64: Schema.optionalKey(Schema.String),
      archiveSha256: Schema.optionalKey(Digest),
      sealedArchive: Schema.optionalKey(Archive),
    }),
  ),
  previews: Schema.Array(
    Schema.Struct({
      entrypoint: Schema.String,
      root: Schema.String,
      readySelector: Schema.String,
      files: Schema.Array(Schema.Struct({ path: Schema.String, contentBase64: Schema.String })),
    }),
  ),
})

type CaseBinding = Readonly<{
  kind: "visual" | "coding"
  campaignID: string
  runID: string
  binarySha256: string
  profileSha256: string
  images: readonly string[]
}>
type CasePlan = Readonly<{
  schemaVersion: 1
  identity: EvaluationIdentityV2
  image: string
  publicImage: string
  readonlyToolCallID: string
  gitStates?: readonly (readonly { path: string; contentBase64: string }[])[]
  commands: readonly {
    argv: readonly string[]
    workdir: string
    interactive?: boolean
    stdinBase64?: string
    archiveSha256?: string
    sealedArchive?: unknown
  }[]
  previews: readonly {
    entrypoint: string
    root: string
    readySelector: string
    files: readonly { path: string; contentBase64: string }[]
  }[]
}>

export function decodeProductionWorkflowCase(raw: unknown, binding: CaseBinding): CasePlan {
  const json = canonicalJson(raw)
  if (Buffer.byteLength(json) > 16777216) throw new TypeError("TASK24_PRODUCTION_CASE_LIMIT")
  const value = Schema.decodeUnknownSync(ProductionWorkflowCaseData)(JSON.parse(json), { onExcessProperty: "error" })
  if (value.gitStates !== undefined) {
    if (!value.gitStates.length || value.gitStates.length > 16) throw Error("TASK24_PRODUCTION_CASE_GIT")
    let bytes = 0
    for (const files of value.gitStates) {
      if (
        !files.length ||
        files.length > 20000 ||
        new Set(files.map((f) => f.path.toLowerCase())).size !== files.length
      )
        throw Error("TASK24_PRODUCTION_CASE_GIT")
      for (const f of files) {
        safePath(f.path)
        if (/(?:^|\/)(?:\.git|private|oracle|gold|node_modules)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/i.test(f.path))
          throw Error("TASK24_PRODUCTION_CASE_GIT")
        bytes += decodeBytes(f.contentBase64).length
        if (bytes > 67108864) throw Error("TASK24_PRODUCTION_CASE_GIT")
      }
    }
  }
  if (
    value.identity.armID !== "A" ||
    value.identity.campaignID !== binding.campaignID ||
    value.identity.runID !== binding.runID ||
    value.identity.binarySha256 !== binding.binarySha256 ||
    value.identity.profileSha256 !== binding.profileSha256 ||
    !binding.images.includes(value.image)
  )
    throw new TypeError("TASK24_PRODUCTION_CASE_BINDING")
  if (
    (binding.kind === "coding" && value.previews.length !== 0) ||
    (binding.kind === "visual" && !value.previews.length)
  )
    throw new TypeError("TASK24_PRODUCTION_CASE_COVERAGE")
  if (
    !/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value.image) ||
    !/^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(value.publicImage) ||
    value.image.split("@")[1] !== value.publicImage.split("@")[1] ||
    !value.commands.length ||
    value.commands.length > 32 ||
    value.previews.length > 8
  )
    throw new TypeError("TASK24_PRODUCTION_CASE_PLAN")
  for (const command of value.commands) {
    if (
      !command.argv.length ||
      command.argv.length > 256 ||
      command.argv.some((arg) => !arg || arg.includes("\0") || Buffer.byteLength(arg) > 1048576) ||
      !/^\/(?:workspace(?:\/[A-Za-z0-9._-]+)*|)$/.test(command.workdir) ||
      command.workdir.split("/").some((part) => part === "." || part === "..") ||
      (command.stdinBase64 !== undefined && !command.interactive) ||
      (command.sealedArchive !== undefined && !command.archiveSha256)
    )
      throw new TypeError("TASK24_PRODUCTION_CASE_COMMAND")
    if (command.stdinBase64 !== undefined) decodeBytes(command.stdinBase64)
    for (const file of command.sealedArchive?.entries ?? []) {
      safePath(file.path)
      const bytes = decodeBytes(file.contentBase64)
      if (bytes.length !== file.size || sha256Bytes(bytes) !== file.sha256)
        throw new TypeError("TASK24_PRODUCTION_CASE_ARCHIVE")
    }
  }
  let total = 0
  for (const preview of value.previews) {
    safePath(preview.entrypoint)
    if (preview.root) safePath(preview.root)
    if (
      (preview.root && !preview.entrypoint.startsWith(preview.root + "/")) ||
      !preview.readySelector ||
      preview.readySelector.length > 1024 ||
      !preview.files.length ||
      preview.files.length > 512 ||
      !preview.files.some((file) => file.path === preview.entrypoint) ||
      new Set(preview.files.map((file) => file.path.toLowerCase())).size !== preview.files.length
    )
      throw new TypeError("TASK24_PRODUCTION_CASE_PREVIEW")
    for (const file of preview.files) {
      safePath(file.path)
      total += decodeBytes(file.contentBase64).length
      if (total > 67108864) throw new TypeError("TASK24_PRODUCTION_CASE_LIMIT")
    }
  }
  return freeze(value)
}

function decodeBytes(value: string) {
  const bytes = Buffer.from(value, "base64")
  if (bytes.toString("base64") !== value || bytes.length > 8388608) throw new TypeError("TASK24_PRODUCTION_CASE_BYTES")
  return bytes
}

const connections = new Map<string, { file: FileIdentity; closed: boolean }>()
export function makeProductionGitGuard(session: EngineSession, pins: () => readonly FileIdentity[]) {
  return async () => {
    sessionState(session)
    const files = pins()
    if (!files.length) throw Error("TASK24_PRODUCTION_GIT_BINDING")
    for (const file of files)
      if (canonicalJson(await fileIdentity(file.path)) !== canonicalJson(file))
        throw Error("TASK24_PRODUCTION_GIT_BINDING")
  }
}

/** Composes the existing finite command bridge and branded native browser. No ACL or installation changes. */
export async function openProductionWorkflowHost(input: {
  request: Parameters<HostIsolationAdapter["launch"]>[0]
  session: EngineSession
  runner: DockerRunner
  guard: AuthorityGuard
  data: unknown
  profileSha256: string
  models: unknown
  engine: FileIdentity
  browser?: LinuxBrowser
  expectedFixtureCalls: number
  git: { path: string; sha256: string }
}): Promise<ProductionWorkflowHost> {
  const request = input.request
  if (!request.fixture) throw new TypeError("TASK24_PRODUCTION_CASE_PROVIDER")
  requireFixtureCapabilityProvider(request.fixture)
  if (request.kind === "visual" && !input.browser) throw Error("TASK24_PRODUCTION_CASE_BROWSER")
  if (
    request.launch.snapshot.armID !== "A" ||
    request.launch.snapshot.mode !== "workflow" ||
    request.fixture.origin !== request.launch.snapshot.brokerOrigin ||
    sha256Text(request.fixture.grant) !== request.launch.snapshot.brokerGrantSha256
  )
    throw new TypeError("TASK24_PRODUCTION_CASE_PROVIDER")
  await input.guard()
  const state = sessionState(input.session)
  const manifest = state.manifest
  if (manifest.phase !== "accept") throw new TypeError("TASK24_PRODUCTION_CASE_ARTIFACT")
  const models = Schema.decodeUnknownSync(WorkflowBenchmarkModels.Packet)(input.models, { onExcessProperty: "error" })
  const modelArtifact = manifest.artifacts.find((a) => a.id === "benchmark-models")
  const engineArtifact = manifest.artifacts.find((a) => a.id === "production-engine")
  if (
    !modelArtifact ||
    modelArtifact.sha256 !== sha256Text(canonicalJson(models)) ||
    !engineArtifact ||
    !("path" in engineArtifact) ||
    engineArtifact.path !== input.engine.path ||
    engineArtifact.sha256 !== input.engine.sha256 ||
    path.basename(input.engine.path).toLowerCase() !== "docker.exe" ||
    canonicalJson(await fileIdentity(input.engine.path)) !== canonicalJson(input.engine)
  )
    throw new TypeError("TASK24_PRODUCTION_CASE_ARTIFACT")
  const roots = assertRunRoots(request.launch.snapshot.roots)
  for (const root of Object.values(roots)) await directRoot(root)
  const env = request.launch.environment
  const transport = path.join(roots.data, "benchmark-transport.json")
  if (env.OPENCODE_BENCHMARK_TRANSPORT_FILE !== transport || env.OPENCODE_BENCHMARK_RUN_DATA_ROOT !== roots.data)
    throw new TypeError("TASK24_PRODUCTION_CASE_BINDING")
  const profile = await fs.readFile(transport, "utf8")
  const url = new URL("../../../core/src/workflow/benchmark-transport.ts", import.meta.url)
  const moduleFile = await fileIdentity(fileURLToPath(url))
  const loaded: unknown = await import(url.href)
  if (
    !loaded ||
    typeof loaded !== "object" ||
    !("WorkflowBenchmarkTransport" in loaded) ||
    !loaded.WorkflowBenchmarkTransport ||
    typeof loaded.WorkflowBenchmarkTransport !== "object" ||
    !("freezeProfile" in loaded.WorkflowBenchmarkTransport) ||
    typeof loaded.WorkflowBenchmarkTransport.freezeProfile !== "function"
  )
    throw new TypeError("TASK24_PRODUCTION_CASE_BINDING")
  const binding = loaded.WorkflowBenchmarkTransport.freezeProfile({
    authority: "server",
    profile: JSON.parse(profile),
    expectedCampaignID: env.OPENCODE_BENCHMARK_CAMPAIGN_ID,
    expectedRunID: env.OPENCODE_BENCHMARK_RUN_ID,
  }) as {
    campaignID: string
    runID: string
    bindingSha256: string
    grantSha256: string
    brokerOrigin: string
    evidenceMode: string
    expiresAt: number
  }
  if (
    binding.evidenceMode !== "production" ||
    binding.brokerOrigin !== request.fixture.origin ||
    binding.grantSha256 !== request.launch.snapshot.brokerGrantSha256 ||
    canonicalJson(await fileIdentity(moduleFile.path)) !== canonicalJson(moduleFile)
  )
    throw new TypeError("TASK24_PRODUCTION_CASE_BINDING")
  const plan = decodeProductionWorkflowCase(input.data, {
    kind: request.kind,
    campaignID: binding.campaignID,
    runID: binding.runID,
    binarySha256: request.launch.snapshot.executableSha256,
    profileSha256: input.profileSha256,
    images: manifest.artifacts.flatMap((a) => (a.kind === "image" && a.image ? [a.image] : [])),
  })
  if (
    !Number.isSafeInteger(input.expectedFixtureCalls) ||
    input.expectedFixtureCalls < 1 ||
    input.expectedFixtureCalls > 128
  )
    throw new TypeError("TASK24_PRODUCTION_CASE_COVERAGE")
  const startCalls = request.fixture.observation().calls
  if (request.fixture.toolResults().some((result) => result.callID === plan.readonlyToolCallID))
    throw new TypeError("TASK24_PRODUCTION_CASE_PROVIDER")
  const deployment = path.join(roots.data, request.readonly ? "host-readonly" : "host-main")
  const hostRoots = [
    deployment,
    ...["data", "runtime", "cache", "preview", "config", "temp"].map((name) => path.join(deployment, name)),
  ]
  // Preparation owns these seven private directories. This composition never
  // changes their ACLs, adopts another run's state, or creates a fallback root.
  for (const root of hostRoots) await directRoot(root)
  const connection = path.join(roots.data, "benchmark-host.json")
  const prior = connections.get(connection)
  if (await fs.lstat(connection).catch(() => undefined)) {
    if (!prior?.closed || canonicalJson(await fileIdentity(connection)) !== canonicalJson(prior.file))
      throw new TypeError("TASK24_PRODUCTION_CASE_CONNECTION_OWNERSHIP")
    await fs.unlink(connection)
  }
  const previews = plan.previews.map((preview) => {
    const snapshot = {
      entrypoint: preview.entrypoint,
      root: preview.root,
      files: preview.files.map((file) => ({ path: file.path, bytes: decodeBytes(file.contentBase64) })),
    }
    return { ...snapshot, readySelector: preview.readySelector, sha256: productionStaticSnapshotSha256(snapshot) }
  })
  const expiresAt = Math.min(
    binding.expiresAt,
    state.approval.expiresAt,
    state.manifest.wsl2?.guestExecution.expiresAt ?? 0,
  )
  const captures: {
    previewID: string
    viewportID: ViewportID
    snapshotSha256: string
    screenshotSha256: string
    evidence: readonly EvidenceReference[]
  }[] = []
  let bridge: Awaited<ReturnType<typeof startProductionCommandBridge>>
  // Git never executes the Docker helper or consumes model/module bytes. Keep
  // their full pins on the Docker path, not on every private Git read.
  const transportPin = await fileIdentity(transport)
  const gitPins = [transportPin]
  const commandPins = [transportPin, input.engine, moduleFile, await fileIdentity(modelArtifact.path!)]
  const gitGuard = makeProductionGitGuard(input.session, () => gitPins)
  const commandGuard = makeProductionGitGuard(input.session, () => commandPins)
  if (!plan.gitStates) throw Error("TASK24_PRODUCTION_CASE_GIT")
  const snapshotsRoot = path.join(hostRoots[1]!, "opencode", "snapshot")
  await fs.mkdir(snapshotsRoot, { recursive: true })
  const git = await openProductionGit({
    workspace: roots.repo,
    snapshotsRoot,
    cacheRoot: path.join(state.manifest.roots.temp, "production-git-" + randomBytes(16).toString("hex")),
    git: input.git,
    states: plan.gitStates.map((files) =>
      files.map((file) => ({ path: file.path, bytes: decodeBytes(file.contentBase64) })),
    ),
    guard: gitGuard,
  })
  bridge = await startProductionCommandBridge(
    {
      session: input.session,
      runner: input.runner,
      // The existing production runner collects fresh native storage/daemon
      // proof WITH every Docker verb. This guard pins the controller/round;
      // re-entering six unrelated WSL inspections here consumed the unchanged
      // 15s create deadline before Docker could execute at all.
      guard: commandGuard,
      commands: plan.commands.map((command) => ({
        image: plan.image,
        publicImage: plan.publicImage,
        argv: command.argv,
        workdir: command.workdir,
        ...(command.interactive ? { interactive: true as const } : {}),
        ...(command.stdinBase64 === undefined ? {} : { stdin: decodeBytes(command.stdinBase64) }),
        ...(command.archiveSha256 === undefined ? {} : { archiveSha256: command.archiveSha256 }),
        ...(command.sealedArchive === undefined ? {} : { sealedArchive: command.sealedArchive }),
      })),
    },
    {
      git,
      previews: [...new Map(previews.map((preview) => [preview.sha256, preview])).values()],
      previewExpiresAt: expiresAt,
      capture: {
        async admit(capture) {
          await input.guard()
          bridge.admitStaticPreview(capture.url)
          const id = new URL(capture.url).pathname.split("/")[1]
          const lease = bridge.previewObservation().find((lease) => lease.hostID === id && lease.active)
          if (
            !lease ||
            !previews.some(
              (preview) => preview.sha256 === lease.sha256 && preview.readySelector === capture.readySelector,
            ) ||
            !Object.values(FIXED_VIEWPORTS).some(
              (viewport) => viewport.width === capture.viewport.width && viewport.height === capture.viewport.height,
            )
          )
            throw new TypeError("TASK24_PRODUCTION_CASE_CAPTURE")
        },
        async capture(capture, signal) {
          const browser = input.browser
          if (!browser) throw Error("TASK24_PRODUCTION_CASE_BROWSER")
          const previewID = new URL(capture.url).pathname.split("/")[1]!
          const lease = bridge.previewObservation().find((lease) => lease.hostID === previewID && lease.active)!
          const preview = previews.find(
            (preview) => preview.sha256 === lease.sha256 && preview.readySelector === capture.readySelector,
          )!
          const viewportID = (Object.keys(FIXED_VIEWPORTS) as ViewportID[]).find(
            (id) =>
              FIXED_VIEWPORTS[id].width === capture.viewport.width &&
              FIXED_VIEWPORTS[id].height === capture.viewport.height,
          )!
          const identity = {
            ...plan.identity,
            attemptID: plan.identity.attemptID.slice(0, 96) + "-" + previewID.slice(0, 16),
          }
          const entry = preview.root ? preview.entrypoint.slice(preview.root.length + 1) : preview.entrypoint
          browser.register(identity, {
            previewID,
            url: capture.url,
            capability: bridge.capability,
            buildSha256: preview.sha256,
            assets: preview.files
              .filter((file) => !preview.root || file.path.startsWith(preview.root + "/"))
              .map((file) => ({
                path: preview.root ? file.path.slice(preview.root.length + 1) : file.path,
                size: file.bytes.length,
                sha256: sha256Bytes(file.bytes),
              })),
            async stop() {
              bridge.admitStaticPreview(capture.url)
            },
          })
          const result = await browser.runtime.capture({
            runID: identity.runID,
            previewID,
            previewURL: capture.url + entry,
            viewportID,
            readySelector: capture.readySelector,
            interactionScriptID: "none",
            timeoutMs: 30000,
            signal,
          })
          const trace = requireBrowserTrace(result, identity)
          const png = await fileIdentity(result.screenshot)
          if (png.sha256 !== result.screenshotSha256) throw new TypeError("TASK24_PRODUCTION_CASE_CAPTURE")
          captures.push({
            previewID,
            viewportID,
            snapshotSha256: preview.sha256,
            screenshotSha256: png.sha256,
            evidence: [
              trace.evidence,
              bindEvidenceFile(state.manifest.roots.evidence, result.screenshot, "production-capture"),
              bindEvidenceFile(state.manifest.roots.evidence, result.evidence, "production-capture-metadata"),
            ],
          })
          return fs.readFile(result.screenshot)
        },
        async close() {},
      },
    },
  ).catch(async (cause) => {
    await git.close()
    throw cause
  })
  try {
    await fs.writeFile(
      connection,
      canonicalJson({
        schemaVersion: 1,
        campaignID: binding.campaignID,
        runID: binding.runID,
        bindingSha256: binding.bindingSha256,
        host: bridge.host,
        port: bridge.port,
        capability: bridge.capability,
        expiresAt,
        enginePath: input.engine.path,
      }),
      { flag: "wx" },
    )
    const record = { file: await fileIdentity(connection), closed: false }
    gitPins.push(record.file)
    commandPins.push(record.file)
    connections.set(connection, record)
    let observed = false
    return {
      authority: {
        campaignID: binding.campaignID,
        runID: binding.runID,
        bindingSha256: binding.bindingSha256,
        expiresAt,
      },
      port: bridge.port,
      models,
      host: {
        armID: "A",
        transport: await fileIdentity(transport),
        connection: record.file,
        engine: input.engine,
        image: plan.publicImage,
      },
      environment: {
        ...env,
        OPENCODE_TEST_HOME: hostRoots[1]!,
        XDG_DATA_HOME: hostRoots[1]!,
        XDG_STATE_HOME: hostRoots[1]!,
        XDG_CONFIG_HOME: hostRoots[5]!,
        XDG_CACHE_HOME: hostRoots[3]!,
        OPENCODE_WORKFLOW_HOST_ROOT: deployment,
        OPENCODE_WORKFLOW_HOST_DATA: hostRoots[1]!,
        OPENCODE_WORKFLOW_EVIDENCE_ROOT: hostRoots[1]!,
        OPENCODE_WORKFLOW_HOST_RUNTIME: hostRoots[2]!,
        PLAYWRIGHT_BROWSERS_PATH: hostRoots[2]!,
        OPENCODE_WORKFLOW_HOST_CACHE: hostRoots[3]!,
        OPENCODE_WORKFLOW_HOST_TEMP: hostRoots[4]!,
        OPENCODE_WORKFLOW_SANDBOX_CONFIG: hostRoots[5]!,
        OPENCODE_WORKFLOW_SANDBOX_TEMP: hostRoots[6]!,
        OPENCODE_WORKFLOW_SANDBOX_ENGINE: input.engine.path,
        OPENCODE_WORKFLOW_SANDBOX_IMAGE: plan.publicImage,
        OPENCODE_BENCHMARK_HOST_FILE: connection,
        MOONSHOT_API_KEY: request.fixture.grant,
        DEEPSEEK_API_KEY: request.fixture.grant,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      },
      async observe(execution) {
        await input.guard()
        requireFixtureCapabilityProvider(request.fixture!)
        const commands = bridge.observation()
        requireProductionCommandObservation(commands, input.session)
        const summary = tryDecodeProductionWorkflowSummary(execution.stdout)
        const fixture = request.fixture!.observation()
        const returned = request
          .fixture!.toolResults()
          .find(
            (result) =>
              result.callID === plan.readonlyToolCallID &&
              result.name === "write" &&
              result.text === "Unknown tool: write",
          )
        const complete =
          summary !== undefined &&
          execution.started &&
          !execution.truncated &&
          fixture.rejected === 0 &&
          fixture.calls - startCalls === input.expectedFixtureCalls
        const checkExit =
          commands.executions.length === plan.commands.length &&
          commands.executions.every((command) => command.exitCode === 0 && !command.truncated)
            ? 0
            : 1
        const preview =
          bridge.previewObservation().length >= 2 && bridge.previewObservation().every((lease) => !lease.active)
        const capture = completeProductionCaptureViews(captures)
        const readonlyDenied =
          request.readonly &&
          complete &&
          execution.exitCode === 1 &&
          summary?.workflow.status === "failed" &&
          returned !== undefined &&
          commands.executions.length === 0 &&
          captures.length === 0
        const workflowSucceeded =
          !request.readonly &&
          complete &&
          execution.exitCode === 0 &&
          summary?.workflow.status === "succeeded" &&
          summary.response.status === "completed" &&
          summary.response.workflowID === summary.workflow.id &&
          summary.artifacts.some(
            (artifact) =>
              artifact.kind === (request.kind === "coding" ? "workflow.coding.delivery" : "workflow.delivery"),
          ) &&
          checkExit === 0 &&
          (request.kind === "coding" ? captures.length === 0 : preview && capture)
        const body = {
          manifestSha256: input.session.manifestSha256,
          identity: plan.identity,
          readonly: request.readonly,
          execution: {
            started: execution.started,
            exitCode: execution.exitCode,
            truncated: execution.truncated,
            summaryAvailable: summary !== undefined,
          },
          workflowSucceeded,
          readonlyDenied,
          checkExit,
          preview,
          capture,
          previews: bridge.previewObservation(),
          captures,
          commands,
          fixture: { calls: fixture.calls - startCalls, rejected: fixture.rejected },
          readonlyReply: returned ? { callID: returned.callID, name: returned.name, sha256: returned.sha256 } : null,
          stdoutSha256: sha256Bytes(execution.stdout),
        }
        const file = path.join(
          state.manifest.roots.evidence,
          "production-host-" + sha256Text(canonicalJson(body)) + ".json",
        )
        await publishImmutable(file, canonicalJson(body))
        observed = true
        return {
          workflowSucceeded,
          readonlyDenied,
          checkExit,
          preview,
          capture,
          evidence: [
            bindEvidenceFile(state.manifest.roots.evidence, file, "production-host"),
            ...commands.evidence,
            ...captures.flatMap((capture) => capture.evidence),
          ],
        }
      },
      async close() {
        await bridge.close()
        record.closed = observed
      },
    }
  } catch (cause) {
    await bridge.close()
    throw cause
  }
}

export function decodeProductionWorkflowSummary(bytes: Uint8Array) {
  if (bytes.length > 2097152) throw new TypeError("TASK24_PRODUCTION_CASE_SUMMARY")
  return Schema.decodeUnknownSync(
    Schema.Struct({
      workflow: Schema.Struct({ id: Schema.String, status: Schema.String }),
      response: Schema.Struct({ workflowID: Schema.String, status: Schema.String }),
      artifacts: Schema.Array(Schema.Struct({ kind: Schema.String })),
    }),
  )(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
}

export function completeProductionCaptureViews(
  captures: readonly { readonly previewID: string; readonly viewportID: string }[],
) {
  const previews = new Map<string, Set<string>>()
  for (const capture of captures) {
    const viewports = previews.get(capture.previewID) ?? new Set<string>()
    viewports.add(capture.viewportID)
    previews.set(capture.previewID, viewports)
  }
  return (
    previews.size >= 2 &&
    [...previews.values()].every((viewports) =>
      Object.keys(FIXED_VIEWPORTS).every((viewport) => viewports.has(viewport)),
    )
  )
}

/** A crash is a rejected execution, not grounds to lose the native teardown proof. */
export function tryDecodeProductionWorkflowSummary(bytes: Uint8Array) {
  try {
    return decodeProductionWorkflowSummary(bytes)
  } catch {
    return undefined
  }
}
