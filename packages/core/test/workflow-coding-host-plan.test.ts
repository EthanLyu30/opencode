import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Location } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { CodingHostPlan } from "../src/workflow/coding/host-plan"
import { tmpdir } from "./fixture/tmpdir"

describe("Coding admission-frozen check plan", () => {
  test("freezes plain Bun tests in a real workspace without a page or package file", async () => {
    await using tmp = await tmpdir()
    const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
    const plan = CodingHostPlan.freeze({ authority: "admission", location, checks: { cwd: ".", test: "bun-test" } })
    expect(plan.kind).toBe("workflow.coding-host-plan.v1")
    expect(plan.commands).toEqual([{ id: "test", argv: ["bun", "--no-env-file", "test"], reporter: "bun-junit" }])
    expect(plan.configFiles.find((file) => file.path === "package.json")).toEqual({
      path: "package.json",
      state: "absent",
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.commands[0]!.argv)).toBe(true)
    expect(CodingHostPlan.decode(plan, location)).toEqual(plan)
    expect(() => CodingHostPlan.verifyCurrentConfiguration(plan)).not.toThrow()
  })

  test("freezes selected local scripts and all check commands at the admitted nested cwd", async () => {
    await using tmp = await tmpdir()
    const cwd = path.join(tmp.path, "packages", "lib")
    await fs.mkdir(cwd, { recursive: true })
    await fs.writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        scripts: {
          test: "bun test unit --timeout 30000 --only-failures",
          build: "tsc",
          typecheck: "tsc --noEmit",
        },
      }),
    )
    const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
    const plan = CodingHostPlan.freeze({
      authority: "admission",
      location,
      checks: {
        cwd: "packages/lib",
        test: "bun-run-test",
        build: "bun-run-build",
        typecheck: "bun-run-typecheck",
      },
    })
    expect(plan.cwd).toBe("packages/lib")
    expect(plan.commands.map((command) => command.id)).toEqual(["test", "build", "typecheck"])
    expect(plan.commands[0]!.argv).toEqual([
      "bun",
      "--no-env-file",
      "test",
      "unit",
      "--timeout",
      "30000",
      "--only-failures",
    ])
    expect(plan.commands[1]!.argv).toEqual(["bun", "--no-env-file", "run", "build"])
    expect(plan.configFiles.some((file) => file.path === "packages/lib/package.json" && file.state === "present")).toBe(
      true,
    )
    expect(plan.configFiles.some((file) => file.path === "bunfig.toml" && file.state === "absent")).toBe(true)
  })

  test("rejects selected scripts that are absent, non-Bun, shell programs or dotenv overrides", async () => {
    await using tmp = await tmpdir()
    const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
    for (const script of [
      undefined,
      "vitest run",
      "bun test && echo pass",
      "bun test --env-file=.env.local",
      "bun test ../outside",
    ]) {
      await fs.writeFile(path.join(tmp.path, "package.json"), JSON.stringify({ scripts: { test: script } }))
      expect(() =>
        CodingHostPlan.freeze({ authority: "admission", location, checks: { cwd: ".", test: "bun-run-test" } }),
      ).toThrow()
    }
    expect(() =>
      CodingHostPlan.freeze({
        authority: "admission",
        location,
        checks: { cwd: ".", test: "bun-test", build: "bun-run-build" },
      }),
    ).toThrow()
  })

  test("configuration drift includes script edits, added previously-absent files and parent configuration", async () => {
    await using tmp = await tmpdir()
    const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
    const checks = { cwd: ".", test: "bun-test" } as const
    const absent = CodingHostPlan.freeze({ authority: "admission", location, checks })
    await fs.writeFile(path.join(tmp.path, "bunfig.toml"), "[test]\nroot = 'unit'\n")
    expect(() => CodingHostPlan.verifyCurrentConfiguration(absent)).toThrow()
    const existing = CodingHostPlan.freeze({ authority: "admission", location, checks })
    await fs.writeFile(path.join(tmp.path, "bunfig.toml"), "[test]\nroot = 'other'\n")
    expect(() => CodingHostPlan.verifyCurrentConfiguration(existing)).toThrow()
    await fs.mkdir(path.join(tmp.path, "lib"))
    const nested = CodingHostPlan.freeze({ authority: "admission", location, checks: { ...checks, cwd: "lib" } })
    await fs.writeFile(path.join(tmp.path, "package.json"), "{}")
    expect(() => CodingHostPlan.verifyCurrentConfiguration(nested)).toThrow()
  })

  test("rejects traversal, linked workdirs/config files and cross-Location plans", async () => {
    await using tmp = await tmpdir()
    await using other = await tmpdir()
    const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
    const checks = { cwd: ".", test: "bun-test" } as const
    for (const cwd of ["../escape", "D:/foreign", "lib/../escape"]) {
      expect(() => CodingHostPlan.freeze({ authority: "admission", location, checks: { ...checks, cwd } })).toThrow()
    }
    await fs.symlink(other.path, path.join(tmp.path, "linked"), process.platform === "win32" ? "junction" : "dir")
    expect(() =>
      CodingHostPlan.freeze({ authority: "admission", location, checks: { ...checks, cwd: "linked" } }),
    ).toThrow()
    const plan = CodingHostPlan.freeze({ authority: "admission", location, checks })
    expect(() => CodingHostPlan.decode(plan, Location.Ref.make({ directory: AbsolutePath.make(other.path) }))).toThrow()
    await fs.writeFile(path.join(other.path, "package.json"), "{}")
    await fs.symlink(path.join(other.path, "package.json"), path.join(tmp.path, "package.json"), "file")
    expect(() => CodingHostPlan.freeze({ authority: "admission", location, checks })).toThrow()
  })

  test("rejects an ordinary leaf reached through a parent junction or directory alias", async () => {
    await using tmp = await tmpdir()
    const real = path.join(tmp.path, "real")
    const project = path.join(real, "project")
    const alias = path.join(tmp.path, "alias")
    await fs.mkdir(project, { recursive: true })
    await fs.symlink(real, alias, process.platform === "win32" ? "junction" : "dir")
    const checks = { cwd: ".", test: "bun-test" } as const
    const location = Location.Ref.make({ directory: AbsolutePath.make(project) })
    expect(CodingHostPlan.freeze({ authority: "admission", location, checks }).cwd).toBe(".")
    expect(() =>
      CodingHostPlan.freeze({
        authority: "admission",
        location: Location.Ref.make({ directory: AbsolutePath.make(path.join(alias, "project")) }),
        checks,
      }),
    ).toThrow()
    expect(() =>
      CodingHostPlan.freeze({
        authority: "admission",
        location: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
        checks: { ...checks, cwd: "alias/project" },
      }),
    ).toThrow()
  })

  test("rejects forged plan hashes, commands and serialized authority fields", async () => {
    await using tmp = await tmpdir()
    const location = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
    const plan = CodingHostPlan.freeze({ authority: "admission", location, checks: { cwd: ".", test: "bun-test" } })
    expect(() => CodingHostPlan.decode({ ...plan, sha256: "0".repeat(64) }, location)).toThrow()
    expect(() =>
      CodingHostPlan.decode({ ...plan, commands: [{ id: "test", argv: ["powershell", "1"] }] }, location),
    ).toThrow()
    expect(() => CodingHostPlan.decode({ ...plan, preview: {} }, location)).toThrow()
  })
})
