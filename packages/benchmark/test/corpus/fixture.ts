import fs from "node:fs/promises"
import path from "node:path"
import { sha256Bytes, sha256Text } from "../../src/hash"
import { Task24Root } from "../../src/root"

export async function taskFixture(label: string) {
  const layout = Task24Root.ensure()
  const root = path.join(layout.tmp, "corpus-tests", `${label}-${crypto.randomUUID()}`)
  const bundle = path.join(root, "bundle")
  const starter = path.join(bundle, "starter")
  const assets = path.join(bundle, "assets")
  const gold = path.join(bundle, "gold")
  await Promise.all([
    fs.mkdir(starter, { recursive: true }),
    fs.mkdir(assets, { recursive: true }),
    fs.mkdir(gold, { recursive: true }),
  ])
  const starterText = "<!doctype html><main>Starter</main>\n"
  const assetBytes = Uint8Array.from([0, 1, 2, 3, 4, 5])
  const goldText = "<!doctype html><main>Expected result</main>\n"
  await Promise.all([
    Bun.write(path.join(starter, "index.html"), starterText),
    Bun.write(path.join(assets, "reference.bin"), assetBytes),
    Bun.write(path.join(gold, "index.html"), goldText),
  ])
  const licenses = [
    {
      name: "fixture-source",
      license: "MIT",
      sourceUrl: "https://example.test/source",
      revision: "a".repeat(40),
    },
  ]
  await Bun.write(path.join(bundle, "LICENSES.json"), JSON.stringify(licenses))
  const task = {
    schemaVersion: 1,
    id: `fixture-${label}`.replaceAll(/[^a-z0-9._-]/g, "-"),
    kind: "primary",
    stratum: "design2code",
    family: "greenfield",
    prompt: "Build the public fixture page.",
    normalizationVersion: "task24-normalization-v1",
    source: {
      id: "fixture-source",
      url: "https://example.test/source",
      revision: "a".repeat(40),
      license: "MIT",
    },
    workspaceFiles: [{ path: "index.html", sha256: sha256Text(starterText), size: Buffer.byteLength(starterText) }],
    publicAssets: [{ path: "reference.bin", sha256: sha256Bytes(assetBytes), size: assetBytes.byteLength }],
    goldFiles: [{ path: "index.html", sha256: sha256Text(goldText), size: Buffer.byteLength(goldText) }],
    licensesSha256: sha256Text(JSON.stringify(licenses)),
  }
  await Bun.write(path.join(bundle, "task.json"), JSON.stringify(task))
  return {
    layout,
    root,
    bundle,
    task,
    starterText,
    assetBytes,
    goldText,
    async dispose() {
      const resolved = path.resolve(root)
      if (!resolved.startsWith(path.resolve(layout.tmp) + path.sep))
        throw new TypeError("Unsafe corpus fixture cleanup")
      await fs.rm(resolved, { recursive: true, force: true })
    },
  }
}
