import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text, sha256Bytes } from "../hash"
import { directRoot, ordinaryFiles, loadEvaluationBundle, type ValidatedEvaluationBundle } from "./evaluation-bundle"
import {
  decodeTaskExecutionProfile,
  decodeEvaluationOracle,
  freeze,
  type TaskExecutionProfile,
} from "./evaluation-profile"
import { evaluationCatalogue } from "./evaluation-catalogue"
import { verifyTaskAuthoring, decodeOracleAuthoring, type CalibrationCandidate } from "./evaluation-authoring"
import { requireLinuxAuthority, type LinuxAuthority } from "../sandbox/evaluation-host"
import { requireBrowserTrace } from "../sandbox/browser"
import { decodeRequirementPlans, type RequirementProbePlan } from "../sandbox/controller-facts"
import type { HostManifest } from "../sandbox/contracts"
import type { ResolvedImages } from "../sandbox/dependencies"
import { resolveTaskDependency } from "../sandbox/dependencies"
import type { PublishedEvidence } from "../evaluator/capture"
import type { EvaluationIdentityV2 } from "./evaluation-profile"
import { publishImmutable } from "../offline/atomic"
import { outputPolicy } from "../sandbox/archive"

export type ExecutionPlan = Readonly<{
  outputs: readonly string[]
  probeModes: Readonly<Record<string, "node" | "browser" | "pdf">>
  previewEntry: string | null
}>
export type FinalizedTask = Readonly<{
  taskID: string
  kind: "primary" | "guardrail"
  bundleRoot: string
  authoringRoot: string
  profileSha256: string
  oracleSha256: string
  controls: readonly CalibrationCandidate[]
  executionPlan: ExecutionPlan
  publicOverlays: readonly { path: string; sha256: string; size: number }[]
}>
export type FinalizedCorpus = Readonly<{
  schemaVersion: 2
  root: string
  authoredRoot: string
  manifestSha256: string
  engineReceiptSha256: string
  authoringSha256: string
  tasks: readonly FinalizedTask[]
  corpusSha256: string
}>
export type ReferencePlan = Readonly<{
  mode: "retained-source" | "correct-control"
  sourceSha256: string
  candidateSha256: string
  visualPolicy: { masks: NonNullable<ReturnType<typeof decodeEvaluationOracle>["visual"]>["masks"]; tolerance: number }
}>
export function publicBuildDriverSource(commands: readonly (readonly string[])[]) {
  if (
    !commands.length ||
    commands.length > 16 ||
    commands.some(
      (argv) =>
        !argv.length ||
        argv.length > 128 ||
        !["/usr/local/bin/bun", "/usr/bin/pdftotext", "/usr/bin/pdftoppm", process.execPath].includes(argv[0]!) ||
        argv.some((a) => a.includes("\0") || a.length > 32768),
    )
  )
    throw new TypeError("TASK24_PUBLIC_BUILD_COMMAND")
  return `import {spawnSync} from 'node:child_process';for(const argv of ${JSON.stringify(commands)}){const p=spawnSync(argv[0],argv.slice(1),{cwd:process.cwd(),stdio:'ignore',env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:process.env.HOME,BUN_OPTIONS:'--no-env-file'},timeout:300000});if(p.error||p.status!==0)process.exit(p.status??1)}`
}
export async function finalizeLinuxCorpus(input: {
  authoredRoot: string
  outputRoot: string
  manifest: HostManifest
  authority: LinuxAuthority
  images: ResolvedImages
  executionPlans: Readonly<Record<string, ExecutionPlan>>
  requirementPlans: Readonly<Record<string, readonly RequirementProbePlan[]>>
  referencePlans: Readonly<Record<string, ReferencePlan>>
  referenceCapturer: {
    capture(input: {
      taskID: string
      profile: TaskExecutionProfile
      source: ReferencePlan
      authoringRoot: string
    }): Promise<readonly { identity: EvaluationIdentityV2; capture: PublishedEvidence }[]>
  }
}): Promise<FinalizedCorpus> {
  const authority = requireLinuxAuthority(input.authority)
  if (canonicalJson(authority.manifest) !== canonicalJson(input.manifest) || input.manifest.phase !== "accept")
    throw new TypeError("TASK24_FINALIZE_AUTHORITY")
  const dependencies = input.manifest.artifacts.find((a) => a.id === "dependencies")
  if (
    !dependencies ||
    dependencies.sha256 !== sha256Text(canonicalJson(input.images)) ||
    input.images.tasks.length !== 16 ||
    new Set(input.images.tasks.map((t) => t.taskID)).size !== 16
  )
    throw new TypeError("TASK24_FINALIZE_DEPENDENCY_BINDING")
  const root = path.resolve(input.outputRoot),
    authoredRoot = await directRoot(input.authoredRoot)
  if (
    root !== path.join("D:\\OpenCode-Benchmark\\Task24\\assets\\evaluation-v2-linux", input.manifest.acceptanceID) ||
    authoredRoot !== "D:\\OpenCode-Benchmark\\Task24\\assets\\evaluation-v2"
  )
    throw new TypeError("TASK24_FINALIZE_ROOT")
  await directRoot(path.dirname(root))
  await fs.mkdir(root)
  const tasks: FinalizedTask[] = [],
    sourceEntries = []
  for (const task of evaluationCatalogue()) {
    const source = path.join(authoredRoot, task.taskID),
      files = await ordinaryFiles(source),
      authoringRoot = path.join(source, "private", "authoring"),
      author = await verifyTaskAuthoring({ root: authoringRoot, task })
    sourceEntries.push({ taskID: task.taskID, files })
    const authored = decodeOracleAuthoring(
        JSON.parse(await fs.readFile(path.join(authoringRoot, "oracle-authored.json"), "utf8")),
        task,
      ),
      plan = input.executionPlans[task.taskID]
    if (!plan) throw new TypeError("TASK24_FINALIZE_EXECUTION_MAPPING")
    decodeRequirementPlans(input.requirementPlans[task.taskID], authored.requirements)
    const destination = path.join(root, task.taskID)
    await fs.mkdir(destination)
    for (const file of files.filter((f) => f.path.startsWith("public/") || f.path.startsWith("private/"))) {
      const data = await fs.readFile(path.join(source, file.path))
      if (sha256Bytes(data) !== file.sha256) throw new TypeError("TASK24_FINALIZE_SOURCE_DRIFT")
      const to = path.join(destination, file.path)
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.writeFile(to, data, { flag: "wx" })
    }
    const publicOverlays = []
    if (task.publicFixtureTemplate === "react-pdf") {
      const relative = ".task24/linux-pdf-build.mjs",
        bytes = Buffer.from(
          publicBuildDriverSource([
            ["/usr/local/bin/bun", "--no-env-file", "run", "build"],
            ["/usr/local/bin/bun", "--no-env-file", "run", ".task24/render.jsx"],
            ["/usr/bin/pdftotext", ".task24/document.pdf", ".task24/document.txt"],
            ["/usr/bin/pdftoppm", "-png", "-singlefile", ".task24/document.pdf", ".task24/document"],
          ]),
        )
      await fs.writeFile(path.join(destination, "public", relative), bytes, { flag: "wx" })
      publicOverlays.push({ path: relative, sha256: sha256Bytes(bytes), size: bytes.length })
    }
    const publicInputs = (await ordinaryFiles(path.join(destination, "public"))).map((f) => ({
      ...f,
      path: "public/" + f.path,
      purpose:
        f.path.startsWith("assets/") && /\.(png|jpe?g|webp)$/i.test(f.path)
          ? ("reference" as const)
          : ("starter" as const),
      origin: "task-public" as const,
    }))
    const draft = JSON.parse(
      await fs.readFile(
        path.join(source, task.kind === "guardrail" ? "profile.json" : "preparation-profile.json"),
        "utf8",
      ),
    ) as { checks: TaskExecutionProfile["checks"]; protectedPaths: readonly string[] }
    const protectedPaths = [...draft.protectedPaths, ...publicOverlays.map((o) => o.path)],
      checks = publicOverlays.length
        ? [
            {
              id: "build" as const,
              cwd: ".",
              argv: ["bun", "--no-env-file", "run", publicOverlays[0]!.path],
              timeoutMs: 300000,
              required: true,
            },
          ]
        : draft.checks
    const image = input.images.tasks.find((i) => i.taskID === task.taskID)
    if (
      !image ||
      image.assurance !== "linux-attested" ||
      !input.manifest.artifacts.some((a) => a.kind === "image" && a.image === image.image)
    )
      throw new TypeError("TASK24_FINALIZE_DEPENDENCY")
    const dependency =
      task.stratum === "swebench-multimodal"
        ? {
            kind: "locked" as const,
            sourceCommit: image.recipe.sourceCommit,
            lockfiles: image.recipe.lockfiles,
            recipeSha256: image.recipe.recipeSha256,
            requiredCapabilities: task.requiredCapabilities.filter(
              (c) => !["linux-isolation", "browser-three-viewports"].includes(c),
            ),
          }
        : { kind: "none" as const }
    const seed = [...author.seed, ...publicOverlays].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const profile = decodeTaskExecutionProfile({
      schemaVersion: 2,
      taskID: task.taskID,
      kind: task.kind,
      stratum: task.stratum,
      executionKind: task.executionKind,
      seedSha256: sha256Text(canonicalJson(seed)),
      publicFixtureSha256: sha256Text(canonicalJson(publicInputs)),
      publicInputs,
      sourceEntry: task.sourceEntry,
      probeModules: [...new Set(authored.cases.map((c) => c.module))],
      protectedPaths,
      mutablePaths: publicInputs.map((f) => f.path.slice(7)).filter((p) => !protectedPaths.includes(p)),
      checks,
      dependency,
      preview:
        task.kind === "guardrail"
          ? null
          : {
              entry: plan.previewEntry,
              kind:
                task.publicFixtureTemplate === "react-pdf"
                  ? "pdf"
                  : task.publicFixtureTemplate === "chartjs"
                    ? "canvas"
                    : "html",
              requiredCapabilities: task.requiredCapabilities,
              interaction: "none",
              timeoutMs: 30000,
            },
    })
    outputPolicy(profile, plan.outputs)
    if (
      profile.probeModules.some((m) => !Object.hasOwn(plan.probeModes, m)) ||
      resolveTaskDependency({ profile, images: input.images }).kind !== "ready"
    )
      throw new TypeError("TASK24_FINALIZE_PROBE_MAPPING")
    let visual: ReturnType<typeof decodeEvaluationOracle>["visual"] = null
    if (task.kind === "primary") {
      const referencePlan = input.referencePlans[task.taskID],
        mode = task.stratum === "swebench-multimodal" ? "correct-control" : "retained-source"
      if (!referencePlan || referencePlan.mode !== mode) throw new TypeError("TASK24_FINALIZE_REFERENCE_SOURCE")
      const expectedSource =
        mode === "correct-control"
          ? author.controls.find((c) => c.kind === "correct")!.treeSha256
          : sha256Text(await fs.readFile(path.join(source, "private", "oracle-visual-sources.json"), "utf8"))
      if (referencePlan.sourceSha256 !== expectedSource) throw new TypeError("TASK24_FINALIZE_REFERENCE_SOURCE")
      const captured = await input.referenceCapturer.capture({
        taskID: task.taskID,
        profile,
        source: referencePlan,
        authoringRoot,
      })
      if (captured.length !== 3) throw new TypeError("TASK24_FINALIZE_REFERENCE_COVERAGE")
      const refs: Record<string, { path: string; sha256: string; size: number }> = {},
        doms: typeof refs = {}
      for (const entry of captured) {
        const trace = requireBrowserTrace(entry.capture, entry.identity)
        if (trace.identity.taskID !== task.taskID || trace.identity.candidateSha256 !== referencePlan.candidateSha256)
          throw new TypeError("TASK24_FINALIZE_REFERENCE_IDENTITY")
        if (
          trace.browserSha256 !== input.manifest.artifacts.find((a) => a.id === "browser")!.sha256 ||
          trace.fontSha256 !== input.manifest.artifacts.find((a) => a.id === "fonts")!.sha256
        )
          throw new TypeError("TASK24_FINALIZE_REFERENCE_RUNTIME")
        const data = JSON.parse(await fs.readFile(entry.capture.evidence, "utf8")) as {
          viewportID: string
          dom: unknown
        }
        if (!["mobile", "tablet", "desktop"].includes(data.viewportID) || refs[data.viewportID])
          throw new TypeError("TASK24_FINALIZE_REFERENCE_COVERAGE")
        const png = await fs.readFile(entry.capture.screenshot),
          dom = Buffer.from(canonicalJson(data.dom)),
          pngPath = `private/engine-reference/${data.viewportID}.png`,
          domPath = `private/engine-reference/${data.viewportID}.dom.json`
        if (sha256Bytes(png) !== entry.capture.screenshotSha256) throw new TypeError("TASK24_FINALIZE_REFERENCE_HASH")
        await fs.mkdir(path.join(destination, "private/engine-reference"), { recursive: true })
        await fs.writeFile(path.join(destination, pngPath), png, { flag: "wx" })
        await fs.writeFile(path.join(destination, domPath), dom, { flag: "wx" })
        refs[data.viewportID] = { path: pngPath, sha256: sha256Bytes(png), size: png.length }
        doms[data.viewportID] = { path: domPath, sha256: sha256Bytes(dom), size: dom.length }
      }
      const runtime = input.manifest.artifacts,
        browser = runtime.find((a) => a.id === "browser")!,
        font = runtime.find((a) => a.id === "fonts")!
      if (!referencePlan.visualPolicy) throw new TypeError("TASK24_FINALIZE_VISUAL_POLICY")
      visual = {
        references: { mobile: refs.mobile!, tablet: refs.tablet!, desktop: refs.desktop! },
        domReferences: { mobile: doms.mobile!, tablet: doms.tablet!, desktop: doms.desktop! },
        ...referencePlan.visualPolicy,
        browserSha256: browser.sha256,
        fontSha256: font.sha256,
      }
    }
    const privateFiles = (await ordinaryFiles(path.join(destination, "private"))).map((f) => ({
        ...f,
        path: "private/" + f.path,
      })),
      publicReferenceManifest = privateFiles.find((f) => f.path === "private/public-source.json") ?? null
    const oracle = decodeEvaluationOracle({
      schemaVersion: 2,
      taskID: task.taskID,
      kind: task.kind,
      privateFiles,
      publicReferenceManifest,
      cases: authored.cases,
      requirements: authored.requirements,
      quality: authored.quality,
      policy: authored.policy,
      visual,
      calibration: author.controls.map((c) => ({
        id: c.kind,
        kind: c.kind,
        path: "private/authoring/controls/" + c.kind + ".json",
      })),
      note: "New same-engine reference and immutable original control expectations; calibration still required.",
    })
    await fs.writeFile(path.join(destination, "profile.json"), canonicalJson(profile), { flag: "wx" })
    await fs.writeFile(path.join(destination, "oracle.json"), canonicalJson(oracle), { flag: "wx" })
    const bundle = await loadEvaluationBundle(destination)
    tasks.push({
      taskID: task.taskID,
      kind: task.kind,
      bundleRoot: destination,
      authoringRoot,
      profileSha256: bundle.profileSha256,
      oracleSha256: bundle.oracleSha256,
      controls: author.controls,
      executionPlan: plan,
      publicOverlays,
    })
  }
  const body = {
      schemaVersion: 2 as const,
      root,
      authoredRoot,
      manifestSha256: input.authority.manifestSha256,
      engineReceiptSha256: input.authority.engineReceiptSha256,
      authoringSha256: sha256Text(canonicalJson(sourceEntries)),
      tasks,
    },
    corpus = freeze({ ...body, corpusSha256: sha256Text(canonicalJson(body)) })
  await publishImmutable(path.join(root, "finalized-corpus.json"), canonicalJson(corpus))
  return corpus
}
export async function verifyFinalizedCorpus(corpus: FinalizedCorpus, authority: LinuxAuthority) {
  requireLinuxAuthority(authority)
  const { corpusSha256, ...body } = corpus
  if (
    corpus.manifestSha256 !== authority.manifestSha256 ||
    corpus.engineReceiptSha256 !== authority.engineReceiptSha256 ||
    sha256Text(canonicalJson(body)) !== corpusSha256 ||
    corpus.tasks.length !== 16 ||
    new Set(corpus.tasks.map((t) => t.taskID)).size !== 16
  )
    throw new TypeError("TASK24_FINALIZED_CORPUS_STALE")
  await directRoot(corpus.root)
  if (
    canonicalJson(JSON.parse(await fs.readFile(path.join(corpus.root, "finalized-corpus.json"), "utf8"))) !==
    canonicalJson(corpus)
  )
    throw new TypeError("TASK24_FINALIZED_CORPUS_DRIFT")
  const sourceEntries = []
  for (const task of evaluationCatalogue()) {
    const record = corpus.tasks.find((t) => t.taskID === task.taskID)
    if (
      !record ||
      record.bundleRoot !== path.join(corpus.root, task.taskID) ||
      record.authoringRoot !== path.join(corpus.authoredRoot, task.taskID, "private", "authoring")
    )
      throw new TypeError("TASK24_FINALIZED_CORPUS_IDENTITY")
    const bundle = await loadEvaluationBundle(record.bundleRoot),
      author = await verifyTaskAuthoring({ root: record.authoringRoot, task })
    sourceEntries.push({ taskID: task.taskID, files: await ordinaryFiles(path.join(corpus.authoredRoot, task.taskID)) })
    if (
      bundle.profileSha256 !== record.profileSha256 ||
      bundle.oracleSha256 !== record.oracleSha256 ||
      canonicalJson(author.controls) !== canonicalJson(record.controls)
    )
      throw new TypeError("TASK24_FINALIZED_CORPUS_DRIFT")
  }
  if (sha256Text(canonicalJson(sourceEntries)) !== corpus.authoringSha256)
    throw new TypeError("TASK24_FINALIZED_AUTHORING_DRIFT")
  return corpus
}
