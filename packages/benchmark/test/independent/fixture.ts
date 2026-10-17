import fs from "node:fs/promises"
import path from "node:path"
import { sha256Text } from "../../src/hash"
import { decodeEvaluationIdentity } from "../../src/corpus/evaluation-profile"
import { evidenceReferenceForBytes } from "../../src/evaluator/evidence"
import { aggregateVisualViewports } from "../../src/evaluator/visual"
import type { EvaluationFacts } from "../../src/evaluator/independent/result"
import { loadEvaluationBundle } from "../../src/corpus/evaluation-bundle"
import { captureCandidate } from "../../src/evaluator/independent/snapshot"
import { fixtureObservation, buildManifest, type EvaluationHost } from "../../src/evaluator/independent/host"
import { bindEvidenceFile } from "../../src/evaluator/evidence"
import { decodeProbeResponse } from "../../src/evaluator/independent/probe"

export function identity(overrides: Record<string, unknown> = {}) {
  return decodeEvaluationIdentity({
    schemaVersion: 2,
    campaignID: "fixture",
    runID: "run-1",
    attemptID: "attempt-1",
    leaseGeneration: 1,
    taskID: "fixture-add",
    armID: "A",
    repeat: 0,
    ...Object.fromEntries(
      [
        "campaignSha256",
        "binarySha256",
        "routeSha256",
        "profileSha256",
        "oracleSha256",
        "seedSha256",
        "candidateSha256",
        "evaluatorSha256",
      ].map((k) => [k, sha256Text(k)]),
    ),
    ...overrides,
  })
}
export const candidate = {
  archiveFile: "candidate.json",
  archiveSha256: sha256Text("archive"),
  candidateSha256: identity().candidateSha256,
  configSha256: sha256Text("config"),
}
export function evaluationFactsFixture(
  options: { viewportScores?: number[]; kind?: "primary" | "guardrail" } = {},
): EvaluationFacts {
  const evidence = [evidenceReferenceForBytes("fixture", "facts.json", Buffer.from("fixture facts"))]
  const scores = options.viewportScores ?? [100, 100, 100]
  const viewports = (["mobile", "tablet", "desktop"] as const).map((viewportID, i) => ({
    viewportID,
    composite: scores[i]!,
    points: scores[i]! * 0.3,
    components: {
      ssim: scores[i]!,
      pixelColor: scores[i]!,
      domGeometry: scores[i]!,
      typographyStyle: scores[i]!,
      responsiveInteraction: scores[i]!,
    },
    design2Code: { ssim: scores[i]! / 100, pixelSimilarity: scores[i]! / 100 },
    evidence,
  }))
  const kind = options.kind ?? "primary"
  return {
    kind,
    identity: identity(),
    assurance: "fixture",
    source: { candidateSha256: identity().candidateSha256, configSha256: candidate.configSha256 },
    build: {
      status: "passed",
      manifest: {
        candidateSha256: identity().candidateSha256,
        configSha256: candidate.configSha256,
        dependencySha256: sha256Text("none"),
        files: [{ path: "index.html", sha256: sha256Text("built"), size: 5 }],
        buildSha256: sha256Text("build"),
      },
      evidence,
    },
    functional: {
      assertions: [{ id: "sum", mandatory: true, weight: 1, passed: true }],
      executedAssertions: 1,
      mandatoryPassed: true,
      points: 45,
      evidence,
    },
    requirements: { assertions: [{ id: "public", mandatory: true, weight: 1, passed: true }], artifacts: [], evidence },
    quality: {
      checks: (["typecheck", "lint", "structure", "dependency-policy"] as const).map((id) => ({
        id,
        status: "passed" as const,
      })),
      evidence,
    },
    policy: { events: [], evidence },
    runtime: { ceilingsPassed: true, humanEdited: false, evidence },
    visual:
      kind === "guardrail"
        ? null
        : {
            identity: identity(),
            buildSha256: sha256Text("build"),
            browserSha256: sha256Text("browser"),
            fontSha256: sha256Text("font"),
            captures: ["mobile", "tablet", "desktop"],
            result: aggregateVisualViewports(viewports),
            accessibility: { points: 5, requiredPassed: true, failures: [], evidence },
            evidence,
          },
  }
}
export async function orchestratorFixture(value = 5) {
  const f = await independentFixture("orchestrator")
  const bundle = await loadEvaluationBundle(f.bundleRoot)
  const snapshot = await captureCandidate({ sourceRoot: f.sourceRoot, workRoot: f.workRoot, profile: bundle.profile })
  const id = identity({
    runID: `run-${path.basename(f.root).split("-").at(-1)!.toLowerCase()}`,
    taskID: bundle.profile.taskID,
    profileSha256: bundle.profileSha256,
    oracleSha256: bundle.oracleSha256,
    seedSha256: bundle.seedSha256,
    candidateSha256: snapshot.candidateSha256,
  })
  await fs.mkdir(f.resultRoot)
  const facts = evaluationFactsFixture({ kind: "guardrail" })
  const record = Object.fromEntries(
    (["requirements", "quality", "policy", "runtime"] as const).map((k) => {
      const { evidence, ...value } = facts[k]
      return [k, value]
    }),
  )
  await fs.writeFile(
    path.join(f.resultRoot, "runtime.json"),
    JSON.stringify({ schemaVersion: 2, kind: "controller-facts", identity: id, ...record }),
  )
  const evidence = [bindEvidenceFile(f.resultRoot, path.join(f.resultRoot, "runtime.json"), "runtime")]
  const input = {
    bundle,
    snapshot,
    identity: id,
    evidenceRoot: f.resultRoot,
    facts: {
      requirements: { ...facts.requirements, evidence },
      quality: { ...facts.quality, evidence },
      policy: { ...facts.policy, evidence },
      runtime: { ...facts.runtime, evidence },
    },
  }
  const calls: string[] = [],
    requests: unknown[] = []
  const host: EvaluationHost = {
    async build(r) {
      calls.push("build")
      requests.push(r)
      return fixtureObservation(r, {
        kind: "ok",
        commands: r.commands.map((c) => ({ id: c.id, exitCode: 0 })),
        build: buildManifest({
          candidateSha256: r.candidate.candidateSha256,
          configSha256: r.candidate.configSha256,
          dependencySha256: sha256Text(JSON.stringify(r.dependency)),
          files: [{ path: "built.json", sha256: sha256Text("built"), size: 5 }],
        }),
      })
    },
    async probe(r) {
      calls.push("probe")
      requests.push(r)
      return fixtureObservation(r, {
        kind: "ok",
        response: decodeProbeResponse(
          Buffer.from(
            JSON.stringify({
              cases: r.operations.map((c) => ({
                id: c.id,
                outputs: c.steps.map(() => ({ kind: "value" as const, value })),
              })),
            }),
          ),
        ),
      })
    },
    async preview() {
      calls.push("preview")
      throw Error("GUARDRAIL_MUST_NOT_PREVIEW")
    },
  }
  return { ...f, bundle, snapshot, input, host, calls, requests }
}

export async function independentFixture(label: string) {
  const parent = process.env.TMPDIR!
  if (!path.resolve(parent).toLowerCase().startsWith("d:\\opencode-benchmark\\task24\\tmp\\bprep1-"))
    throw Error("FIXTURE_ROOT")
  const root = await fs.mkdtemp(path.join(parent, `independent-${label}-`))
  const sourceRoot = path.join(root, "source")
  const workRoot = path.join(root, "work")
  const resultRoot = path.join(root, "results")
  const bundleRoot = path.join(root, "bundle")
  const source = "export const add = (a, b) => a + b\n"
  const oracleCanary = "PRIVATE_ORACLE_CANARY"
  const entry = { path: "public/src/math.js", sha256: sha256Text(source), size: Buffer.byteLength(source) }
  const profile = {
    schemaVersion: 2,
    taskID: "fixture-add",
    kind: "guardrail",
    stratum: "guardrail",
    executionKind: "coding-build",
    seedSha256: sha256Text(source),
    publicFixtureSha256: sha256Text("fixture"),
    publicInputs: [{ ...entry, purpose: "starter", origin: "task-public" }],
    sourceEntry: "src/math.js",
    probeModules: ["src/math.js"],
    protectedPaths: [],
    mutablePaths: ["src/math.js"],
    checks: [{ id: "test", cwd: ".", argv: ["bun", "--no-env-file", "test"], timeoutMs: 30000, required: true }],
    dependency: { kind: "none" },
    preview: null,
  }
  const oracle = {
    schemaVersion: 2,
    taskID: "fixture-add",
    kind: "guardrail",
    privateFiles: [],
    publicReferenceManifest: null,
    cases: [
      {
        id: "sum",
        module: "src/math.js",
        operations: [{ kind: "call", target: "add", args: [2, 3] }],
        expected: [{ comparator: "equal", value: 5 }],
        mandatory: true,
        weight: 1,
      },
    ],
    requirements: [{ id: "public", mandatory: true, weight: 1 }],
    quality: [],
    policy: [],
    visual: null,
    calibration: [{ id: "known-correct", kind: "correct", path: "private/correct.js" }],
    note: oracleCanary,
  }
  async function writeBundle() {
    await fs.mkdir(path.join(bundleRoot, "public/src"), { recursive: true })
    await fs.writeFile(path.join(bundleRoot, "public/src/math.js"), source)
    await fs.writeFile(path.join(bundleRoot, "profile.json"), JSON.stringify(profile))
    await fs.writeFile(path.join(bundleRoot, "oracle.json"), JSON.stringify(oracle))
  }
  await fs.mkdir(path.join(sourceRoot, "src"), { recursive: true })
  await fs.writeFile(path.join(sourceRoot, "src/math.js"), source)
  await writeBundle()
  return {
    root,
    sourceRoot,
    workRoot,
    resultRoot,
    bundleRoot,
    profile,
    oracle,
    oracleCanary,
    source,
    writeBundle,
    async dispose() {
      const resolved = await fs.realpath(root)
      if (resolved !== path.resolve(root) || path.dirname(resolved) !== path.resolve(parent))
        throw Error("FIXTURE_OWNERSHIP")
      await fs.rm(resolved, { recursive: true })
    },
  }
}
