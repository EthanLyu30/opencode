import { describe, expect, test } from "bun:test"
import { PreviewPlan } from "@opencode-ai/core/workflow/preview-plan"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { WorkflowVisualBuild } from "@opencode-ai/schema/workflow-visual-build"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"

const payload = {
  prompt: "Build the approved product page",
  budget: { maxTokens: 20_000, maxTurns: 20, maxToolCalls: 40, maxAttempts: 3, maxDurationMs: 120_000 },
  visual: { maxRevisions: 2, maxTokens: 8_000, maxTurns: 8, maxToolCalls: 8 },
  delivery: "background" as const,
}

function location(directory: string): Location.Ref {
  return Location.Ref.make({ directory: AbsolutePath.make(directory) })
}

function freeze(
  directory: string,
  preview?: WorkflowVisualBuild.TrustedPreviewInput,
  input: Partial<Omit<PreviewPlan.FreezeInput, "authority" | "location" | "preview">> = {},
) {
  return PreviewPlan.freeze({
    authority: "admission",
    location: location(directory),
    preview,
    ...input,
  })
}

function freezeUnknown(input: unknown) {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- exercises the runtime admission guard
  return PreviewPlan.freeze(input as PreviewPlan.FreezeInput)
}

function freezePreviewUnknown(directory: string, preview: unknown) {
  return freezeUnknown({ authority: "admission", location: location(directory), preview })
}

function configurationFailure(plan: PreviewPlan.PreviewPlan): unknown {
  try {
    PreviewPlan.verifyConfiguration(plan)
    return undefined
  } catch (error) {
    return error
  }
}

describe("WorkflowVisualBuild.CreateInput", () => {
  test("accepts only the user prompt, budgets, trusted preview choice, and delivery mode", () => {
    const decoded = Schema.decodeUnknownSync(WorkflowVisualBuild.CreateInput)({
      ...payload,
      preview: { kind: "static", cwd: ".", entrypoint: "index.html" },
    })

    expect(decoded.prompt).toBe(payload.prompt)
    expect(decoded.preview).toEqual({ kind: "static", cwd: ".", entrypoint: "index.html" })
  })

  test.each(["directory", "workspaceID", "url", "previewUrl", "provider", "model"])(
    "rejects public %s authority",
    (field) => {
      expect(() =>
        Schema.decodeUnknownSync(WorkflowVisualBuild.CreateInput)({ ...payload, [field]: "forbidden" }),
      ).toThrow()
    },
  )

  test("rejects URL and shell-string authority inside trusted preview configuration", () => {
    for (const preview of [
      { kind: "static", entrypoint: "index.html", url: "http://127.0.0.1:4000/" },
      { kind: "script", argv: ["bun", "run", "dev"], provider: "deepseek" },
      { kind: "script", command: "bun run dev" },
    ]) {
      expect(() => Schema.decodeUnknownSync(WorkflowVisualBuild.CreateInput)({ ...payload, preview })).toThrow()
    }
  })
})

describe("PreviewPlan.freeze", () => {
  test("freezes a canonical static entrypoint without shell or URL authority", async () => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "index.html"), "<!doctype html><title>Static</title>")

    const plan = freeze(
      root.path,
      { kind: "static", cwd: ".", entrypoint: "index.html" },
      {
        allowedOrigins: ["http://127.0.0.1:4317"],
      },
    )

    expect(plan.kind).toBe("static")
    expect(plan.cwd).toBe(root.path)
    expect(plan.entrypoint).toBe(path.join(root.path, "index.html"))
    expect(plan.argv).toBeUndefined()
    expect(plan.allowedOrigins).toEqual(["http://127.0.0.1:4317"])
    expect(plan.configSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.allowedOrigins)).toBe(true)
  })

  test("rejects a forged static plan carrying a command-configuration manifest", async () => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "index.html"), "<!doctype html>")
    const admitted = freeze(root.path, { kind: "static", entrypoint: "index.html" })
    const forged = Object.freeze({
      ...admitted,
      configFiles: Object.freeze([Object.freeze({ path: "package.json", sha256: "a".repeat(64), size: 0 })]),
    })

    expect(PreviewPlan.isFrozen(forged)).toBe(false)
  })

  test("rejects frozen nested values carrying hidden URL or provider authority", async () => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "index.html"), "<!doctype html>")
    const admitted = freeze(root.path, { kind: "static", entrypoint: "index.html" })
    const originsWithURL = Object.freeze(
      Object.assign([...admitted.allowedOrigins], { url: "https://example.com/preview" }),
    )
    const envWithProvider = { ...admitted.env }
    Object.defineProperty(envWithProvider, "provider", { value: "forbidden", enumerable: false })
    Object.freeze(envWithProvider)

    expect([
      PreviewPlan.isFrozen(Object.freeze({ ...admitted, allowedOrigins: originsWithURL })),
      PreviewPlan.isFrozen(Object.freeze({ ...admitted, env: envWithProvider })),
    ]).toEqual([false, false])
  })

  test.each([
    ["Vite", { scripts: { preview: "vite preview" }, devDependencies: { vite: "7.0.0" } }, ["bun", "run", "preview"]],
    ["Next", { scripts: { dev: "next dev" }, dependencies: { next: "16.0.0" } }, ["bun", "run", "dev"]],
  ] as const)("recognizes a shell-free %s package script", async (_, packageJson, argv) => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "package.json"), JSON.stringify(packageJson, null, 2))

    const plan = freeze(root.path)

    expect(plan.kind).toBe("script")
    expect(plan.argv).toEqual([...argv])
    expect(plan.configFiles.map((file) => file.path)).toEqual(["package.json"])
    expect(plan.configFiles[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  test("prefers a recognized Vite script over raw static hosting", async () => {
    await using root = await tmpdir()
    await fs.writeFile(
      path.join(root.path, "index.html"),
      '<!doctype html><script type="module" src="/src.ts"></script>',
    )
    await fs.writeFile(
      path.join(root.path, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "7.0.0" } }),
    )

    const plan = freeze(root.path)

    expect(plan.kind).toBe("script")
    expect(plan.argv).toEqual(["bun", "run", "dev"])
  })

  test("freezes explicit user argv and only allowlisted environment values", async () => {
    await using root = await tmpdir()
    await fs.writeFile(
      path.join(root.path, "package.json"),
      JSON.stringify({ scripts: { storybook: "storybook dev" }, devDependencies: { storybook: "10.0.0" } }),
    )

    const plan = freeze(
      root.path,
      { kind: "script", cwd: ".", argv: ["bun", "run", "storybook"], env: { NODE_ENV: "production" } },
      {
        environment: { CI: "1", UNTRUSTED: "ignored" },
        envAllowlist: ["CI", "NODE_ENV"],
      },
    )

    expect(plan.kind).toBe("script")
    expect(plan.argv).toEqual(["bun", "run", "storybook"])
    expect(plan.env).toEqual({ CI: "1", NODE_ENV: "production" })
    expect(Object.isFrozen(plan.env)).toBe(true)
  })

  test("requires typed user configuration for an unknown project", async () => {
    await using root = await tmpdir()

    expect(() => freeze(root.path)).toThrow(PreviewPlan.PreviewConfigurationRequired)
    try {
      freeze(root.path)
    } catch (error) {
      expect(error).toMatchObject({ code: "preview_configuration_required" })
    }
  })

  test("freezes relevant configuration hashes and detects later mutation", async () => {
    await using root = await tmpdir()
    const packageFile = path.join(root.path, "package.json")
    await fs.writeFile(
      packageFile,
      JSON.stringify({ scripts: { preview: "vite preview" }, devDependencies: { vite: "7.0.0" } }),
    )
    const plan = freeze(root.path)
    const frozenHash = plan.configSha256

    await fs.writeFile(
      packageFile,
      JSON.stringify({ scripts: { preview: "node stolen.js" }, devDependencies: { vite: "7.0.0" } }),
    )

    expect(plan.configSha256).toBe(frozenHash)
    expect(() => PreviewPlan.verifyConfiguration(plan)).toThrow(/changed/i)
  })

  test("observes pinned Bun resolving a package script from a Location ancestor", async () => {
    await using root = await tmpdir()
    const site = path.join(root.path, "site")
    await fs.mkdir(site)
    await fs.writeFile(
      path.join(root.path, "package.json"),
      JSON.stringify({ scripts: { preview: "echo ancestor-manifest" } }),
    )
    await fs.writeFile(path.join(site, "preview"), "console.log('local-entrypoint')")
    const child = Bun.spawn([process.execPath, "run", "preview"], {
      cwd: site,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])

    expect(exitCode).toBe(0)
    expect(stdout).toContain("ancestor-manifest")
    expect(stdout).not.toContain("local-entrypoint")
  })

  test("detects mutation of the ancestor manifest resolved by Bun run", async () => {
    await using root = await tmpdir()
    const site = path.join(root.path, "site")
    const packageFile = path.join(root.path, "package.json")
    await fs.mkdir(site)
    await fs.writeFile(packageFile, JSON.stringify({ scripts: { preview: "echo admitted" } }))
    const plan = freeze(root.path, { kind: "script", cwd: "site", argv: ["bun", "run", "preview"] })
    await fs.writeFile(packageFile, JSON.stringify({ scripts: { preview: "echo changed" } }))

    const failure = configurationFailure(plan)

    expect(plan.configFiles.map((file) => file.path)).toContain("package.json")
    expect(failure).toBeInstanceOf(PreviewPlan.Invalid)
    expect(failure).toMatchObject({ code: "preview_configuration_changed" })
  })

  test("freezes the workspace package-manager configuration chain", async () => {
    await using root = await tmpdir()
    const site = path.join(root.path, "site")
    const bunfig = path.join(root.path, "bunfig.toml")
    await fs.mkdir(site)
    await fs.writeFile(path.join(root.path, "package.json"), JSON.stringify({ workspaces: ["site"] }))
    await fs.writeFile(path.join(root.path, "bun.lock"), "{}")
    await fs.writeFile(bunfig, 'logLevel = "warn"')
    await fs.writeFile(path.join(site, "package.json"), JSON.stringify({ scripts: { preview: "echo admitted" } }))
    const plan = freeze(root.path, { kind: "script", cwd: "site", argv: ["bun", "run", "preview"] })
    await fs.writeFile(bunfig, 'logLevel = "error"')

    const failure = configurationFailure(plan)

    expect(plan.configFiles.map((file) => file.path)).toEqual([
      "package.json",
      "bun.lock",
      "bunfig.toml",
      "site/package.json",
    ])
    expect(failure).toMatchObject({ code: "preview_configuration_changed" })
  })

  test.each([
    ["bun flag before run", ["bun", "--cwd", "..", "run", "preview"]],
    ["bun flag after script", ["bun", "run", "preview", "--cwd", ".."]],
    ["npm prefix", ["npm", "--prefix", "..", "run", "preview"]],
    ["pnpm directory", ["pnpm", "--dir", "..", "run", "preview"]],
    ["yarn cwd", ["yarn", "--cwd", "..", "run", "preview"]],
    ["npm run-script alias", ["npm", "run-script", "preview"]],
    ["npm lifecycle alias", ["npm", "start"]],
    ["pnpm implicit run", ["pnpm", "preview"]],
    ["yarn implicit run", ["yarn", "preview"]],
  ])("rejects ambiguous package-manager argv: %s", async (_, argv) => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "package.json"), JSON.stringify({ scripts: { preview: "echo preview" } }))

    expect(() => freezePreviewUnknown(root.path, { kind: "script", argv })).toThrow(PreviewPlan.Invalid)
  })

  test("rejects Bun's implicit package-script form even when a same-named local file exists", async () => {
    await using root = await tmpdir()
    const site = path.join(root.path, "site")
    await fs.mkdir(site)
    await fs.writeFile(path.join(site, "preview"), "console.log('local file')")
    await fs.writeFile(
      path.join(root.path, "package.json"),
      JSON.stringify({ scripts: { preview: "echo ancestor script" } }),
    )
    const child = Bun.spawn([process.execPath, "preview"], {
      cwd: site,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])

    expect(exitCode).toBe(0)
    expect(stdout).toContain("ancestor script")
    expect(stdout).not.toContain("local file")
    expect(() => freeze(root.path, { kind: "script", cwd: "site", argv: ["bun", "preview"] })).toThrow(
      PreviewPlan.Invalid,
    )
  })

  test.each(["bun", "bun.exe", "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"])(
    "accepts canonical %s run argv",
    async (executable) => {
      await using root = await tmpdir()
      await fs.writeFile(path.join(root.path, "package.json"), JSON.stringify({ scripts: { preview: "echo preview" } }))

      expect(freeze(root.path, { kind: "script", argv: [executable, "run", "preview"] }).argv).toEqual([
        executable,
        "run",
        "preview",
      ])
    },
  )

  test("rejects a package-manager run with no in-Location manifest", async () => {
    await using root = await tmpdir()

    expect(() => freeze(root.path, { kind: "script", argv: ["bun", "run", "preview"] })).toThrow(PreviewPlan.Invalid)
  })

  test("rejects a package-manager run absent from its nearest manifest", async () => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "package.json"), JSON.stringify({ scripts: { other: "echo other" } }))

    expect(() => freeze(root.path, { kind: "script", argv: ["bun", "run", "preview"] })).toThrow(PreviewPlan.Invalid)
  })

  test("keeps a direct Node script while freezing its ancestor module configuration", async () => {
    await using root = await tmpdir()
    const site = path.join(root.path, "site")
    const packageFile = path.join(root.path, "package.json")
    await fs.mkdir(site)
    await fs.writeFile(path.join(site, "server.mjs"), "console.log('preview')")
    await fs.writeFile(packageFile, JSON.stringify({ type: "module" }))
    const plan = freeze(root.path, { kind: "script", cwd: "site", argv: ["node", "server.mjs"] })
    await fs.writeFile(packageFile, JSON.stringify({ type: "commonjs" }))

    expect(plan.argv).toEqual(["node", "server.mjs"])
    expect(plan.configFiles.map((file) => file.path)).toContain("package.json")
    expect(configurationFailure(plan)).toMatchObject({ code: "preview_configuration_changed" })
  })

  test("freezes the nested package scope that changes direct Node .js execution", async () => {
    await using root = await tmpdir()
    const site = path.join(root.path, "site")
    const sub = path.join(site, "sub")
    const packageFile = path.join(sub, "package.json")
    await fs.mkdir(sub, { recursive: true })
    await fs.writeFile(path.join(sub, "server.js"), "export {}; console.log('module-mode')")
    await fs.writeFile(packageFile, JSON.stringify({ type: "module" }))

    const before = Bun.spawn(["node", "sub/server.js"], { cwd: site, stdout: "pipe", stderr: "ignore" })
    const [beforeExit, beforeOutput] = await Promise.all([before.exited, new Response(before.stdout).text()])
    const plan = freeze(root.path, { kind: "script", cwd: "site", argv: ["node", "sub/server.js"] })
    await fs.writeFile(packageFile, JSON.stringify({ type: "commonjs" }))
    const after = Bun.spawn(["node", "sub/server.js"], { cwd: site, stdout: "ignore", stderr: "ignore" })

    expect(beforeExit).toBe(0)
    expect(beforeOutput).toContain("module-mode")
    expect(await after.exited).not.toBe(0)
    expect(plan.configFiles.map((file) => file.path)).toContain("site/sub/package.json")
    expect(configurationFailure(plan)).toMatchObject({ code: "preview_configuration_changed" })
  })

  test.each([
    ["node", "server.js", "export {}"],
    ["node", "server.mjs", "export {}"],
    ["node.exe", "server.cjs", "module.exports = {}"],
  ] as const)("freezes nested configuration for direct %s %s", async (executable, entrypoint, source) => {
    await using root = await tmpdir()
    const sub = path.join(root.path, "site", "sub")
    const packageFile = path.join(sub, "package.json")
    await fs.mkdir(sub, { recursive: true })
    await fs.writeFile(path.join(sub, entrypoint), source)
    await fs.writeFile(packageFile, JSON.stringify({ type: "module" }))
    const plan = freeze(root.path, {
      kind: "script",
      cwd: "site",
      argv: [executable, `sub/${entrypoint}`],
    })
    await fs.writeFile(packageFile, JSON.stringify({ type: "commonjs" }))

    expect(plan.configFiles.map((file) => file.path)).toContain("site/sub/package.json")
    expect(configurationFailure(plan)).toMatchObject({ code: "preview_configuration_changed" })
  })

  test.each([
    ["missing entrypoint", ["node"]],
    ["eval", ["node", "--eval", "console.log('preview')"]],
    ["require hook", ["node", "--require", "./register.cjs", "server.js"]],
    ["runtime flag", ["node", "--inspect", "server.js"]],
    ["stdin", ["node", "-"]],
    ["option separator", ["node", "--", "server.js"]],
    ["trailing application arguments", ["node", "server.js", "--port", "3000"]],
    ["absolute POSIX path", ["node", "/outside/server.js"]],
    ["absolute Windows path", ["node", "C:/outside/server.js"]],
    ["parent traversal", ["node", "../server.js"]],
    ["file URL", ["node", "file:///outside/server.js"]],
    ["remote URL", ["node", "https://example.com/server.js"]],
  ])("rejects unsafe or ambiguous direct Node argv: %s", async (_, argv) => {
    await using root = await tmpdir()

    expect(() => freezePreviewUnknown(root.path, { kind: "script", argv })).toThrow(PreviewPlan.Invalid)
  })

  test("requires the direct Node entrypoint to be an existing file", async () => {
    await using root = await tmpdir()

    expect(() => freeze(root.path, { kind: "script", argv: ["node", "missing.mjs"] })).toThrow(PreviewPlan.Invalid)
  })

  test("rejects a direct Node entrypoint directory replaced by an outside junction", async () => {
    await using root = await tmpdir()
    await using outside = await tmpdir()
    const site = path.join(root.path, "site")
    const sub = path.join(site, "sub")
    const packageJson = JSON.stringify({ type: "module" })
    await fs.mkdir(sub, { recursive: true })
    await fs.writeFile(path.join(sub, "package.json"), packageJson)
    await fs.writeFile(path.join(sub, "server.js"), "export {}")
    await fs.writeFile(path.join(outside.path, "package.json"), packageJson)
    await fs.writeFile(path.join(outside.path, "server.js"), "export {}")
    const plan = freeze(root.path, { kind: "script", cwd: "site", argv: ["node", "sub/server.js"] })
    await fs.rm(sub, { recursive: true, force: true })
    await fs.symlink(outside.path, sub, process.platform === "win32" ? "junction" : "dir")

    const failure = configurationFailure(plan)

    expect(failure).toBeInstanceOf(PreviewPlan.Invalid)
    expect(failure).toMatchObject({ code: "preview_configuration_changed" })
  })

  test("rejects a case-only direct Node entrypoint identity change", async () => {
    await using root = await tmpdir()
    const site = path.join(root.path, "site")
    const entrypoint = path.join(site, "server.mjs")
    const staging = path.join(site, "server-staging.mjs")
    const caseAlias = path.join(site, "SERVER.mjs")
    await fs.mkdir(site)
    await fs.writeFile(entrypoint, "export {}")
    const plan = freeze(root.path, { kind: "script", cwd: "site", argv: ["node", "server.mjs"] })
    await fs.rename(entrypoint, staging)
    await fs.rename(staging, caseAlias)

    const failure = configurationFailure(plan)

    expect(failure).toBeInstanceOf(PreviewPlan.Invalid)
    expect(failure).toMatchObject({ code: "preview_configuration_changed" })
  })

  test("reports a deleted direct Node entrypoint as a typed configuration change", async () => {
    await using root = await tmpdir()
    const entrypoint = path.join(root.path, "server.cjs")
    await fs.writeFile(entrypoint, "module.exports = {}")
    const plan = freeze(root.path, { kind: "script", argv: ["node", "server.cjs"] })
    await fs.rm(entrypoint)

    const failure = configurationFailure(plan)

    expect(failure).toBeInstanceOf(PreviewPlan.Invalid)
    expect(failure).toMatchObject({ code: "preview_configuration_changed" })
  })

  test("binds an empty explicit-script cwd to its admitted Location", async () => {
    await using root = await tmpdir()
    await using outside = await tmpdir()
    const site = path.join(root.path, "site")
    await fs.mkdir(site)
    await fs.writeFile(path.join(site, "server.mjs"), "console.log('preview')")
    const plan = freeze(root.path, { kind: "script", cwd: "site", argv: ["node", "server.mjs"] })
    await fs.rm(site, { recursive: true, force: true })
    await fs.symlink(outside.path, site, process.platform === "win32" ? "junction" : "dir")

    const failure = configurationFailure(plan)

    expect(failure).toBeInstanceOf(PreviewPlan.Invalid)
    expect(failure).toMatchObject({ code: "preview_configuration_changed" })
  })

  test("rejects an identical configured cwd reached through a replacement alias", async () => {
    await using root = await tmpdir()
    await using outside = await tmpdir()
    const site = path.join(root.path, "site")
    const packageJson = JSON.stringify({ scripts: { preview: "vite preview" } })
    await fs.mkdir(site)
    await fs.writeFile(path.join(site, "package.json"), packageJson)
    await fs.writeFile(path.join(outside.path, "package.json"), packageJson)
    const plan = freeze(root.path, { kind: "script", cwd: "site", argv: ["bun", "run", "preview"] })
    await fs.rm(site, { recursive: true, force: true })
    await fs.symlink(outside.path, site, process.platform === "win32" ? "junction" : "dir")

    const failure = configurationFailure(plan)

    expect(failure).toBeInstanceOf(PreviewPlan.Invalid)
    expect(failure).toMatchObject({ code: "preview_configuration_changed" })
  })

  test("rejects a case-only cwd identity change", async () => {
    await using root = await tmpdir()
    const site = path.join(root.path, "site")
    const staging = path.join(root.path, "case-staging")
    const caseAlias = path.join(root.path, "SITE")
    await fs.mkdir(site)
    await fs.writeFile(path.join(site, "server.mjs"), "console.log('preview')")
    const plan = freeze(root.path, { kind: "script", cwd: "site", argv: ["node", "server.mjs"] })
    await fs.rename(site, staging)
    await fs.rename(staging, caseAlias)

    const failure = configurationFailure(plan)

    expect(failure).toBeInstanceOf(PreviewPlan.Invalid)
    expect(failure).toMatchObject({ code: "preview_configuration_changed" })
  })

  test("reports a deleted explicit-script cwd as a typed configuration change", async () => {
    await using root = await tmpdir()
    const site = path.join(root.path, "site")
    await fs.mkdir(site)
    await fs.writeFile(path.join(site, "server.mjs"), "console.log('preview')")
    const plan = freeze(root.path, { kind: "script", cwd: "site", argv: ["node", "server.mjs"] })
    await fs.rm(site, { recursive: true, force: true })

    const failure = configurationFailure(plan)

    expect(failure).toBeInstanceOf(PreviewPlan.Invalid)
    expect(failure).toMatchObject({ code: "preview_configuration_changed" })
  })

  test("freezes deterministic canonical Location identity into the plan digest", async () => {
    await using root = await tmpdir()
    await using outside = await tmpdir()
    const site = path.join(root.path, "site")
    await fs.mkdir(site)
    await fs.writeFile(path.join(site, "server.mjs"), "console.log('preview')")
    const first = freeze(root.path, { kind: "script", cwd: "site", argv: ["node", "server.mjs"] })
    const second = freeze(root.path, { kind: "script", cwd: "site", argv: ["node", "server.mjs"] })

    expect(first.locationRoot).toBe(await fs.realpath(root.path))
    expect(first.configSha256).toBe(second.configSha256)
    expect(Object.isFrozen(first)).toBe(true)
    expect(configurationFailure(Object.freeze({ ...first, locationRoot: outside.path }))).toMatchObject({
      code: "preview_configuration_changed",
    })
  })

  test("normalizes duplicate local origins into a self-verifying frozen plan", async () => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "index.html"), "<!doctype html>")
    const origin = "http://127.0.0.1:4317"

    const plan = freeze(root.path, { kind: "static", entrypoint: "index.html" }, { allowedOrigins: [origin, origin] })

    expect(plan.allowedOrigins).toEqual([origin])
    expect(() => PreviewPlan.verifyConfiguration(plan)).not.toThrow()
  })

  test("reports removed preview roots as typed frozen-configuration changes", async () => {
    await using root = await tmpdir()
    await fs.writeFile(
      path.join(root.path, "package.json"),
      JSON.stringify({ scripts: { preview: "vite preview" }, devDependencies: { vite: "7.0.0" } }),
    )
    const plan = freeze(root.path)
    await fs.rm(root.path, { recursive: true, force: true })

    expect(() => PreviewPlan.verifyConfiguration(plan)).toThrow(PreviewPlan.Invalid)
    try {
      PreviewPlan.verifyConfiguration(plan)
    } catch (error) {
      expect(error).toMatchObject({ code: "preview_configuration_changed" })
    }
  })

  test("detects a frozen static directory replaced by an outside alias", async () => {
    await using root = await tmpdir()
    await using outside = await tmpdir()
    const site = path.join(root.path, "site")
    await fs.mkdir(site)
    await fs.writeFile(path.join(site, "index.html"), "<!doctype html><title>Inside</title>")
    await fs.writeFile(path.join(outside.path, "index.html"), "<!doctype html><title>Outside</title>")
    const plan = freeze(root.path, { kind: "static", cwd: "site", entrypoint: "index.html" })
    await fs.rm(site, { recursive: true, force: true })
    await fs.symlink(outside.path, site, process.platform === "win32" ? "junction" : "dir")

    expect(() => PreviewPlan.verifyConfiguration(plan)).toThrow(/changed/i)
  })

  test("rejects model-authored commands before filesystem or process authority", () => {
    expect(() => freezeUnknown({ command: "bun run dev" })).toThrow(/model-authored/i)
    expect(() =>
      freezeUnknown({
        authority: "model",
        location: location("D:\\workspace"),
        command: ["bun", "run", "dev"],
      }),
    ).toThrow(/model-authored/i)
  })

  test("rejects traversal, Windows device names, unallowlisted env, and unsafe origins", async () => {
    await using root = await tmpdir()
    await fs.writeFile(path.join(root.path, "index.html"), "<!doctype html>")

    expect(() => freezePreviewUnknown(root.path, { kind: "static", cwd: "..", entrypoint: "index.html" })).toThrow()
    expect(() => freezePreviewUnknown(root.path, { kind: "static", cwd: ".", entrypoint: "CON.html" })).toThrow()
    expect(() =>
      freezePreviewUnknown(root.path, {
        kind: "static",
        cwd: ".",
        entrypoint: "index.html",
        command: "bun run dev",
      }),
    ).toThrow()
    expect(() =>
      freeze(
        root.path,
        { kind: "script", argv: ["bun", "run", "dev"], env: { NODE_OPTIONS: "--require=attack.js" } },
        { envAllowlist: ["NODE_OPTIONS"] },
      ),
    ).toThrow(/environment/i)
    expect(() => freezePreviewUnknown(root.path, { kind: "script", argv: ["bash", "-c", "vite preview"] })).toThrow(
      /shell|runtime/i,
    )
    const syntheticSecret = ["sk", "redacted", "sentinel"].join("-")
    expect(() =>
      freeze(
        root.path,
        { kind: "script", argv: ["bun", "run", "dev"], env: { SAFE_LABEL: syntheticSecret } },
        { envAllowlist: ["SAFE_LABEL"] },
      ),
    ).toThrow(/environment|persist|safe/i)
    expect(() =>
      freeze(
        root.path,
        { kind: "script", argv: ["bun", "run", "dev"] },
        {
          environment: { SAFE_LABEL: "line one\nline two" },
          envAllowlist: ["SAFE_LABEL"],
        },
      ),
    ).toThrow(/environment/i)

    for (const origin of [
      "https://example.com",
      "file:///D:/workspace/index.html",
      "http://user:pass@127.0.0.1:4000",
      "http://127.0.0.1:4000/path",
    ]) {
      expect(() =>
        freeze(root.path, { kind: "static", cwd: ".", entrypoint: "index.html" }, { allowedOrigins: [origin] }),
      ).toThrow(/origin/i)
    }
  })

  test("rejects a directory alias that resolves outside the admitted Location", async () => {
    await using root = await tmpdir()
    await using outside = await tmpdir()
    await fs.writeFile(path.join(outside.path, "index.html"), "<!doctype html><title>Outside</title>")
    const alias = path.join(root.path, "alias")
    await fs.symlink(outside.path, alias, process.platform === "win32" ? "junction" : "dir")

    expect(() => freeze(root.path, { kind: "static", cwd: "alias", entrypoint: "index.html" })).toThrow(
      /alias|Location|outside|escape/i,
    )
  })

  test("rejects case-aliased command configuration names", async () => {
    await using root = await tmpdir()
    await fs.writeFile(
      path.join(root.path, "Package.json"),
      JSON.stringify({ scripts: { preview: "vite preview" }, devDependencies: { vite: "7.0.0" } }),
    )

    expect(() => freeze(root.path)).toThrow(/canonical|case alias/i)
  })
})
