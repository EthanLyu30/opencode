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
