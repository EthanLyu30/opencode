import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { safeExtractTar, validateArchiveEntries } from "../../src/corpus/archive"
import { validateTaskBundle } from "../../src/corpus/validate"
import { sha256File } from "../../src/hash"
import { taskFixture } from "./fixture"

const disposals: Array<() => Promise<void>> = []
afterEach(async () => {
  while (disposals.length > 0) await disposals.pop()!()
})

describe("Task24 task bundle validation", () => {
  test("validates exact declared starter, public asset, gold, and license bytes", async () => {
    const fixture = await taskFixture("valid")
    disposals.push(() => fixture.dispose())

    const validated = await validateTaskBundle(fixture.bundle)

    expect(validated.manifest.id).toBe("fixture-valid")
    expect(validated.bundleSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(validated.goldSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(validated.files.map((file) => file.path)).toEqual([
      "LICENSES.json",
      "assets/reference.bin",
      "gold/index.html",
      "starter/index.html",
      "task.json",
    ])
  })

  test("rejects hash drift and every undeclared workspace byte", async () => {
    const fixture = await taskFixture("drift")
    disposals.push(() => fixture.dispose())
    await Bun.write(path.join(fixture.bundle, "starter", "undeclared.txt"), "undeclared")
    await expect(validateTaskBundle(fixture.bundle)).rejects.toThrow(/undeclared/i)

    await fs.rm(path.join(fixture.bundle, "starter", "undeclared.txt"))
    await Bun.write(path.join(fixture.bundle, "starter", "index.html"), "changed")
    await expect(validateTaskBundle(fixture.bundle)).rejects.toThrow(/hash|size/i)
  })

  test("rejects prompt leakage of gold hashes, bytes, DOM snapshots, and evaluator commands", async () => {
    for (const [label, leak] of [
      ["hash", "GOLD_HASH"],
      ["bytes", "GOLD_BYTES"],
      ["dom", "expected DOM snapshot: <main>Expected result</main>"],
      ["command", "Run evaluator command playwright test --update-snapshots"],
    ] as const) {
      const fixture = await taskFixture(`leak-${label}`)
      disposals.push(() => fixture.dispose())
      const task = structuredClone(fixture.task)
      task.prompt =
        leak === "GOLD_HASH"
          ? `Use ${task.goldFiles[0].sha256}`
          : leak === "GOLD_BYTES"
            ? Buffer.from(fixture.goldText).toString("base64")
            : leak
      await Bun.write(path.join(fixture.bundle, "task.json"), JSON.stringify(task))
      await expect(validateTaskBundle(fixture.bundle)).rejects.toThrow(/leak/i)
    }
  })

  test("rejects NTFS reparse or symlink escapes before reading task content", async () => {
    const fixture = await taskFixture("link")
    disposals.push(() => fixture.dispose())
    const outside = path.join(fixture.root, "outside.txt")
    await Bun.write(outside, "outside")
    await fs.symlink(outside, path.join(fixture.bundle, "starter", "escape.txt"), "file")

    await expect(validateTaskBundle(fixture.bundle)).rejects.toThrow(/link|reparse/i)
  })

  test.each(["../outside", "/absolute", "C:/outside", "safe/../../outside", "safe\\escape"])(
    "rejects archive traversal entry %s",
    (entry) => expect(() => validateArchiveEntries([entry])).toThrow(/archive/i),
  )

  test("extracts a verified ordinary archive into one direct root", async () => {
    const fixture = await taskFixture("archive")
    disposals.push(() => fixture.dispose())
    const source = path.join(fixture.root, "archive-source", "root")
    const archive = path.join(fixture.root, "fixture.tar.gz")
    const destination = path.join(fixture.root, "archive-output")
    await fs.mkdir(source, { recursive: true })
    await Bun.write(path.join(source, "file.txt"), "archive fixture")
    const child = Bun.spawn(["tar", "-czf", archive, "-C", path.dirname(source), "root"], {
      stdout: "ignore",
      stderr: "pipe",
    })
    const stderr = new Response(child.stderr).text()
    expect(await child.exited).toBe(0)
    expect(await stderr).toBe("")

    const extracted = await safeExtractTar({ archive, destination, expectedSha256: await sha256File(archive) })

    expect(await Bun.file(path.join(extracted.root, "file.txt")).text()).toBe("archive fixture")
    expect(extracted.entries).toContain("root/file.txt")
  })
})
