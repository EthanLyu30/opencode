import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import template from "../../../../benchmarks/task24/campaign.template.json"
import { canonicalJson } from "../../src/campaign/canonical"
import {
  validateCandidateAtLayout,
  validateCandidateAuthority,
  validateDatasetSourceAssets,
} from "../../src/campaign/candidate"
import type { Task24Layout } from "../../src/root"
import { sealFairnessFingerprint } from "../../src/campaign/fairness"
import { sealSourceLock } from "../../src/corpus/source-lock"
import { sha256Text } from "../../src/hash"

const sha = (digit: string) => digit.repeat(64)
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  while (disposals.length > 0) await disposals.pop()!()
})

function authority() {
  const sourceLock = sealSourceLock({
    schemaVersion: 1,
    upstream: {
      id: "opencode-upstream",
      kind: "git",
      repositoryUrl: "https://github.com/anomalyco/opencode",
      tag: "v1.2.3",
      revision: "a".repeat(40),
      archiveSha256: sha("1"),
      lockedAt: "2026-09-12T12:00:00.000Z",
      license: "MIT",
    },
    datasets: [
      {
        id: "design2code-hard",
        kind: "dataset",
        repositoryUrl: "https://huggingface.co/datasets/SALT-NLP/Design2Code-HARD",
        revision: "b".repeat(40),
        subset: "default/train:g29,g38,g41,g63",
        itemIDs: ["g29", "g38", "g41", "g63"],
        assets: [],
        normalizationVersion: "task24-normalization-v1",
        license: "ODC-By-1.0",
      },
      {
        id: "swebench-multimodal-js",
        kind: "dataset",
        repositoryUrl: "https://huggingface.co/datasets/SWE-bench/SWE-bench_Multimodal",
        revision: "c".repeat(40),
        subset: "default/dev",
        itemIDs: ["chart-1", "chart-2", "pdf-1", "marked-1"],
        assets: [],
        normalizationVersion: "task24-normalization-v1",
        license: "mixed-upstream-licenses",
      },
    ],
  })
  const fingerprint = sealFairnessFingerprint({
    schemaVersion: 1,
    capturedAt: "2026-09-12T12:00:00.000Z",
    roots: {
      task24: "D:\\OpenCode-Benchmark\\Task24",
      bun: "D:\\OpenCode-Toolchain\\bun-1.3.14\\bun-windows-x64\\bun.exe",
      browserRuntime:
        "D:\\OpenCode-Benchmark\\Task24\\toolchain\\browser\\2b1d4571560f5ce2772a46246070649c47bcdd77a634ab70dbf68bd35f5a967e",
      upstreamSource: "D:\\OpenCode-Benchmark\\Task24\\toolchain\\upstream-src",
    },
    runtime: {
      bunVersion: "1.3.14",
      nodeVersion: "24.18.0",
      playwrightVersion: "1.59.1",
      chromiumRevision: "chromium-1234567",
      operatingSystem: "Windows 10 10.0.26200",
      locale: "zh-CN",
      timeZone: "Asia/Shanghai",
    },
    docker: { engineVersion: "29.5.3", imageDigest: `sha256:${sha("6")}` },
    fonts: [{ name: "Segoe UI", path: "C:\\Windows\\Fonts\\segoeui.ttf", sha256: sha("8") }],
    viewports: {
      mobile: { width: 390, height: 844, deviceScaleFactor: 1 },
      tablet: { width: 768, height: 1024, deviceScaleFactor: 1 },
      desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
    },
    evaluatorCommands: ["bun test --timeout 30000"],
    allowedDependencyMirrors: [],
    externalNetworkPolicy: "deny-except-approved-provider-broker",
  })
  return { sourceLock, fingerprint }
}

function candidateFixture() {
  const { sourceLock, fingerprint } = authority()
  const primary = Array.from({ length: 12 }, (_, index) => ({
    id: `primary-${index + 1}`,
    kind: "primary" as const,
    stratum: (["private", "design2code", "swebench-multimodal"] as const)[Math.floor(index / 4)]!,
    family: `family-${index + 1}`,
    bundleSha256: sha(((index + 1) % 10).toString()),
    goldSha256: sha(((index + 2) % 10).toString()),
  }))
  const guardrails = Array.from({ length: 4 }, (_, index) => ({
    id: `guardrail-${index + 1}`,
    kind: "guardrail" as const,
    stratum: "guardrail" as const,
    family: ["debugging", "data", "backend", "refactor"][index]!,
    bundleSha256: sha(((index + 3) % 10).toString()),
    goldSha256: sha(((index + 4) % 10).toString()),
  }))
  const source = (dataset: (typeof sourceLock.datasets)[number]) => ({
    id: dataset.id,
    kind: "dataset" as const,
    url: dataset.repositoryUrl,
    revision: dataset.revision,
    sha256: sha256Text(canonicalJson(dataset)),
    license: dataset.license,
  })
  const tasks = [...primary, ...guardrails]
  const candidate = {
    ...structuredClone(template),
    createdAt: "2026-09-12T12:00:00.000Z",
    preregistration: {
      ...structuredClone(template.preregistration),
      maxConcurrency: 1,
      seed: "task24-sealed-order-v1",
      budget: {
        aggregateInputTokens: 200_000,
        aggregateOutputTokens: 40_000,
        maxToolCalls: 120,
        maxRetries: 3,
        maxDurationMs: 3_600_000,
      },
    },
    binaries: {
      modified: {
        version: "candidate",
        commit: sha("a"),
        sha256: sha("b"),
        sourceUrl: template.binaries.modified.sourceUrl,
      },
      upstream: {
        version: "v1.2.3",
        commit: sha("c"),
        sha256: sha("d"),
        sourceUrl: template.binaries.upstream.sourceUrl,
      },
    },
    sources: [
      {
        id: sourceLock.upstream.id,
        kind: "git" as const,
        url: sourceLock.upstream.repositoryUrl,
        revision: sourceLock.upstream.revision,
        sha256: sourceLock.upstream.archiveSha256,
        license: sourceLock.upstream.license,
      },
      ...sourceLock.datasets.map(source),
    ],
    tasks,
    pricing: template.pricing.map((price) => ({
      ...price,
      capturedAt: "2026-09-12T12:00:00.000Z",
      inputMicrosPerMillion: "1",
      cachedInputMicrosPerMillion: "1",
      outputMicrosPerMillion: "1",
      reasoningMicrosPerMillion: "1",
    })),
    exchangeRate: {
      ...template.exchangeRate,
      decimalRate: "0.14",
      sourceUrl: "https://example.test/rate",
      capturedAt: "2026-09-12T12:00:00.000Z",
    },
    toolchain: {
      bunVersion: fingerprint.runtime.bunVersion,
      nodeVersion: fingerprint.runtime.nodeVersion,
      playwrightVersion: fingerprint.runtime.playwrightVersion,
      chromiumRevision: fingerprint.runtime.chromiumRevision,
      operatingSystem: fingerprint.runtime.operatingSystem,
      sha256: fingerprint.sha256,
    },
    evaluator: { ...structuredClone(template.evaluator), version: "task24-evaluator-v1", sha256: sha("e") },
  }
  const bundles = tasks.map((task) => ({ ...task }))
  return { candidate, sourceLock, fingerprint, bundles }
}

describe("Task24 candidate preregistration validation", () => {
  test("validates all 16 bundles and returns a deterministic non-sealing report", () => {
    const input = candidateFixture()
    const report = validateCandidateAuthority(input)

    expect(report).toMatchObject({ command: "campaign.validate", id: "task24-candidate", taskCount: 16, ok: true })
    expect(report.candidateSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(report.wouldSealSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(report.sourceLockSha256).toBe(input.sourceLock.sha256)
    expect(report.fairnessFingerprintSha256).toBe(input.fingerprint.sha256)
    expect(report.tasks).toHaveLength(16)
  })

  test("rejects bundle, source, and fairness drift instead of validating placeholders", () => {
    const bundleDrift = candidateFixture()
    bundleDrift.bundles[0] = { ...bundleDrift.bundles[0]!, bundleSha256: sha("f") }
    expect(() => validateCandidateAuthority(bundleDrift)).toThrow("TASK24_CANDIDATE_BUNDLE_MISMATCH")

    const sourceDrift = candidateFixture()
    sourceDrift.candidate.sources[1]!.sha256 = sha("f")
    expect(() => validateCandidateAuthority(sourceDrift)).toThrow("TASK24_CANDIDATE_SOURCE_MISMATCH")

    const fairnessDrift = candidateFixture()
    fairnessDrift.candidate.toolchain.sha256 = sha("f")
    expect(() => validateCandidateAuthority(fairnessDrift)).toThrow("TASK24_CANDIDATE_FAIRNESS_MISMATCH")
  })

  test("loads every bundle from the fixed D root and atomically publishes only a validation report", async () => {
    const input = candidateFixture()
    const layout: Task24Layout = {
      root: "D:\\OpenCode-Benchmark\\Task24",
      assets: "D:\\OpenCode-Benchmark\\Task24\\assets",
      cache: "D:\\OpenCode-Benchmark\\Task24\\cache",
      toolchain: "D:\\OpenCode-Benchmark\\Task24\\toolchain",
      workspaces: "D:\\OpenCode-Benchmark\\Task24\\workspaces",
      runs: "D:\\OpenCode-Benchmark\\Task24\\runs",
      reports: "D:\\OpenCode-Benchmark\\Task24\\reports",
      tmp: "D:\\OpenCode-Benchmark\\Task24\\tmp",
    }
    const reads = new Map<string, unknown>([
      [`${layout.runs}\\preregistration.candidate.json`, input.candidate],
      [`${layout.runs}\\sources.lock.json`, input.sourceLock],
      [`${layout.runs}\\fairness-fingerprint.json`, input.fingerprint],
    ])
    const requestedBundles: string[] = []
    const sourceValidations: string[] = []
    const writes: Array<{ path: string; value: unknown }> = []

    const result = await validateCandidateAtLayout(layout, {
      readJson: async (path) => reads.get(path),
      validateSourceAssets: async (root, lock) => void sourceValidations.push(`${root}:${lock.sha256}`),
      validateBundle: async (path) => {
        requestedBundles.push(path)
        const id = path.slice(path.lastIndexOf("\\") + 1)
        const bundle = input.bundles.find((entry) => entry.id === id)!
        return {
          root: path,
          manifest: {
            schemaVersion: 1,
            ...bundle,
            prompt: "fixture",
            normalizationVersion: "task24-normalization-v1",
            source: { id: "fixture", url: "https://example.test/source", revision: "a".repeat(40), license: "MIT" },
            workspaceFiles: [],
            publicAssets: [],
            goldFiles: [],
            licensesSha256: sha("1"),
          },
          files: [],
          bundleSha256: bundle.bundleSha256,
          goldSha256: bundle.goldSha256,
        }
      },
      writeReport: async (path, value) => void writes.push({ path, value }),
    })

    expect(result.ok).toBe(true)
    expect(requestedBundles).toHaveLength(16)
    expect(requestedBundles.every((path) => path.startsWith(`${layout.assets}\\tasks\\`))).toBe(true)
    expect(sourceValidations).toEqual([`${layout.assets}\\sources:${input.sourceLock.sha256}`])
    expect(writes).toEqual([{ path: `${layout.runs}\\preregistration.candidate.validation.json`, value: result }])
  })

  test("verifies every locked dataset asset by direct path, size, and SHA-256", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "task24-source-assets-"))
    disposals.push(() => rm(root, { recursive: true, force: true }))
    const input = authority().sourceLock
    const datasets = input.datasets.map((dataset, index) => ({
      ...dataset,
      assets: [{ path: "selected/item.bin", sha256: sha256Text(`asset-${index}`), size: 7 }],
    }))
    const locked = sealSourceLock({ schemaVersion: 1, upstream: input.upstream, datasets })
    for (let index = 0; index < locked.datasets.length; index++) {
      const dataset = locked.datasets[index]!
      const directory = path.join(root, dataset.id, dataset.revision, "selected")
      await mkdir(directory, { recursive: true })
      await Bun.write(path.join(directory, "item.bin"), `asset-${index}`)
    }

    await expect(validateDatasetSourceAssets(root, locked)).resolves.toBeUndefined()
    await Bun.write(
      path.join(root, locked.datasets[0]!.id, locked.datasets[0]!.revision, "selected", "item.bin"),
      "changed",
    )
    await expect(validateDatasetSourceAssets(root, locked)).rejects.toThrow(
      "TASK24_DATASET_ASSET_HASH_OR_SIZE_MISMATCH",
    )
  })
})
