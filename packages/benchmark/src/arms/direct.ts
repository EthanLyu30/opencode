import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../campaign/canonical"
import { sha256Text } from "../hash"
import { buildDirectConfig } from "./config"
import { assertReferenceFiles, assertRunRoots, buildLaunchEnvironment } from "./environment"
import type { ArmInput, ArmRoute, DirectArmLaunch } from "./types"
import { assertBinaryForArm } from "./upstream"

export async function prepareDirectArm(input: ArmInput): Promise<DirectArmLaunch> {
  if (input.armID === "A") throw new TypeError("TASK24_DIRECT_ARM_INVALID")
  const roots = assertRunRoots(input.roots)
  const binary = assertBinaryForArm(input.armID, input.binary)
  const route = directRoute(input.armID)
  validateCommon(input)
  await assertReferenceFiles(roots, input.referenceFiles)
  const configFile = path.join(roots.config, "opencode.json")
  const config = buildDirectConfig(
    { provider: route.provider, model: route.model, protocol: route.protocol, effort: route.effort },
    input.brokerOrigin,
    input.budget.aggregateOutputTokens,
  )
  await writeStable(configFile, canonicalJson(config) + "\n")
  const environment = buildLaunchEnvironment({
    roots,
    mode: "direct",
    brokerGrant: input.brokerGrant,
    configFile,
  })
  const args = [
    "run",
    "--dir",
    roots.repo,
    "--model",
    `task24-${route.provider}/${route.model}`,
    "--variant",
    route.effort,
    "--format",
    "json",
    "--auto",
    ...input.referenceFiles.flatMap((file) => ["--file", file]),
    input.prompt,
  ]
  return Object.freeze({
    executable: binary.executable,
    args: Object.freeze(args),
    cwd: roots.repo,
    environment,
    configFile,
    snapshot: Object.freeze({
      schemaVersion: 1,
      armID: input.armID,
      runtime: binary.runtime,
      mode: "direct",
      executable: binary.executable,
      executableSha256: binary.sha256,
      version: binary.version,
      cwd: roots.repo,
      roots,
      promptSha256: sha256Text(input.prompt),
      referenceFiles: Object.freeze([...input.referenceFiles]),
      routes: Object.freeze([route]),
      budget: Object.freeze({ ...input.budget }),
      brokerOrigin: input.brokerOrigin,
      brokerGrantSha256: sha256Text(input.brokerGrant),
      expectedOutput: path.join(roots.output, "direct.jsonl"),
    }),
  })
}

export function directRoute(armID: Exclude<ArmInput["armID"], "A">): ArmRoute {
  const deepseek = armID === "B" || armID === "D"
  return Object.freeze({
    role: "all",
    provider: deepseek ? "deepseek" : "kimi",
    model: deepseek ? "deepseek-v4-pro" : "kimi-k3",
    protocol: deepseek ? "responses" : "chat_completions",
    effort: "max",
  })
}

export function collectDirectOutput(stdout: string): {
  readonly sessionID: string
  readonly eventCount: number
  readonly toolCalls: number
} {
  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.length === 0) throw new TypeError("TASK24_DIRECT_OUTPUT_EMPTY")
  let sessionID: string | undefined
  let finalStepSuccessful: boolean | undefined
  let toolCalls = 0
  for (const line of lines) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      throw new TypeError("TASK24_DIRECT_OUTPUT_INVALID")
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      throw new TypeError("TASK24_DIRECT_OUTPUT_INVALID")
    }
    const type = Reflect.get(event, "type")
    const currentSessionID = Reflect.get(event, "sessionID")
    if (typeof type !== "string" || typeof currentSessionID !== "string" || currentSessionID.length === 0) {
      throw new TypeError("TASK24_DIRECT_OUTPUT_INVALID")
    }
    if (sessionID !== undefined && sessionID !== currentSessionID) throw new TypeError("TASK24_DIRECT_SESSION_MISMATCH")
    sessionID = currentSessionID
    if (type === "error") throw new TypeError("TASK24_DIRECT_PROVIDER_ERROR")
    if (type === "tool_use") toolCalls++
    if (type === "step_finish") {
      const part = Reflect.get(event, "part")
      finalStepSuccessful =
        part !== null && typeof part === "object" && typeof Reflect.get(part, "reason") === "string"
          ? Reflect.get(part, "reason") !== "unknown"
          : false
    }
  }
  if (!sessionID || finalStepSuccessful !== true) throw new TypeError("TASK24_DIRECT_NOT_TERMINAL")
  return Object.freeze({ sessionID, eventCount: lines.length, toolCalls })
}

function validateCommon(input: ArmInput): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.campaignID) || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.runID)) {
    throw new TypeError("TASK24_ARM_IDENTITY_INVALID")
  }
  if (input.prompt.length === 0 || input.brokerGrant.length < 32 || input.grantExpiresAt <= Date.now()) {
    throw new TypeError("TASK24_ARM_AUTHORITY_INVALID")
  }
  for (const file of input.referenceFiles) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes(".."))
      throw new TypeError("TASK24_REFERENCE_PATH_INVALID")
  }
  for (const value of Object.values(input.budget)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("TASK24_ARM_BUDGET_INVALID")
  }
}

async function writeStable(file: string, content: string): Promise<void> {
  try {
    await fs.writeFile(file, content, { encoding: "utf8", flag: "wx" })
  } catch (cause) {
    const code = cause !== null && typeof cause === "object" ? Reflect.get(cause, "code") : undefined
    if (code !== "EEXIST" || (await fs.readFile(file, "utf8")) !== content) throw cause
  }
}
