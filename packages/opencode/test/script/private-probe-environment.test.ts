import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("both private executable guards retain runtime NODE_ENV despite compile-time substitution", async () => {
  await using temporary = await tmpdir()
  const expressions = await Promise.all(
    [
      path.resolve(import.meta.dirname, "../../src/index.ts"),
      path.resolve(import.meta.dirname, "../../../server/test/fixtures/workflow-model-catalog-worker.ts"),
    ].map(async (file) => {
      const source = await fs.readFile(file, "utf8")
      const expression = source.match(/process\.env\.NODE_ENV|Reflect\.get\(process\.env, "NODE_ENV"\)/)?.[0]
      if (!expression) throw new Error("Private guard environment expression changed")
      return expression
    }),
  )
  const entry = path.join(temporary.path, "environment.ts")
  await fs.writeFile(entry, `console.log(JSON.stringify([${expressions.join(",")}]))`)
  // Reproduce the reserved define observed in a real minified Bun executable, without launching an unsigned temp PE.
  const result = await Bun.build({
    entrypoints: [entry],
    minify: true,
    target: "bun",
    outdir: temporary.path,
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
  })
  expect(result.success).toBe(true)
  const bundle = result.outputs[0]!.path
  const child = Bun.spawn([process.execPath, "--no-env-file", bundle], {
    cwd: temporary.path,
    env: { ...process.env, NODE_ENV: "test" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = new Response(child.stdout).text()
  const diagnostics = new Response(child.stderr).text()
  const exit = await child.exited
  const diagnostic = await diagnostics
  if (exit !== 0) throw new Error(`Environment-only compiled fixture failed: ${diagnostic.slice(0, 1000)}`)
  expect(exit).toBe(0)
  expect(JSON.parse(await output)).toEqual(["test", "test"])
}, 30_000)
