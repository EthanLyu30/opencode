import fs from "node:fs/promises"
import path from "node:path"

const originalFetch = globalThis.fetch
let startupOutboundCalls = 0
globalThis.fetch = (async () => {
  startupOutboundCalls++
  throw new Error("Global outbound fetch is forbidden before and during production acceptance startup")
}) as unknown as typeof fetch

const [caseRoot, resultPath, crashBoundary, markerPath] = process.argv.slice(2)
if (!caseRoot || !resultPath) throw new Error("Expected case root and result path")

const forbiddenNames = Object.keys(process.env).filter((name) => /(KEY|TOKEN|SECRET|AUTH|COOKIE|PASSWORD)/i.test(name))
if (forbiddenNames.length > 0)
  throw new Error(`Credential-like environment names reached worker: ${forbiddenNames.join(",")}`)
if (!path.isAbsolute(caseRoot) || !path.isAbsolute(resultPath)) throw new Error("Worker roots must be absolute")
const crashBoundaries = new Set([
  "admission-postcommit-prewake",
  "provider-result-checkpoint",
  "pending-tool-intent",
  "settled-tool-result",
  "preview-start-intent",
  "png-staged-before-event",
  "terminal-before-publish",
])
const observationModes = new Set(["observe-tool-ambiguity"])
if (crashBoundary !== undefined && !crashBoundaries.has(crashBoundary) && !observationModes.has(crashBoundary)) {
  throw new Error(`Unsupported production crash boundary: ${crashBoundary}`)
}
if (
  crashBoundary !== undefined &&
  crashBoundaries.has(crashBoundary) &&
  (markerPath === undefined || !path.isAbsolute(markerPath))
) {
  throw new Error("Crash marker path must be absolute")
}

try {
  const { runProductionScenario } = await import("./lib/workflow-production-runtime")
  const observation =
    crashBoundary === "observe-tool-ambiguity"
      ? await runProductionScenario(caseRoot, undefined, "observe-tool-ambiguity")
      : await runProductionScenario(
          caseRoot,
          crashBoundary === undefined
            ? undefined
            : {
                boundary: crashBoundary as
                  | "admission-postcommit-prewake"
                  | "provider-result-checkpoint"
                  | "pending-tool-intent"
                  | "settled-tool-result"
                  | "preview-start-intent"
                  | "png-staged-before-event"
                  | "terminal-before-publish",
                markerPath: markerPath!,
              },
        )
  if (startupOutboundCalls !== 0) throw new Error("Production acceptance startup attempted outbound fetch")
  await fs.writeFile(resultPath, JSON.stringify(observation))
} finally {
  globalThis.fetch = originalFetch
}
