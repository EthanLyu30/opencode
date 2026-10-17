import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { loadEvaluationBundle, exportPublicTask } from "../../src/corpus/evaluation-bundle"
import { sha256Text } from "../../src/hash"
import { independentFixture } from "./fixture"

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
    const body = "synthetic public reference bytes"
    const file = {
      path: "public/reference.png",
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      purpose: "reference",
      origin: "task-public",
    }
    const profile = { ...f.profile, publicInputs: [...f.profile.publicInputs, file] }
    await fs.mkdir(path.join(f.bundleRoot, "private"))
    await fs.writeFile(path.join(f.bundleRoot, "public/reference.png"), body)
    await fs.writeFile(path.join(f.bundleRoot, "private/reference.png"), body)
    await fs.writeFile(path.join(f.bundleRoot, "profile.json"), JSON.stringify(profile))
    await fs.writeFile(
      path.join(f.bundleRoot, "oracle.json"),
      JSON.stringify({
        ...f.oracle,
        privateFiles: [{ ...file, path: "private/reference.png", purpose: undefined, origin: undefined }],
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
