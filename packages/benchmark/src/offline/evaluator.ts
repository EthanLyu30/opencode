import fs from "node:fs/promises"
import path from "node:path"
import { scoreAccessibility } from "../evaluator/accessibility"
import { loadBrowserRelease, makeBrowserRuntime } from "../evaluator/browser-runtime"
import { bindEvidenceFile, type EvidenceReference } from "../evaluator/evidence"
import { scoreFunctionalAssertions } from "../evaluator/functional"
import { evaluatePolicy, type PolicyEventCode } from "../evaluator/policy"
import { scoreQuality } from "../evaluator/quality"
import { scoreRequirements } from "../evaluator/requirements"
import { evaluateScore } from "../evaluator/score"
import {
  aggregateVisualViewports,
  evaluateVisualViewport,
  type VisualMask,
  type VisualViewportResult,
} from "../evaluator/visual"
import { sha256Bytes, sha256File, sha256Text } from "../hash"
import type { Task24Layout } from "../root"
import { Task24Root } from "../root"
import type { SealedCampaign } from "../schema"
import type { BinaryAuthority } from "../arms/types"
import type { MaterializedRoots } from "../corpus/materialize"
import { treeHash } from "../corpus/materialize"
import type { ValidatedBundle } from "../corpus/validate"
import { canonicalJson } from "../campaign/canonical"
import { publishImmutable } from "./atomic"
import { workspaceDirectoryExists } from "./evidence"

const viewports = ["mobile", "tablet", "desktop"] as const
const viewportWidths = { mobile: 390, tablet: 768, desktop: 1440 } as const
const evaluatorBun = "D:\\OpenCode-Toolchain\\bun-1.3.14\\bun-windows-x64\\bun.exe"
const evaluatorGit = "C:\\Program Files\\Git\\bin\\git.exe"
const evaluatorDocker = "D:\\Applications\\Docker\\resources\\bin\\docker.exe"
const sandboxManifest = "D:\\OpenCode-Local\\runtime\\sandbox\\workflow-sandbox.manifest.json"
const evaluatorExecutableHashes: Readonly<Record<string, string>> = Object.freeze({
  [evaluatorBun]: "0187f68d843f825a72ada4a7eca60db896ed753759a7f8252edcd31ac1bf1b9c",
  [evaluatorGit]: "81ef35ae005ca9318018d18e3327578ce939fb99feaad6b2d7c8ab15f3de8db5",
  [evaluatorDocker]: "7bc66b018b9da43fea986f893288bb93970d3d1217f5063201fd97c827f20732",
})
const evaluatorSourceFiles = Object.freeze([
  "offline/evaluator.ts",
  "offline/atomic.ts",
  "hash.ts",
  "campaign/canonical.ts",
  "root.ts",
  "corpus/manifest.ts",
  "corpus/materialize.ts",
  "corpus/validate.ts",
  "run/crash-hook.ts",
  "report/pdf.ts",
  "report/pdf-protocol.ts",
  "evaluator/accessibility.ts",
  "evaluator/browser-node-helper.ts",
  "evaluator/browser-protocol.ts",
  "evaluator/browser-runtime.ts",
  "evaluator/capture.ts",
  "evaluator/evidence.ts",
  "evaluator/functional.ts",
  "evaluator/policy.ts",
  "evaluator/quality.ts",
  "evaluator/requirements.ts",
  "evaluator/score.ts",
  "evaluator/visual.ts",
])

export interface OfflineEvaluationResult {
  readonly score: ReturnType<typeof evaluateScore>
  readonly changedFiles: number
  readonly captures: number
  readonly evidenceFile: string
  readonly evidenceSha256: string
}

export async function evaluateOfflineWorkspace(input: {
  readonly layout: Task24Layout
  readonly campaign: SealedCampaign
  readonly bundle: ValidatedBundle
  readonly runID: string
  readonly armID: "A" | "B" | "C" | "D" | "E"
  readonly binary: BinaryAuthority
  readonly roots: MaterializedRoots
  readonly preRunTreeSha256: string
  readonly postRunTreeSha256: string
  readonly evaluationRoot: string
  readonly browserReleaseRoot: string
}): Promise<OfflineEvaluationResult> {
  if ((await offlineEvaluatorSha256()) !== input.campaign.evaluator.sha256) {
    throw new TypeError("TASK24_OFFLINE_EVALUATOR_SOURCE_MISMATCH")
  }
  await fs.mkdir(input.evaluationRoot, { recursive: false })
  const treeEvidenceFile = path.join(input.evaluationRoot, "workspace.json")
  const changedFiles = await changedFileCount(input.bundle, input.roots.repo)
  await writeImmutable(
    treeEvidenceFile,
    canonicalJson({
      schemaVersion: 1,
      taskID: input.bundle.manifest.id,
      preRunTreeSha256: input.preRunTreeSha256,
      postRunTreeSha256: input.postRunTreeSha256,
      changedFiles,
    }) + "\n",
  )
  const treeEvidence = bindEvidenceFile(input.evaluationRoot, treeEvidenceFile, "workspace-tree")

  const visual = await visualEvaluation(input, treeEvidence)
  const functionalEvaluationResult = await functionalEvaluation(input, treeEvidence, visual.captures === 3)
  const functionalPassed = functionalEvaluationResult.passed
  const functional = scoreFunctionalAssertions({
    assertions: [{ id: "sealed-task-evaluator", mandatory: true, passed: functionalPassed, weight: 1 }],
    evidence: [treeEvidence, functionalEvaluationResult.evidence],
  })
  const hasExternalReference = await containsExternalNetworkReference(input.roots.repo)
  const requirements = await requirementEvaluation(input, functionalPassed, visual, hasExternalReference, [
    treeEvidence,
    functionalEvaluationResult.evidence,
  ])
  const quality = scoreQuality({
    checks: [
      // The sealed corpus declares no standalone typecheck/lint commands. Fail closed instead of relabeling
      // functional and browser-console checks as compiler/linter evidence.
      { id: "typecheck", passed: false },
      { id: "lint", passed: false },
      { id: "structure", passed: changedFiles > 0 },
      { id: "dependency-policy", passed: !hasExternalReference && visual.blockedRequests === 0 },
    ],
    evidence: uniqueEvidence([treeEvidence, functionalEvaluationResult.evidence, ...visual.evidence]),
  })
  const accessibility = scoreAccessibility({
    axeViolations: visual.axeViolations,
    keyboardCheckpoints: [{ id: "tab-enter-space", required: true, passed: visual.keyboardOperable }],
    responsiveCheckpoints: viewports.map((id) => ({ id, required: true, passed: visual.completed.has(id) })),
    overflowPassed: visual.overflowPassed,
    clippingPassed: visual.pageErrors === 0,
    evidence: visual.evidence.length > 0 ? visual.evidence : [treeEvidence],
  })
  const policyEvents: { code: PolicyEventCode }[] = []
  if (hasExternalReference || visual.blockedRequests > 0) policyEvents.push({ code: "external-network" })
  const policy = evaluatePolicy({ events: policyEvents, evidence: [treeEvidence] })
  const score = evaluateScore({
    identity: {
      schemaVersion: 1,
      runID: input.runID,
      armID: input.armID,
      binarySha256: input.binary.sha256,
      evaluatorSha256: input.campaign.evaluator.sha256,
      taskSha256: input.bundle.bundleSha256,
      goldSha256: input.bundle.goldSha256,
      evaluatedAt: input.campaign.createdAt,
    },
    buildPassed: visual.previewAvailable || input.bundle.manifest.kind === "guardrail",
    functional,
    visual: visual.result,
    requirements,
    quality,
    accessibility,
    policy,
    ceilingsPassed: true,
    humanEdited: false,
  })
  const evaluationFile = path.join(input.evaluationRoot, "evaluation.json")
  if ((await treeHash(input.roots.repo)) !== input.postRunTreeSha256) {
    throw new TypeError("TASK24_OFFLINE_EVALUATOR_MUTATED_WORKSPACE")
  }
  await writeImmutable(
    evaluationFile,
    canonicalJson({
      schemaVersion: 1,
      score,
      changedFiles,
      captures: visual.captures,
      evidence: uniqueEvidence([treeEvidence, functionalEvaluationResult.evidence, ...visual.result.evidence]),
      postRunTreeSha256: input.postRunTreeSha256,
    }) + "\n",
  )
  return Object.freeze({
    score,
    changedFiles,
    captures: visual.captures,
    evidenceFile: evaluationFile,
    evidenceSha256: await sha256File(evaluationFile),
  })
}

async function visualEvaluation(
  input: Parameters<typeof evaluateOfflineWorkspace>[0],
  fallback: EvidenceReference,
): Promise<{
  readonly result: ReturnType<typeof aggregateVisualViewports>
  readonly captures: number
  readonly completed: ReadonlySet<(typeof viewports)[number]>
  readonly evidence: readonly EvidenceReference[]
  readonly axeViolations: readonly {
    readonly id: string
    readonly impact: "minor" | "moderate" | "serious" | "critical" | null
  }[]
  readonly focusable: boolean
  readonly keyboardOperable: boolean
  readonly overflowPassed: boolean
  readonly consoleErrors: number
  readonly pageErrors: number
  readonly blockedRequests: number
  readonly stateVisible: boolean
  readonly previewAvailable: boolean
}> {
  const evaluatorFile = path.join(input.bundle.root, "gold", "evaluator.json")
  if (!(await Bun.file(evaluatorFile).exists()) || input.bundle.manifest.kind === "guardrail") {
    return emptyVisual(fallback)
  }
  const config = await readRecord(evaluatorFile)
  const readySelector = typeof config.readySelector === "string" ? config.readySelector : "body"
  const referencePattern =
    typeof config.visualReferencePattern === "string"
      ? config.visualReferencePattern
      : typeof config.responsiveReferencePattern === "string"
        ? config.responsiveReferencePattern
        : undefined
  if (!referencePattern || !(await Bun.file(path.join(input.roots.repo, "index.html")).exists())) {
    return emptyVisual(fallback)
  }

  const browserRoot = path.join(input.evaluationRoot, "browser")
  const browserTemp = path.join(input.layout.tmp, `offline-evaluator-${input.runID}-${crypto.randomUUID()}`)
  await Promise.all([fs.mkdir(browserRoot), fs.mkdir(browserTemp)])
  const runtime = makeBrowserRuntime({
    release: loadBrowserRelease(input.browserReleaseRoot),
    outputRoot: browserRoot,
    tempRoot: browserTemp,
  })
  const previewID = sha256Text(`${input.runID}\0${input.postRunTreeSha256}`)
  const server = staticServer(input.roots.repo, previewID)
  const completed = new Set<(typeof viewports)[number]>()
  const results: VisualViewportResult[] = []
  const evidence: EvidenceReference[] = []
  const axeViolations: Array<{ id: string; impact: "minor" | "moderate" | "serious" | "critical" | null }> = []
  let focusable = false
  let keyboardOperable = true
  let overflowPassed = true
  let consoleErrors = 0
  let pageErrors = 0
  let blockedRequests = 0
  let stateVisible = true
  try {
    for (const viewportID of viewports) {
      try {
        const published = await runtime.capture({
          runID: input.runID,
          previewID,
          previewURL: `http://127.0.0.1:${server.port}/${previewID}/`,
          viewportID,
          readySelector,
          interactionScriptID: "none",
          timeoutMs: 30_000,
          signal: new AbortController().signal,
        })
        completed.add(viewportID)
        const candidateEvidence = await readRecord(published.evidence)
        const candidateDom = Array.isArray(candidateEvidence.dom) ? candidateEvidence.dom : []
        const candidateAxe = record(candidateEvidence.axe) ? candidateEvidence.axe : {}
        for (const violation of Array.isArray(candidateAxe.violations) ? candidateAxe.violations : []) {
          if (!record(violation) || typeof violation.id !== "string") continue
          const impact = violation.impact
          if (
            impact === null ||
            impact === "minor" ||
            impact === "moderate" ||
            impact === "serious" ||
            impact === "critical"
          ) {
            axeViolations.push({ id: violation.id, impact })
          }
        }
        const accessibility = Array.isArray(candidateEvidence.accessibility) ? candidateEvidence.accessibility : []
        focusable ||= accessibility.some(
          (item) => record(item) && (item.role === "button" || item.role === "textbox" || item.role === "link"),
        )
        const keyboard = record(candidateEvidence.keyboard) ? candidateEvidence.keyboard : {}
        keyboardOperable &&=
          keyboard.tabFocusMoved === true &&
          keyboard.focusVisible === true &&
          keyboard.enterActivated === true &&
          keyboard.spaceActivated === true
        const stateProbe = record(candidateEvidence.stateProbe) ? candidateEvidence.stateProbe : {}
        stateVisible &&= stateProbe.visible === true
        overflowPassed &&= candidateDom.every(
          (item) =>
            !record(item) ||
            !record(item.box) ||
            typeof item.box.x !== "number" ||
            typeof item.box.width !== "number" ||
            (item.box.x >= -1 && item.box.x + item.box.width <= viewportWidths[viewportID] + 1),
        )
        consoleErrors += Array.isArray(candidateEvidence.consoleErrors) ? candidateEvidence.consoleErrors.length : 1
        pageErrors += Array.isArray(candidateEvidence.pageErrors) ? candidateEvidence.pageErrors.length : 1
        blockedRequests += integer(candidateEvidence.blockedRequests) ? candidateEvidence.blockedRequests : 1

        const referencePng = path.join(input.bundle.root, "gold", referencePattern.replace("{viewport}", viewportID))
        const referenceEvidence = await referenceEvidenceFile(input.bundle.root, viewportID)
        const reference = await readRecord(referenceEvidence)
        const referenceDom = Array.isArray(reference.dom) ? reference.dom : []
        const masks = await visualMasks(input.bundle.root)
        const referenceRoot = path.join(input.evaluationRoot, "reference")
        await fs.mkdir(referenceRoot, { recursive: true })
        const retainedReferencePng = path.join(referenceRoot, `${viewportID}.png`)
        const retainedReferenceBrowser = path.join(referenceRoot, `${viewportID}.json`)
        await writeImmutable(retainedReferencePng, await fs.readFile(referencePng))
        await writeImmutable(retainedReferenceBrowser, await fs.readFile(referenceEvidence))
        const references = [
          bindEvidenceFile(input.evaluationRoot, published.screenshot, "candidate-screenshot"),
          bindEvidenceFile(input.evaluationRoot, published.evidence, "candidate-browser"),
          bindEvidenceFile(input.evaluationRoot, retainedReferencePng, "reference-screenshot"),
          bindEvidenceFile(input.evaluationRoot, retainedReferenceBrowser, "reference-browser"),
        ]
        evidence.push(...references.slice(0, 2))
        results.push(
          await evaluateVisualViewport({
            viewportID,
            referencePng: await fs.readFile(referencePng),
            candidatePng: await fs.readFile(published.screenshot),
            referenceDom,
            candidateDom,
            interactionCheckpoints: [{ id: "page-ready", passed: true }],
            masks,
            evidence: references,
          }),
        )
      } catch (cause) {
        keyboardOperable = false
        stateVisible = false
        const failure = path.join(input.evaluationRoot, `visual-${viewportID}-failure.json`)
        await writeImmutable(failure, canonicalJson({ schemaVersion: 1, viewportID, code: errorCode(cause) }) + "\n")
        const reference = bindEvidenceFile(input.evaluationRoot, failure, "visual-failure")
        evidence.push(reference)
        results.push(zeroViewport(viewportID, reference))
      }
    }
  } finally {
    await server.stop(true)
    await removeOwnedTree(input.layout.tmp, browserTemp)
  }
  return Object.freeze({
    result: aggregateVisualViewports(results),
    captures: completed.size,
    completed,
    evidence: Object.freeze(evidence),
    axeViolations: Object.freeze(uniqueViolations(axeViolations)),
    focusable,
    keyboardOperable,
    overflowPassed,
    consoleErrors,
    pageErrors,
    blockedRequests,
    stateVisible,
    previewAvailable: true,
  })
}

async function functionalEvaluation(
  input: Parameters<typeof evaluateOfflineWorkspace>[0],
  fallback: EvidenceReference,
  visualComplete: boolean,
): Promise<Readonly<{ passed: boolean; evidence: EvidenceReference }>> {
  const test = path.join(input.bundle.root, "gold", "functional.test.ts")
  if (await Bun.file(test).exists()) {
    const sandbox = path.join(input.layout.tmp, `offline-functional-${input.runID}-${crypto.randomUUID()}`)
    await fs.mkdir(sandbox)
    try {
      const result = await runSandboxedFunctionalTest(input, sandbox)
      const evidenceFile = path.join(input.evaluationRoot, "functional.json")
      await writeImmutable(
        evidenceFile,
        canonicalJson({
          schemaVersion: 1,
          sourceSpecificationSha256: await sha256File(test),
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdoutSha256: sha256Text(result.stdout),
          stderrSha256: sha256Text(result.stderr),
          sandboxImage: result.sandboxImage,
          sandboxManifestSha256: result.sandboxManifestSha256,
          engineSha256: result.engineSha256,
          scenarioRequestSha256: result.scenarioRequestSha256,
          driverSha256: result.driverSha256,
        }) + "\n",
      )
      const evidence = bindEvidenceFile(input.evaluationRoot, evidenceFile, "functional-result")
      return Object.freeze({ passed: result.exitCode === 0 && !result.timedOut && result.scenarioPassed, evidence })
    } finally {
      await removeOwnedTree(input.layout.tmp, sandbox)
    }
  }
  const patch = path.join(input.bundle.root, "gold", "patch.diff")
  if (await Bun.file(patch).exists()) {
    const processTemp = path.join(input.layout.tmp, `offline-git-${input.runID}-${crypto.randomUUID()}`)
    try {
      const result = await boundedProcess(
        [evaluatorGit, "apply", "--reverse", "--check", patch],
        input.roots.repo,
        processTemp,
      )
      const evidenceFile = path.join(input.evaluationRoot, "functional.json")
      await writeImmutable(
        evidenceFile,
        canonicalJson({
          schemaVersion: 1,
          commandSha256: await sha256File(patch),
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          stdoutSha256: sha256Text(result.stdout),
          stderrSha256: sha256Text(result.stderr),
        }) + "\n",
      )
      return Object.freeze({
        passed: result.exitCode === 0 && !result.timedOut,
        evidence: bindEvidenceFile(input.evaluationRoot, evidenceFile, "functional-result"),
      })
    } finally {
      await removeOwnedTree(input.layout.tmp, processTemp)
    }
  }
  return Object.freeze({
    passed: input.bundle.manifest.stratum === "design2code" ? visualComplete : false,
    evidence: fallback,
  })
}

async function requirementEvaluation(
  input: Parameters<typeof evaluateOfflineWorkspace>[0],
  functionalPassed: boolean,
  visual: Awaited<ReturnType<typeof visualEvaluation>>,
  hasExternalReference: boolean,
  evidence: readonly EvidenceReference[],
) {
  const file = path.join(input.bundle.root, "gold", "requirements.json")
  const mandatory: string[] = []
  if (await Bun.file(file).exists()) {
    const value = await readRecord(file)
    for (const item of Array.isArray(value.mandatory) ? value.mandatory : []) {
      if (typeof item === "string") mandatory.push(item)
    }
  }
  if (mandatory.length === 0) mandatory.push("sealed task evaluator")
  return scoreRequirements({
    assertions: mandatory.map((item, index) => ({
      id: `requirement-${index + 1}`,
      mandatory: true,
      weight: 1,
      passed: requirementPassed(item, functionalPassed, visual, hasExternalReference),
    })),
    artifacts: [],
    evidence,
  })
}

function emptyVisual(evidence: EvidenceReference) {
  const results = viewports.map((viewportID) => zeroViewport(viewportID, evidence))
  return Object.freeze({
    result: aggregateVisualViewports(results),
    captures: 0,
    completed: new Set<(typeof viewports)[number]>(),
    evidence: [evidence],
    axeViolations: [],
    focusable: false,
    keyboardOperable: false,
    overflowPassed: true,
    consoleErrors: 0,
    pageErrors: 0,
    blockedRequests: 0,
    stateVisible: false,
    previewAvailable: false,
  })
}

function zeroViewport(viewportID: (typeof viewports)[number], evidence: EvidenceReference): VisualViewportResult {
  return Object.freeze({
    viewportID,
    composite: 0,
    points: 0,
    components: { ssim: 0, pixelColor: 0, domGeometry: 0, typographyStyle: 0, responsiveInteraction: 0 },
    design2Code: { ssim: 0, pixelSimilarity: 0 },
    evidence: [evidence],
  })
}

function staticServer(root: string, previewID: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const prefix = `/${previewID}/`
      if (!url.pathname.startsWith(prefix)) return new Response("not found", { status: 404 })
      let relative = decodeURIComponent(url.pathname.slice(prefix.length))
      if (relative === "") relative = "index.html"
      if (relative.includes("\\") || relative.split("/").includes(".."))
        return new Response("forbidden", { status: 403 })
      const file = path.resolve(root, ...relative.split("/"))
      if (!strictlyContains(root, file)) return new Response("forbidden", { status: 403 })
      const body = Bun.file(file)
      if (!(await body.exists())) return new Response("not found", { status: 404 })
      return new Response(body, { headers: { "content-type": contentType(file) } })
    },
  })
}

async function referenceEvidenceFile(bundleRoot: string, viewportID: (typeof viewports)[number]): Promise<string> {
  for (const name of [`evidence-${viewportID}.json`, `responsive-${viewportID}.evidence.json`]) {
    const file = path.join(bundleRoot, "gold", name)
    if (await Bun.file(file).exists()) return file
  }
  throw new TypeError("TASK24_OFFLINE_REFERENCE_EVIDENCE_MISSING")
}

async function visualMasks(bundleRoot: string): Promise<readonly VisualMask[]> {
  const value = await readRecord(path.join(bundleRoot, "gold", "masks.json"))
  if (!Array.isArray(value.masks)) throw new TypeError("TASK24_OFFLINE_VISUAL_MASK_INVALID")
  return Object.freeze(
    value.masks.map((mask) => {
      if (!record(mask)) throw new TypeError("TASK24_OFFLINE_VISUAL_MASK_INVALID")
      const x = finiteCoordinate(mask.x)
      const y = finiteCoordinate(mask.y)
      const width = finiteCoordinate(mask.width)
      const height = finiteCoordinate(mask.height)
      if (width <= 0 || height <= 0) {
        throw new TypeError("TASK24_OFFLINE_VISUAL_MASK_INVALID")
      }
      return Object.freeze({ x, y, width, height })
    }),
  )
}

function finiteCoordinate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("TASK24_OFFLINE_VISUAL_MASK_INVALID")
  }
  return value
}

async function changedFileCount(bundle: ValidatedBundle, repo: string): Promise<number> {
  const expected = new Map<string, string>()
  for (const file of bundle.manifest.workspaceFiles) expected.set(file.path, file.sha256)
  for (const file of bundle.manifest.publicAssets) expected.set(`assets/${file.path}`, file.sha256)
  const actual = await workspaceFiles(repo)
  const names = new Set([...expected.keys(), ...actual.keys()])
  let changed = 0
  for (const name of names) if (expected.get(name) !== actual.get(name)) changed++
  return changed
}

async function workspaceFiles(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isSymbolicLink()) throw new TypeError("TASK24_OFFLINE_WORKSPACE_LINK_UNSAFE")
      const absolute = path.join(directory, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(absolute, relative)
      else if (entry.isFile()) result.set(relative, sha256Bytes(await fs.readFile(absolute)))
      else throw new TypeError("TASK24_OFFLINE_WORKSPACE_ENTRY_UNSAFE")
    }
  }
  await walk(root, "")
  return result
}

async function containsExternalNetworkReference(root: string): Promise<boolean> {
  const files = await workspaceFiles(root)
  for (const relative of files.keys()) {
    if (relative === "assets" || relative.startsWith("assets/")) continue
    if (!/\.(?:html|css|js|jsx|ts|tsx|json|md)$/i.test(relative)) continue
    const text = await fs.readFile(path.join(root, ...relative.split("/")), "utf8")
    if (/https?:\/\/(?!127\.0\.0\.1|localhost)/i.test(text)) return true
  }
  return false
}

async function boundedProcess(
  argv: readonly string[],
  cwd: string,
  processTemp: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
  stdin?: string,
  timeoutMs = 30_000,
) {
  const executable = argv[0]
  const expected = executable ? evaluatorExecutableHashes[executable] : undefined
  if (!executable || !expected || (await sha256File(executable)) !== expected) {
    throw new TypeError("TASK24_OFFLINE_EVALUATOR_EXECUTABLE_MISMATCH")
  }
  await fs.mkdir(processTemp, { recursive: false })
  const child = Bun.spawn([...argv], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      PATHEXT: process.env.PATHEXT ?? "",
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      TEMP: processTemp,
      TMP: processTemp,
      NO_COLOR: "1",
      TASK24_EVALUATOR: "1",
      ...extraEnvironment,
    },
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  if (stdin !== undefined && typeof child.stdin === "object") {
    child.stdin.write(stdin)
    child.stdin.end()
  }
  let timedOut = false
  let termination: Promise<void> | undefined
  const terminate = () => {
    if (termination) return termination
    termination = (async () => {
      child.kill()
      await killTree(child.pid)
      await child.exited.catch(() => undefined)
    })()
    return termination
  }
  const timer = setTimeout(() => {
    timedOut = true
    void terminate()
  }, timeoutMs)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readBounded(child.stdout, 1024 * 1024, terminate),
      readBounded(child.stderr, 1024 * 1024, terminate),
    ])
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
    if (termination) await termination
  }
}

export async function offlineEvaluatorSha256(): Promise<string> {
  const sourceRoot = path.resolve(import.meta.dir, "..")
  const allSources = await Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: sourceRoot, onlyFiles: true }))
  const closedSources = [...new Set([...evaluatorSourceFiles, ...allSources.map((file) => file.split(path.sep).join("/"))])].toSorted((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const manifest = await Promise.all(
    closedSources.map(async (relative) => ({ relative, sha256: await sha256File(path.join(sourceRoot, relative)) })),
  )
  return sha256Text(canonicalJson(manifest))
}

async function readRecord(file: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await fs.readFile(file, "utf8"))
  if (!record(value)) throw new TypeError("TASK24_OFFLINE_EVALUATOR_JSON_INVALID")
  return value
}

async function writeImmutable(file: string, body: string | Uint8Array): Promise<void> {
  await publishImmutable(file, body)
}

async function runSandboxedFunctionalTest(
  input: Parameters<typeof evaluateOfflineWorkspace>[0],
  sandbox: string,
) {
  const scenario = functionalScenario(input.bundle.manifest.id)
  const execution = await runSandboxedVector({ workspaceRoot: input.roots.repo, sandbox, request: scenario.request })
  const outputLine = execution.stdout.split(/\r?\n/).filter(Boolean).at(-1)
  let scenarioPassed = false
  if (outputLine) {
    try { scenarioPassed = scenario.validate(JSON.parse(outputLine)) } catch { scenarioPassed = false }
  }
  return Object.freeze({ ...execution, scenarioPassed })
}

export async function runSandboxedVector(input: {
  readonly workspaceRoot: string
  readonly sandbox: string
  readonly request: VectorRequest
  readonly timeoutMs?: number
}) {
  const layout = Task24Root.ensure()
  const sandbox = input.sandbox
  if (!(await workspaceDirectoryExists(input.workspaceRoot)) || !(await workspaceDirectoryExists(sandbox)) ||
    !path.resolve(sandbox).startsWith(path.resolve(layout.tmp) + path.sep) ||
    (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 30_000))) {
    throw new TypeError("TASK24_VECTOR_SANDBOX_INPUT_INVALID")
  }
  const manifest = await readRecord(sandboxManifest)
  const fingerprint = await readRecord(path.join(layout.runs, "fairness-fingerprint.json"))
  const docker = record(fingerprint.docker) ? fingerprint.docker : undefined
  if (
    typeof manifest.image !== "string" ||
    !/@sha256:[a-f0-9]{64}$/.test(manifest.image) ||
    typeof manifest.base !== "string" ||
    typeof docker?.imageDigest !== "string" ||
    !manifest.base.endsWith(`@${docker.imageDigest}`)
  ) {
    throw new TypeError("TASK24_OFFLINE_SANDBOX_IMAGE_INVALID")
  }
  const dockerTemp = path.join(sandbox, "docker-temp")
  const dockerConfig = path.join(sandbox, "docker-config")
  await fs.mkdir(dockerConfig)
  const requestJson = canonicalJson(input.request)
  const driver = [
    'const request=JSON.parse(await Bun.stdin.text())',
    'const module=await import(`/starter/${request.module}`)',
    'const values={...request.fixtures}',
    'const resolve=(value)=>value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).length===1&&typeof value.$ref==="string"?value.$ref.split(".").reduce((current,key)=>current?.[key],values):Array.isArray(value)?value.map(resolve):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,resolve(item)])):value',
    'const results=[]',
    'for(const operation of request.operations){try{let value;if(operation.type==="call")value=await module[operation.name](...resolve(operation.args??[]));else if(operation.type==="method")value=await values[operation.target][operation.name](...resolve(operation.args??[]));else if(operation.type==="get")value=operation.path.reduce((current,key)=>current?.[key],values[operation.target]);else throw new Error("operation");if(operation.store)values[operation.store]=value;results.push({ok:true,value})}catch{results.push({ok:false})}}',
    'console.log(JSON.stringify(results))',
  ].join(";")
  const mount = (source: string, target: string) => `type=bind,src=${source},dst=${target},readonly`
  const containerName = `task24-vector-${crypto.randomUUID()}`
  let execution: Awaited<ReturnType<typeof boundedProcess>> | undefined
  let failure: unknown
  let failed = false
  try {
    execution = await boundedProcess(
    [
      evaluatorDocker,
      "run",
      "--interactive",
      "--name",
      containerName,
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--user",
      "65532:65532",
      "--pids-limit",
      "64",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m",
      "--env",
      "HOME=/tmp",
      "--mount",
      mount(input.workspaceRoot, "/starter"),
      "--workdir",
      "/tmp",
      "--entrypoint",
      "/usr/local/bin/bun",
      manifest.image,
      "-e",
      driver,
    ],
    sandbox,
    dockerTemp,
    { DOCKER_CONFIG: dockerConfig },
    requestJson,
    input.timeoutMs,
  )
  } catch (cause) { failed = true; failure = cause }
  try {
    const removed = await boundedProcess([evaluatorDocker, "rm", "--force", containerName], sandbox,
      path.join(sandbox, "docker-cleanup-temp"), { DOCKER_CONFIG: dockerConfig })
    if (removed.timedOut || (removed.exitCode !== 0 && !/No such container/i.test(removed.stderr))) {
      throw new TypeError("TASK24_VECTOR_CONTAINER_CLEANUP_FAILED")
    }
    const inspected = await boundedProcess([evaluatorDocker, "inspect", "--type", "container", containerName], sandbox,
      path.join(sandbox, "docker-inspect-temp"), { DOCKER_CONFIG: dockerConfig })
    if (inspected.timedOut || inspected.exitCode === 0 || !/No such (?:object|container)/i.test(inspected.stderr)) {
      throw new TypeError("TASK24_VECTOR_CONTAINER_SURVIVED")
    }
  }
  catch (cause) { throw failed ? new AggregateError([failure, cause], "TASK24_VECTOR_EXECUTION_AND_CLEANUP_FAILED") : cause }
  if (failed) throw failure
  if (!execution) throw new TypeError("TASK24_VECTOR_EXECUTION_MISSING")
  return Object.freeze({
    ...execution,
    sandboxImage: manifest.image,
    sandboxManifestSha256: await sha256File(sandboxManifest),
    engineSha256: evaluatorExecutableHashes[evaluatorDocker],
    scenarioRequestSha256: sha256Text(requestJson),
    driverSha256: sha256Text(driver),
    containerRemoved: true,
  })
}

type VectorOperation = Readonly<Record<string, unknown>>
type VectorRequest = Readonly<{
  module: string
  fixtures: Readonly<Record<string, unknown>>
  operations: readonly VectorOperation[]
}>

function functionalScenario(taskID: string): Readonly<{
  request: VectorRequest
  validate: (output: unknown) => boolean
}> {
  const ref = (value: string) => ({ $ref: value })
  const make = (
    module: string,
    fixtures: Readonly<Record<string, unknown>>,
    operations: readonly VectorOperation[],
    validate: (items: readonly unknown[]) => boolean,
  ) =>
    Object.freeze({
      request: Object.freeze({ module, fixtures, operations }),
      validate: (output: unknown) => Array.isArray(output) && validate(output),
    })
  const ok = (item: unknown) => record(item) && item.ok === true
  const failed = (item: unknown) => record(item) && item.ok === false
  const value = (item: unknown) => (record(item) ? item.value : undefined)
  if (taskID === "guardrail-data-normalization") {
    const rows = [
      { model: "b", input: 10, cached: 4, output: 7, reasoning: 2 },
      { model: "a", input: 5, cached: 0, output: 1, reasoning: 0 },
    ]
    return make(
      "src/usage.js",
      { rows },
      [
        { type: "call", name: "normalizeUsage", args: [ref("rows")] },
        {
          type: "call",
          name: "normalizeUsage",
          args: [[{ model: "x", input: 1, cached: 2, output: 0, reasoning: 0 }]],
        },
      ],
      (items) =>
        ok(items[0]) &&
        canonicalJson(value(items[0])) ===
          canonicalJson([
            { model: "a", input: 5, cachedInput: 0, uncachedInput: 5, output: 1, reasoning: 0 },
            { model: "b", input: 10, cachedInput: 4, uncachedInput: 6, output: 7, reasoning: 2 },
          ]) &&
        failed(items[1]),
    )
  }
  if (taskID === "guardrail-idempotent-orders") {
    return make(
      "src/orders.js",
      {},
      [
        { type: "call", name: "createOrderService", args: [{ sku: 3 }], store: "service" },
        { type: "method", target: "service", name: "createOrder", args: ["k1", { sku: 2 }], store: "a" },
        { type: "method", target: "service", name: "createOrder", args: ["k1", { sku: 2 }], store: "b" },
        { type: "method", target: "service", name: "stock", args: ["sku"] },
        { type: "method", target: "service", name: "createOrder", args: ["k1", { sku: 1 }] },
        { type: "method", target: "service", name: "cancelOrder", args: ["c1", ref("a.id")], store: "c1" },
        { type: "method", target: "service", name: "cancelOrder", args: ["c1", ref("a.id")], store: "c2" },
        { type: "method", target: "service", name: "stock", args: ["sku"] },
      ],
      (items) =>
        items.length === 8 &&
        items.slice(0, 4).every(ok) &&
        canonicalJson(value(items[1])) === canonicalJson(value(items[2])) &&
        value(items[3]) === 1 &&
        failed(items[4]) &&
        ok(items[5]) &&
        ok(items[6]) &&
        canonicalJson(value(items[5])) === canonicalJson(value(items[6])) &&
        value(items[7]) === 3,
    )
  }
  if (taskID === "guardrail-registry-refactor") {
    return make(
      "src/registry.js",
      {},
      [
        { type: "call", name: "createRegistry", store: "registry" },
        { type: "method", target: "registry", name: "alias", args: ["b", "build"] },
        { type: "method", target: "registry", name: "run", args: ["b", "x"] },
        { type: "method", target: "registry", name: "help" },
        { type: "method", target: "registry", name: "alias", args: ["build", "test"] },
        { type: "method", target: "registry", name: "alias", args: ["t", "test"] },
        { type: "method", target: "registry", name: "alias", args: ["test", "t"] },
      ],
      (items) =>
        items.length === 7 &&
        ok(items[0]) &&
        ok(items[1]) &&
        value(items[2]) === "build:x" &&
        canonicalJson(value(items[3])) === canonicalJson(["build", "test"]) &&
        failed(items[4]) &&
        ok(items[5]) &&
        failed(items[6]),
    )
  }
  if (taskID === "guardrail-session-debug") {
    const events = [
      { id: "b", sequence: 2, value: "B" },
      { id: "a", sequence: 1, value: "A" },
      { id: "a", sequence: 1, value: "A" },
    ]
    return make(
      "src/session.js",
      { events },
      [
        { type: "call", name: "reduceSession", args: [ref("events")] },
        {
          type: "call",
          name: "reduceSession",
          args: [[{ id: "a", sequence: 1, value: "A" }, { id: "a", sequence: 2, value: "X" }]],
        },
      ],
      (items) =>
        canonicalJson(value(items[0])) ===
          canonicalJson([
            { id: "a", sequence: 1, value: "A" },
            { id: "b", sequence: 2, value: "B" },
          ]) && failed(items[1]),
    )
  }
  if (taskID === "private-analytics-dashboard") {
    const rows = [
      { segment: "Enterprise", revenue: 120, pipeline: 240, won: true },
      { segment: "SMB", revenue: 80, pipeline: 160, won: false },
    ]
    return make(
      "src/analytics.js",
      { rows },
      [
        { type: "call", name: "filterRows", args: [ref("rows"), "Enterprise"] },
        { type: "call", name: "summarize", args: [ref("rows")] },
      ],
      (items) =>
        canonicalJson(value(items[0])) === canonicalJson([rows[0]]) &&
        canonicalJson(value(items[1])) === canonicalJson({ revenue: 200, pipeline: 400, winRate: 50 }),
    )
  }
  if (taskID === "private-checkout-recovery") {
    return make(
      "src/checkout.js",
      {},
      [
        { type: "call", name: "formatCard", args: ["4242424242424242"] },
        {
          type: "call",
          name: "validateCheckout",
          args: [{ email: "bad", card: "12", expiry: "00/00" }],
          store: "validation",
        },
        { type: "get", target: "validation", path: ["ok"] },
        { type: "call", name: "retryKey", args: ["ord-7", 2] },
        { type: "call", name: "retryKey", args: ["ord-7", 2] },
        { type: "call", name: "retryKey", args: ["ord-7", 3] },
      ],
      (items) =>
        value(items[0]) === "4242 4242 4242 4242" &&
        value(items[2]) === false &&
        value(items[3]) === value(items[4]) &&
        value(items[3]) !== value(items[5]),
    )
  }
  if (taskID === "private-inventory-admin") {
    const items = [
      { id: "a", stock: 2, status: "active" },
      { id: "b", stock: 0, status: "hold" },
    ]
    return make(
      "src/inventory.js",
      { items },
      [
        { type: "call", name: "updateStock", args: [ref("items"), "a", 7], store: "updated" },
        { type: "get", target: "updated", path: [0, "stock"] },
        { type: "get", target: "items", path: [0, "stock"] },
        { type: "call", name: "setStatus", args: [ref("items"), ["a", "b"], "archived"] },
        { type: "call", name: "validateStock", args: [-1] },
        { type: "call", name: "validateStock", args: [3] },
      ],
      (output) => {
        const archived = value(output[3])
        return (
          value(output[1]) === 7 &&
          value(output[2]) === 2 &&
          Array.isArray(archived) &&
          archived.every((item) => record(item) && item.status === "archived") &&
          value(output[4]) === false &&
          value(output[5]) === true
        )
      },
    )
  }
  if (taskID === "private-travel-search") {
    const hotels = [
      { name: "Cove", city: "Lisbon", price: 210, rating: 4.8, guests: 2 },
      { name: "Loft", city: "Porto", price: 140, rating: 4.5, guests: 4 },
    ]
    return make(
      "src/search.js",
      { hotels },
      [
        { type: "call", name: "searchHotels", args: [ref("hotels"), { city: "lisbon", guests: 2 }] },
        { type: "call", name: "sortHotels", args: [ref("hotels"), "price"] },
        { type: "get", target: "hotels", path: [0, "name"] },
      ],
      (output) =>
        canonicalJson(value(output[0])) === canonicalJson([hotels[0]]) &&
        canonicalJson(value(output[1])) === canonicalJson([hotels[1], hotels[0]]) &&
        value(output[2]) === "Cove",
    )
  }
  throw new TypeError(`TASK24_OFFLINE_FUNCTIONAL_SCENARIO_MISSING:${taskID}`)
}

function requirementPassed(
  text: string,
  functionalPassed: boolean,
  visual: Awaited<ReturnType<typeof visualEvaluation>>,
  hasExternalReference: boolean,
): boolean {
  const requirement = text.toLowerCase()
  if (/horizontal overflow|no overflow/.test(requirement)) return visual.overflowPassed && visual.captures === 3
  if (/external network|offline/.test(requirement)) return !hasExternalReference && visual.blockedRequests === 0
  if (/responsive/.test(requirement)) return visual.captures === 3 && visual.overflowPassed
  if (/keyboard/.test(requirement)) return visual.captures === 3 && visual.keyboardOperable
  if (/error|empty state/.test(requirement)) return visual.captures === 3 && visual.stateVisible
  if (/hierarchy|layout|visual/.test(requirement)) {
    return visual.captures === 3 && visual.result.composite > 0 && visual.pageErrors === 0
  }
  if (/sealed task evaluator/.test(requirement)) return functionalPassed
  return false
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  terminate: () => Promise<void>,
): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    size += result.value.byteLength
    if (size > limit) {
      await terminate()
      throw new TypeError("TASK24_OFFLINE_EVALUATOR_OUTPUT_LIMIT")
    }
    chunks.push(result.value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

async function killTree(pid: number): Promise<void> {
  try {
    const killer = Bun.spawn(["C:\\Windows\\System32\\taskkill.exe", "/PID", String(pid), "/T", "/F"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })
    await killer.exited
  } catch {
    // The direct child kill in boundedProcess remains the fail-closed fallback.
  }
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function uniqueViolations(
  values: readonly { readonly id: string; readonly impact: "minor" | "moderate" | "serious" | "critical" | null }[],
) {
  const byID = new Map(values.map((value) => [value.id, value]))
  return [...byID.values()].toSorted((left, right) => left.id.localeCompare(right.id))
}

function uniqueEvidence(values: readonly EvidenceReference[]): readonly EvidenceReference[] {
  const result = new Map(values.map((value) => [`${value.kind}\0${value.relativePath}\0${value.sha256}`, value]))
  return Object.freeze([...result.values()])
}

function errorCode(cause: unknown): string {
  return cause instanceof Error && /^TASK24_[A-Z0-9_:.-]+$/.test(cause.message)
    ? cause.message
    : "TASK24_OFFLINE_VISUAL_FAILED"
}

function contentType(file: string): string {
  const extension = path.extname(file).toLowerCase()
  if (extension === ".html") return "text/html; charset=utf-8"
  if (extension === ".css") return "text/css; charset=utf-8"
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8"
  if (extension === ".json") return "application/json"
  if (extension === ".png") return "image/png"
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg"
  return "application/octet-stream"
}

function strictlyContains(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function removeOwnedTree(parent: string, target: string): Promise<void> {
  const resolvedParent = path.resolve(parent) + path.sep
  const resolvedTarget = path.resolve(target)
  if (!resolvedTarget.startsWith(resolvedParent)) throw new TypeError("TASK24_OFFLINE_EVALUATOR_CLEANUP_UNSAFE")
  await fs.rm(resolvedTarget, { recursive: true, force: true })
}
