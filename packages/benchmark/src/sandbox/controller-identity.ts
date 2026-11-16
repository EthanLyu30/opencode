import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { ordinaryFiles } from "../corpus/evaluation-bundle"
import { FileIdentity, type HostManifest } from "./contracts"
import { fileIdentity } from "./storage"
import { readControllerJson } from "./readiness"
const Inventory = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  root: Schema.String,
  files: Schema.Array(Schema.Struct({ role: Schema.Literals(["source", "test", "policy"]), file: FileIdentity })),
})
const controllerPaths = ["src", "script", "test/linux-host", "package.json", "../../bun.lock"] as const
export type ControllerInventory = Readonly<{
  schemaVersion: 2
  root: string
  files: readonly Readonly<{ role: "source" | "test" | "policy"; file: FileIdentity }>[]
}>
/** Binds every controller file the verifier will later re-hash, with the same role split. */
export async function authorControllerInventory(root = path.resolve(import.meta.dir, "../..")) {
  const controllerRoot = path.resolve(root)
  const paths: string[] = []
  for (const p of controllerPaths) {
    const full = path.join(controllerRoot, p)
    if (p.endsWith(".json") || p.endsWith(".lock")) paths.push(full)
    else paths.push(...(await ordinaryFiles(full)).map((f) => path.join(full, f.path)))
  }
  const files = await Promise.all(
    paths.map(async (file) => ({
      role: file.includes(path.sep + "test" + path.sep)
        ? ("test" as const)
        : file.includes(path.sep + "sandbox" + path.sep)
          ? ("policy" as const)
          : ("source" as const),
      file: await fileIdentity(file),
    })),
  )
  const inventory: ControllerInventory = {
    schemaVersion: 2,
    root: controllerRoot,
    files: files.sort((a, b) => a.file.path.localeCompare(b.file.path)),
  }
  const fingerprint = (role: ControllerInventory["files"][number]["role"]) =>
    sha256Text(canonicalJson(inventory.files.filter((entry) => entry.role === role)))
  return {
    inventory,
    sourceSha256: fingerprint("source"),
    testSha256: fingerprint("test"),
    policySha256: fingerprint("policy"),
  }
}
/** The approved manifest binds complete controller directories, not a caller-supplied hash alone. */
export async function verifyControllerIdentity(manifest: HostManifest) {
  const artifact = manifest.artifacts.find((a) => a.id === "controller-inventory" && a.kind === "worker")
  if (
    !artifact ||
    !("path" in artifact) ||
    !artifact.path ||
    !("sha256" in artifact) ||
    (await fileIdentity(artifact.path)).sha256 !== artifact.sha256
  )
    throw new TypeError("TASK24_CONTROLLER_INVENTORY")
  const inv = Schema.decodeUnknownSync(Inventory)(await readControllerJson(artifact.path), {
    onExcessProperty: "error",
  })
  if (inv.root !== path.resolve(import.meta.dir, "../..")) throw new TypeError("TASK24_CONTROLLER_ROOT_STALE")
  const paths: string[] = []
  for (const p of controllerPaths) {
    const full = path.join(inv.root, p)
    if (p.endsWith(".json") || p.endsWith(".lock")) paths.push(full)
    else paths.push(...(await ordinaryFiles(full)).map((f) => path.join(full, f.path)))
  }
  if (
    inv.files.length !== paths.length ||
    new Set(inv.files.map((f) => f.file.path.toLowerCase())).size !== paths.length ||
    paths.some((p) => !inv.files.some((f) => f.file.path === p))
  )
    throw new TypeError("TASK24_CONTROLLER_INVENTORY_COVERAGE")
  for (const entry of inv.files) {
    if (canonicalJson(await fileIdentity(entry.file.path)) !== canonicalJson(entry.file))
      throw new TypeError("TASK24_CONTROLLER_SOURCE_STALE")
    const expected = entry.file.path.includes(path.sep + "test" + path.sep)
      ? "test"
      : entry.file.path.includes(path.sep + "sandbox" + path.sep)
        ? "policy"
        : "source"
    if (entry.role !== expected) throw new TypeError("TASK24_CONTROLLER_INVENTORY_ROLE")
  }
  for (const [role, expected] of [
    ["source", manifest.sourceSha256],
    ["test", manifest.testSha256],
    ["policy", manifest.policySha256],
  ] as const)
    if (
      sha256Text(
        canonicalJson(inv.files.filter((f) => f.role === role).sort((a, b) => a.file.path.localeCompare(b.file.path))),
      ) !== expected
    )
      throw new TypeError("TASK24_CONTROLLER_FINGERPRINT_STALE")
}
