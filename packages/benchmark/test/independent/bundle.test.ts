import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { loadEvaluationBundle, exportPublicTask } from "../../src/corpus/evaluation-bundle"
import { sha256Text, sha256Bytes } from "../../src/hash"
import sharp from "sharp"
import { independentFixture } from "./fixture"

test("review: relabeling a repair as a reference does not authorize its export", async () => {
  const f = await independentFixture("relabel")
  try {
    const body = "export const answer=42",
      entry = { sha256: sha256Text(body), size: Buffer.byteLength(body) }
    await fs.mkdir(path.join(f.bundleRoot, "private"))
    await fs.writeFile(path.join(f.bundleRoot, "private/repair.js"), body)
    await fs.writeFile(path.join(f.bundleRoot, "public/answer.js"), body)
    await fs.writeFile(
      path.join(f.bundleRoot, "profile.json"),
      JSON.stringify({
        ...f.profile,
        publicInputs: [
          ...f.profile.publicInputs,
          { ...entry, path: "public/answer.js", purpose: "reference", origin: "task-public" },
        ],
      }),
    )
    await fs.writeFile(
      path.join(f.bundleRoot, "oracle.json"),
      JSON.stringify({ ...f.oracle, privateFiles: [{ ...entry, path: "private/repair.js" }] }),
    )
    await expect(loadEvaluationBundle(f.bundleRoot)).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})

test("bundle_hashes_bind_both_sides and public export excludes private answers", async () => {
  const f = await independentFixture("bundle")
  try {
    const first = await loadEvaluationBundle(f.bundleRoot)
    const publicTask = exportPublicTask(first)
    expect(JSON.stringify(publicTask)).not.toContain(f.oracleCanary)
    expect(JSON.stringify(publicTask)).not.toContain("expected")
    f.oracle.note += " changed"
    await f.writeBundle()
    const second = await loadEvaluationBundle(f.bundleRoot)
    expect(second.bundleSha256).not.toBe(first.bundleSha256)
    expect(second.profileSha256).toBe(first.profileSha256)
    await fs.writeFile(path.join(f.bundleRoot, "public/src/math.js"), "drift")
    await expect(loadEvaluationBundle(f.bundleRoot)).rejects.toThrow()
    f.profile.publicInputs[0] = { ...f.profile.publicInputs[0]!, sha256: sha256Text("drift"), size: 5 }
    await fs.writeFile(path.join(f.bundleRoot, "profile.json"), JSON.stringify(f.profile))
    const third = await loadEvaluationBundle(f.bundleRoot)
    expect(third.publicFixtureSha256).not.toBe(first.publicFixtureSha256)
  } finally {
    await f.dispose()
  }
})

test("public_reference_is_not_a_gold_leak", async () => {
  const f = await independentFixture("reference")
  try {
    const body = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#123456" } })
      .png()
      .toBuffer()
    const file = {
      path: "public/assets/reference.png",
      sha256: sha256Bytes(body),
      size: Buffer.byteLength(body),
      purpose: "reference",
      origin: "task-public",
    }
    const profile = { ...f.profile, publicInputs: [...f.profile.publicInputs, file] }
    await fs.mkdir(path.join(f.bundleRoot, "private"))
    await fs.mkdir(path.join(f.bundleRoot, "public/assets"))
    await fs.writeFile(path.join(f.bundleRoot, "public/assets/reference.png"), body)
    await fs.writeFile(path.join(f.bundleRoot, "private/reference.png"), body)
    const source = JSON.stringify({
      schemaVersion: 1,
      id: "fixture-add",
      kind: "guardrail",
      stratum: "guardrail",
      family: "synthetic",
      prompt: "Use assets/reference.png",
      normalizationVersion: "fixture",
      source: { id: "fixture", url: "https://example.com/fixture", revision: "fixture", license: "fixture" },
      workspaceFiles: [],
      publicAssets: [{ path: "reference.png", sha256: file.sha256, size: file.size }],
      goldFiles: [],
      licensesSha256: sha256Text("license"),
    })
    await fs.writeFile(path.join(f.bundleRoot, "private/public-source.json"), source)
    const sourceFile = {
      path: "private/public-source.json",
      sha256: sha256Text(source),
      size: Buffer.byteLength(source),
    }
    await fs.writeFile(path.join(f.bundleRoot, "profile.json"), JSON.stringify(profile))
    await fs.writeFile(
      path.join(f.bundleRoot, "oracle.json"),
      JSON.stringify({
        ...f.oracle,
        privateFiles: [{ ...file, path: "private/reference.png", purpose: undefined, origin: undefined }, sourceFile],
        publicReferenceManifest: sourceFile,
      }),
    )
    expect(exportPublicTask(await loadEvaluationBundle(f.bundleRoot)).files).toHaveLength(2)
    await fs.writeFile(
      path.join(f.bundleRoot, "profile.json"),
      JSON.stringify({ ...profile, publicInputs: [...f.profile.publicInputs, { ...file, purpose: "starter" }] }),
    )
    await expect(loadEvaluationBundle(f.bundleRoot)).rejects.toThrow(/LEAK/)
  } finally {
    await f.dispose()
  }
})

test("rejects undeclared files and real links without changing external sentinel", async () => {
  const f = await independentFixture("links")
  try {
    const sentinel = path.join(f.root, "sentinel")
    await fs.writeFile(sentinel, "preserved")
    const link = path.join(f.bundleRoot, "public/alias")
    await fs.link(sentinel, link)
    await expect(loadEvaluationBundle(f.bundleRoot)).rejects.toThrow(/LINK/)
    expect(await fs.readFile(sentinel, "utf8")).toBe("preserved")
    await fs.unlink(link)
    await fs.writeFile(link, "undeclared")
    await expect(loadEvaluationBundle(f.bundleRoot)).rejects.toThrow(/UNDECLARED/)
  } finally {
    await f.dispose()
  }
})
