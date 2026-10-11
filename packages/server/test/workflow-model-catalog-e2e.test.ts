import { expect, test } from "bun:test"
import { runCatalogueProbe } from "./workflow-model-catalog-probe"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

test("exact-binary discovery and activation do not generate or replace admitted work", async () => {
  const result = await runCatalogueProbe(process.execPath)
  expect(result.generationCallsDuringDiscovery + result.generationCallsDuringActivation).toBe(0)
  expect(result.settledCallsReplayed).toBe(0)
  expect(result.recoveredModelID).toBe(result.originalModelID)
  expect(result.newAdmissionModelID).toBe(result.selectedSuccessorID)
  expect(result.originalModelID).toBe("kimi-k3")
  expect(result.selectedSuccessorID).toBe("kimi-successor-fixture")
}, 180_000)

test.each(["ordinary-environment", "wrong-grant"])(
  "private probe rejects %s before creating workflow state",
  async (kind) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-catalogue-probe-"))
    const nonce = randomUUID()
    await fs.writeFile(path.join(root, "probe-owner.json"), JSON.stringify({ nonce }), { flag: "wx" })
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          path.resolve(import.meta.dirname, "../../opencode/src/index.ts"),
          "--internal-catalogue-probe",
          root,
          nonce,
          "seed",
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            NODE_ENV: kind === "ordinary-environment" ? "production" : "test",
            RECORD: "false",
            OPENCODE_PRIVATE_CATALOGUE_PROBE: kind === "wrong-grant" ? randomUUID() : nonce,
            OPENCODE_DISABLE_MODELS_FETCH: "true",
            OPENCODE_DISABLE_WORKFLOW_MODEL_DISCOVERY: "true",
            MOONSHOT_API_KEY: "",
            DEEPSEEK_API_KEY: "",
            OPENAI_API_KEY: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const output = new Response(child.stdout).text()
      const diagnostics = new Response(child.stderr).arrayBuffer()
      expect(await child.exited).not.toBe(0)
      expect(await output).not.toContain('"phase":"seed"')
      await diagnostics
      expect(await fs.exists(path.join(root, "workflow.sqlite"))).toBe(false)
      expect(await fs.exists(path.join(root, "catalogue"))).toBe(false)
      expect(await fs.readFile(path.join(root, "probe-owner.json"), "utf8")).toBe(JSON.stringify({ nonce }))
    } finally {
      if ((await fs.realpath(root)).toLowerCase() !== root.toLowerCase() || (await fs.lstat(root)).isSymbolicLink())
        throw new Error("Private guard fixture ownership changed")
      await fs.rm(root, { recursive: true })
    }
  },
  30_000,
)
