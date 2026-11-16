import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { publishImmutable } from "../offline/atomic"
import {
  decodeHostManifest,
  decodeHostRequest,
  type HostInventory,
  type HostManifest,
  type HostRequest,
} from "./contracts"
import { authorControllerInventory, verifyControllerIdentity } from "./controller-identity"
import { fileIdentity } from "./storage"
/** Authors the prepare manifest only after the inventory has been observed; approvals remain external. */
export async function authorPrepareManifest(input: {
  request: HostRequest
  inventory: HostInventory
  evidenceRoot: string
  artifacts: readonly HostManifest["artifacts"][number][]
  pending: readonly HostManifest["artifacts"][number][]
}) {
  const request = decodeHostRequest(input.request)
  if (!input.inventory.engine || !input.inventory.storage || input.inventory.missing.length)
    throw new TypeError("TASK24_PREPARE_INVENTORY")
  const ids = [...input.artifacts, ...input.pending].map((artifact) => artifact.id)
  if (
    new Set(ids).size !== ids.length ||
    ids.includes("controller-inventory") ||
    input.artifacts.some((artifact) => artifact.kind === "pending") ||
    input.pending.some((artifact) => artifact.kind !== "pending")
  )
    throw new TypeError("TASK24_PREPARE_ARTIFACT_DECLARATION")
  const controller = await authorControllerInventory()
  if (request.sourceSha256 !== controller.sourceSha256) throw new TypeError("TASK24_PREPARE_SOURCE_STALE")
  if (input.inventory.requestSha256 !== sha256Text(canonicalJson(request)))
    throw new TypeError("TASK24_PREPARE_INVENTORY_STALE")
  for (const artifact of input.artifacts)
    if ("path" in artifact && artifact.path && (await fileIdentity(artifact.path)).sha256 !== artifact.sha256)
      throw new TypeError("TASK24_PREPARE_ARTIFACT_STALE")
  const inventoryFile = path.join(input.evidenceRoot, "controller-inventory.json")
  await publishImmutable(inventoryFile, canonicalJson(controller.inventory))
  const artifacts: HostManifest["artifacts"] = [
    {
      id: "controller-inventory",
      kind: "worker",
      path: inventoryFile,
      sha256: sha256Text(canonicalJson(controller.inventory)),
    },
    ...input.artifacts,
    ...input.pending,
  ]
  const manifest = decodeHostManifest({
    schemaVersion: 2,
    acceptanceID: request.acceptanceID,
    sourceSha256: controller.sourceSha256,
    planSha256: request.planSha256,
    testSha256: controller.testSha256,
    policySha256: controller.policySha256,
    cli: request.cli,
    context: request.context,
    endpoint: request.endpoint,
    architecture: request.architecture,
    roots: request.roots,
    ...(request.wsl2 ? { wsl2: request.wsl2 } : {}),
    engine: input.inventory.engine,
    storage: input.inventory.storage,
    phase: "prepare",
    artifacts,
    artifactManifestSha256: sha256Text(canonicalJson(artifacts)),
  })
  await verifyControllerIdentity(manifest)
  return manifest
}
