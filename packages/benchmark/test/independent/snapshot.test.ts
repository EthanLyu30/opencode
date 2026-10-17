import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { captureCandidate, verifyCandidate, validateCandidateEntries } from "../../src/evaluator/independent/snapshot"
import { decodeTaskExecutionProfile } from "../../src/corpus/evaluation-profile"
import { independentFixture } from "./fixture"

test("drift_after_capture_is_not_evaluated and original is preserved", async () => {
  const f = await independentFixture("snapshot")
  try {
    const snapshot = await captureCandidate({
      sourceRoot: f.sourceRoot,
      workRoot: f.workRoot,
      profile: decodeTaskExecutionProfile(f.profile),
    })
    await verifyCandidate(snapshot)
    expect(await fs.readFile(path.join(f.sourceRoot, "src/math.js"), "utf8")).toBe(f.source)
    expect(await fs.readFile(snapshot.archiveFile, "utf8")).not.toContain(f.oracleCanary)
    await fs.writeFile(path.join(f.sourceRoot, "src/math.js"), "export const add = (a,b) => a*b")
    await expect(verifyCandidate(snapshot)).rejects.toThrow("TASK24_CANDIDATE_DRIFT")
  } finally {
    await f.dispose()
  }
})
test("rejects_link_alias_and_path_collisions and leaves external sentinel", async () => {
  const f = await independentFixture("snapshot-link")
  try {
    const sentinel = path.join(f.root, "sentinel")
    await fs.writeFile(sentinel, "unchanged")
    await fs.link(sentinel, path.join(f.sourceRoot, "alias"))
    await expect(
      captureCandidate({
        sourceRoot: f.sourceRoot,
        workRoot: f.workRoot,
        profile: decodeTaskExecutionProfile(f.profile),
      }),
    ).rejects.toThrow(/LINK/)
    expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged")
    const file = { path: "a", size: 1, sha256: "a".repeat(64) }
    for (const files of [
      [],
      [{ ...file, path: "NUL.js" }],
      [{ ...file, path: "a:stream" }],
      [file, { ...file, path: "A" }],
      [{ ...file, size: 8 * 1024 * 1024 + 1 }],
      Array.from({ length: 20001 }, (_, i) => ({ ...file, path: `a${i}` })),
      Array.from({ length: 9 }, (_, i) => ({ ...file, path: `b${i}`, size: 8 * 1024 * 1024 })),
    ])
      expect(() => validateCandidateEntries(files)).toThrow()
  } finally {
    await f.dispose()
  }
})
test("rejects junction, root overlap, dependency and private files; protected config drift and stale dist change identity", async () => {
  const f = await independentFixture("snapshot-config")
  try {
    const profile = decodeTaskExecutionProfile({ ...f.profile, protectedPaths: ["package.json"] })
    await fs.writeFile(path.join(f.sourceRoot, "package.json"), "{}")
    await fs.symlink(f.bundleRoot, path.join(f.sourceRoot, "linked"), "junction")
    await expect(captureCandidate({ sourceRoot: f.sourceRoot, workRoot: f.workRoot, profile })).rejects.toThrow(/LINK/)
    await fs.unlink(path.join(f.sourceRoot, "linked"))
    await expect(
      captureCandidate({ sourceRoot: f.sourceRoot, workRoot: path.join(f.sourceRoot, "work"), profile }),
    ).rejects.toThrow(/OVERLAP/)
    await fs.mkdir(path.join(f.sourceRoot, "dist"))
    await fs.writeFile(path.join(f.sourceRoot, "dist/old.js"), "stale")
    const s = await captureCandidate({ sourceRoot: f.sourceRoot, workRoot: f.workRoot, profile })
    await fs.writeFile(path.join(f.sourceRoot, "dist/old.js"), "changed")
    await expect(verifyCandidate(s)).rejects.toThrow(/DRIFT/)
    await fs.writeFile(path.join(f.sourceRoot, "dist/old.js"), "stale")
    await fs.writeFile(path.join(f.sourceRoot, "package.json"), '{"scripts":{}}')
    await expect(verifyCandidate(s)).rejects.toThrow(/DRIFT/)
  } finally {
    await f.dispose()
  }
})
