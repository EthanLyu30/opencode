import { expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"

test("recovery-first startup constructs the complete production route graph without an undefined sandbox dependency", async () => {
  const recovery = pathToFileURL(path.resolve(import.meta.dirname, "../src/workflow/runtime-recovery.ts")).href
  const routes = pathToFileURL(path.resolve(import.meta.dirname, "../src/routes.ts")).href
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `await import(${JSON.stringify(recovery)}); const { routes } = await import(${JSON.stringify(routes)}); if (!routes) throw new Error("Missing production routes"); console.log("complete production graph");`,
    ],
    { cwd: import.meta.dirname, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stderr).toBe("")
  expect(exit).toBe(0)
  expect(stdout.trim()).toBe("complete production graph")
}, 30000)
