import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path, { dirname, win32 } from "node:path"
import { validateTaskBundle, type ValidatedBundle } from "../corpus/validate"
import { sha256File, sha256Text } from "../hash"
import { Task24Root, type Task24Layout } from "../root"
import { SealedTask } from "../schema"
import { verifySourceLock, type SealedSourceLock } from "../corpus/source-lock"
import { canonicalJson } from "./canonical"
import { verifyFairnessFingerprint, type FairnessFingerprint } from "./fairness"
import { sealCampaign } from "./seal"

export interface CandidateBundleSummary {
  readonly id: string
  readonly kind: "primary" | "guardrail"
  readonly stratum: "private" | "design2code" | "swebench-multimodal" | "guardrail"
  readonly family: string
  readonly bundleSha256: string
  readonly goldSha256: string
}

export interface CandidateValidationReport {
  readonly command: "campaign.validate"
  readonly id: string
  readonly candidateSha256: string
  readonly wouldSealSha256: string
  readonly sourceLockSha256: string
  readonly fairnessFingerprintSha256: string
  readonly taskCount: number
  readonly tasks: readonly CandidateBundleSummary[]
  readonly ok: true
}

export interface CandidateValidationDependencies {
  readonly readJson: (path: string) => Promise<unknown>
  readonly validateSourceAssets: (root: string, lock: SealedSourceLock) => Promise<void>
  readonly validateBundle: (path: string) => Promise<ValidatedBundle>
  readonly writeReport: (path: string, value: unknown) => Promise<void>
}

const defaults: CandidateValidationDependencies = {
  readJson: async (path) => JSON.parse(await readFile(path, "utf8")),
  validateSourceAssets: validateDatasetSourceAssets,
  validateBundle: validateTaskBundle,
  writeReport: writeAtomicJson,
}

export async function validateCandidateAtLayout(
  input: Task24Layout,
  dependencies: CandidateValidationDependencies = defaults,
): Promise<CandidateValidationReport> {
  const layout = verifiedLayout(input)
  const candidatePath = win32.join(layout.runs, "preregistration.candidate.json")
  const [candidate, sourceLock, fingerprint] = await Promise.all([
    dependencies.readJson(candidatePath),
    dependencies.readJson(win32.join(layout.runs, "sources.lock.json")),
    dependencies.readJson(win32.join(layout.runs, "fairness-fingerprint.json")),
  ])
  const sourceVerification = verifySourceLock(sourceLock)
  if (!sourceVerification.ok) throw new TypeError(sourceVerification.reason)
  await dependencies.validateSourceAssets(win32.join(layout.assets, "sources"), sourceVerification.lock)
  const tasks = sealCampaign(candidate).tasks
  const validated = await Promise.all(
    tasks.map((task) => dependencies.validateBundle(win32.join(layout.assets, "tasks", task.id))),
  )
  const bundles = validated.map((bundle) => ({
    id: bundle.manifest.id,
    kind: bundle.manifest.kind,
    stratum: bundle.manifest.stratum,
    family: bundle.manifest.family,
    bundleSha256: bundle.bundleSha256,
    goldSha256: bundle.goldSha256,
  }))
  const report = validateCandidateAuthority({ candidate, sourceLock, fingerprint, bundles })
  await dependencies.writeReport(win32.join(layout.runs, "preregistration.candidate.validation.json"), report)
  return report
}

export async function validateDatasetSourceAssets(root: string, lock: SealedSourceLock): Promise<void> {
  const sourceRoot = await realpath(path.resolve(root))
  for (const dataset of lock.datasets) {
    for (const asset of dataset.assets) {
      const candidate = path.resolve(sourceRoot, dataset.id, dataset.revision, ...asset.path.split("/"))
      if (!strictDescendant(sourceRoot, candidate)) throw new TypeError("TASK24_DATASET_ASSET_PATH_UNSAFE")
      const stat = await lstat(candidate)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        (await realpath(candidate)).toLowerCase() !== candidate.toLowerCase()
      ) {
        throw new TypeError("TASK24_DATASET_ASSET_PATH_UNSAFE")
      }
      if (stat.size !== asset.size || (await sha256File(candidate)) !== asset.sha256) {
        throw new TypeError("TASK24_DATASET_ASSET_HASH_OR_SIZE_MISMATCH")
      }
    }
  }
}

export function validateCandidateAuthority(input: {
  readonly candidate: unknown
  readonly sourceLock: unknown
  readonly fingerprint: unknown
  readonly bundles: readonly CandidateBundleSummary[]
}): CandidateValidationReport {
  const campaign = sealCampaign(input.candidate)
  const sourceVerification = verifySourceLock(input.sourceLock)
  if (!sourceVerification.ok) throw new TypeError(sourceVerification.reason)
  const fairnessVerification = verifyFairnessFingerprint(input.fingerprint)
  if (!fairnessVerification.ok) throw new TypeError(fairnessVerification.reason)

  assertSources(campaign.sources, sourceVerification.lock)
  assertFairness(campaign.toolchain, fairnessVerification.fingerprint)
  assertBundles(campaign.tasks, input.bundles)

  const { sha256: wouldSealSha256, ...candidate } = campaign
  return deepFreeze({
    command: "campaign.validate" as const,
    id: campaign.id,
    candidateSha256: sha256Text(canonicalJson(candidate)),
    wouldSealSha256,
    sourceLockSha256: sourceVerification.lock.sha256,
    fairnessFingerprintSha256: fairnessVerification.fingerprint.sha256,
    taskCount: input.bundles.length,
    tasks: input.bundles.toSorted(compareTask).map((task) => ({ ...task })),
    ok: true as const,
  })
}

function assertSources(actual: readonly unknown[], lock: SealedSourceLock): void {
  const expected = [
    {
      id: lock.upstream.id,
      kind: "git",
      url: lock.upstream.repositoryUrl,
      revision: lock.upstream.revision,
      sha256: lock.upstream.archiveSha256,
      license: lock.upstream.license,
    },
    ...lock.datasets.map((dataset) => ({
      id: dataset.id,
      kind: "dataset",
      url: dataset.repositoryUrl,
      revision: dataset.revision,
      sha256: sha256Text(canonicalJson(dataset)),
      license: dataset.license,
    })),
  ]
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new TypeError("TASK24_CANDIDATE_SOURCE_MISMATCH")
}

function assertFairness(
  actual: {
    readonly bunVersion: string
    readonly nodeVersion: string
    readonly playwrightVersion: string
    readonly chromiumRevision: string
    readonly operatingSystem: string
    readonly sha256: string
  },
  fingerprint: FairnessFingerprint,
): void {
  const expected = {
    bunVersion: fingerprint.runtime.bunVersion,
    nodeVersion: fingerprint.runtime.nodeVersion,
    playwrightVersion: fingerprint.runtime.playwrightVersion,
    chromiumRevision: fingerprint.runtime.chromiumRevision,
    operatingSystem: fingerprint.runtime.operatingSystem,
    sha256: fingerprint.sha256,
  }
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new TypeError("TASK24_CANDIDATE_FAIRNESS_MISMATCH")
}

function assertBundles(tasks: readonly (typeof SealedTask.Type)[], bundles: readonly CandidateBundleSummary[]): void {
  if (bundles.length !== tasks.length || new Set(bundles.map((bundle) => bundle.id)).size !== bundles.length) {
    throw new TypeError("TASK24_CANDIDATE_BUNDLE_MISMATCH")
  }
  const expected = tasks.toSorted(compareTask)
  const actual = bundles.toSorted(compareTask)
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new TypeError("TASK24_CANDIDATE_BUNDLE_MISMATCH")
}

function compareTask(left: { readonly id: string }, right: { readonly id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function strictDescendant(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative.length > 0 && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
}

function deepFreeze<T>(input: T): T {
  if (input !== null && typeof input === "object" && !Object.isFrozen(input)) {
    for (const value of Object.values(input)) deepFreeze(value)
    Object.freeze(input)
  }
  return input
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const staging = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(staging, canonicalJson(value) + "\n", { encoding: "utf8", flag: "wx" })
    await rename(staging, path)
  } finally {
    await rm(staging, { force: true })
  }
}

function verifiedLayout(input: Task24Layout): Task24Layout {
  const expected = Task24Root.make(input.root)
  const keys = ["root", "assets", "cache", "toolchain", "workspaces", "runs", "reports", "tmp"] as const
  if (keys.some((key) => expected[key] !== input[key])) throw new TypeError("TASK24_LAYOUT_FORGED")
  return expected
}
