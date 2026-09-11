import fs from "node:fs/promises"
import path from "node:path"
import { frozenStages, type ProductionRecording } from "./workflow-production-types"

export const recordingPath = path.join(import.meta.dir, "..", "fixtures", "workflow-production", "recording.json")

export async function loadRecording(): Promise<ProductionRecording> {
  const parsed: unknown = JSON.parse(await fs.readFile(recordingPath, "utf8"))
  assertRecording(parsed)
  return parsed
}

function assertRecording(value: unknown): asserts value is ProductionRecording {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid recording root")
  exactKeys(value, ["version", "stages", "expectedArtifacts", "expectedPreviews", "terminal"], "recording")
  if (Reflect.get(value, "version") !== 1) throw new Error("Unsupported recording version")
  const stages = Reflect.get(value, "stages")
  if (!Array.isArray(stages) || stages.length !== 11) throw new Error("Recording must contain exactly eleven stages")
  for (const [index, stage] of stages.entries()) {
    if (stage === null || typeof stage !== "object" || Array.isArray(stage)) throw new Error(`Invalid stage ${index}`)
    exactKeys(
      stage,
      ["role", "revision", "provider", "model", "protocol", "effort", "semantic", "toolScript", "usage", "terminal"],
      `stage ${index}`,
    )
    const expected = frozenStages[index]
    const actual = [
      Reflect.get(stage, "role"),
      Reflect.get(stage, "revision"),
      Reflect.get(stage, "provider"),
      Reflect.get(stage, "model"),
      Reflect.get(stage, "protocol"),
      Reflect.get(stage, "effort"),
    ]
    if (expected === undefined || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Stage ${index} frozen route or revision order drifted`)
    }
    const semantic = Reflect.get(stage, "semantic")
    const outcome = semantic !== null && typeof semantic === "object" ? Reflect.get(semantic, "outcome") : undefined
    if (
      outcome === null ||
      typeof outcome !== "object" ||
      Reflect.get(outcome, "role") !== expected[0] ||
      Reflect.get(outcome, "revision") !== expected[1]
    ) {
      throw new Error(`Stage ${index} semantic outcome drifted`)
    }
    const script = Reflect.get(stage, "toolScript")
    const expectedCallID =
      expected[0] === "implement"
        ? "call-implement-r0"
        : expected[0] === "repair"
          ? `call-repair-r${expected[1]}`
          : undefined
    if (
      !Array.isArray(script) ||
      (expectedCallID === undefined && script.length !== 0) ||
      (expectedCallID !== undefined &&
        (script.length !== 1 || script[0]?.name !== "apply_patch" || script[0]?.callID !== expectedCallID))
    ) {
      throw new Error(`Stage ${index} tool script drifted`)
    }
  }
  const artifacts = Reflect.get(value, "expectedArtifacts")
  if (!Array.isArray(artifacts) || artifacts.length !== 32) {
    throw new Error("Recording must contain the exact thirty-two artifact ownership rows")
  }
  for (const [index, artifact] of artifacts.entries()) {
    if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
      throw new Error(`Invalid expected artifact ${index}`)
    }
    exactKeys(artifact, ["role", "revision", "kind", "count"], `expected artifact ${index}`)
  }
  const previews = Reflect.get(value, "expectedPreviews")
  if (!Array.isArray(previews) || previews.length !== 3) {
    throw new Error("Recording must contain the exact three preview bodies")
  }
  for (const [index, preview] of previews.entries()) {
    if (preview === null || typeof preview !== "object" || Array.isArray(preview)) {
      throw new Error(`Invalid expected preview ${index}`)
    }
    exactKeys(preview, ["kind", "revision", "sha256", "size"], `expected preview ${index}`)
    if (!/^[a-f0-9]{64}$/.test(String(Reflect.get(preview, "sha256"))) || Reflect.get(preview, "size") !== 55) {
      throw new Error(`Expected preview ${index} metadata is not canonical`)
    }
  }
  if (
    JSON.stringify(previews.map((preview) => [preview.kind, preview.revision])) !==
    JSON.stringify([
      ["reference", 0],
      ["implementation", 1],
      ["implementation", 2],
    ])
  ) {
    throw new Error("Expected preview order drifted")
  }
  const forbidden = new Set([
    "url",
    "header",
    "headers",
    "body",
    "credential",
    "credentials",
    "env",
    "png",
    "base64",
    "dataURL",
    "rawLog",
    "log",
    "liveResponse",
  ])
  walk(value, (key, item) => {
    if (forbidden.has(key)) throw new Error(`Recording contains forbidden field ${key}`)
    if (
      typeof item === "string" &&
      (/\bBearer\s/i.test(item) || /\bsk-[A-Za-z0-9]/.test(item) || /data:/i.test(item))
    ) {
      throw new Error("Recording contains forbidden transport or credential material")
    }
  })
}

function exactKeys(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${label} keys drifted`)
}

function walk(value: unknown, inspect: (key: string, value: unknown) => void, key = ""): void {
  inspect(key, value)
  if (Array.isArray(value)) {
    for (const item of value) walk(item, inspect)
    return
  }
  if (value === null || typeof value !== "object") return
  for (const [child, item] of Object.entries(value)) walk(item, inspect, child)
}
