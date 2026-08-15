import { secretFindings } from "@opencode-ai/http-recorder/internal"

export const TASK21_LIVE_TOKEN_CEILING = 512
export const TASK21_LIVE_APPROVAL_ENV = "TASK21_LIVE_TOKEN_CEILING"

export const task21LiveContractPlan = [
  {
    id: "design-vision-review",
    provider: "kimi",
    model: "kimi-k3",
    protocol: "openai-compatible-chat",
    providerRequests: 1,
    maxOutputTokens: 256,
    maxRequestBytes: 8_192,
  },
  {
    id: "flash-text-tool",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    protocol: "openai-responses",
    providerRequests: 2,
    maxOutputTokens: 128,
    maxRequestBytes: 12_288,
  },
] as const

const UUID_SOURCE = "\\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\\b"
const PROVIDER_TIMESTAMP = /"(created|created_at|completed_at)"\s*:\s*\d+/g

export const formatTask21DryRun = () =>
  [
    "Task21 live contract dry-run (no requests sent)",
    "",
    "kimi design/vision/structured-output:",
    "  kimi-k3 | 1 provider request | max output 256 tokens",
    "  POST https://api.moonshot.cn/v1/chat/completions",
    "  input: 1x1 PNG + compact review prompt + strict approved/summary JSON schema",
    "  request body hard limit: 8192 UTF-8 bytes",
    "deepseek text/tool Responses interaction:",
    "  deepseek-v4-flash | at most 2 provider requests | max output 128 tokens each",
    "  POST https://api.deepseek.com/responses",
    "  turn 1: prompt + read_file function schema",
    "  turn 2: function call + function output; no tools",
    "  request body hard limit: 12288 UTF-8 bytes per request",
    "",
    "Planned interactions: 2",
    "Maximum provider requests: 3",
    `Hard generated-token ceiling: ${TASK21_LIVE_TOKEN_CEILING}`,
    "Input is fixed and byte-bounded; provider media/input tokenization is billed separately and cannot be known exactly before sending.",
    `Required approval: ${TASK21_LIVE_APPROVAL_ENV}=${TASK21_LIVE_TOKEN_CEILING}`,
  ].join("\n")

export const redactTask21Body = (body: string) => {
  const uuids = new Map<string, string>()
  return body
    .replace(/"request_id"\s*:\s*"[^"]+"/gi, '"request_id":"[REDACTED]"')
    .replace(/\b(?:resp|req|msg|call|fc|ws)_[A-Za-z0-9_-]{6,}\b/g, (value) => `${value.split("_")[0]}_task21`)
    .replace(/\bchatcmpl-[A-Za-z0-9_-]+\b/g, "chatcmpl-task21")
    .replace(new RegExp(UUID_SOURCE, "gi"), (value) => {
      const key = value.toLowerCase()
      const replacement = uuids.get(key) ?? `uuid_task21_${uuids.size + 1}`
      uuids.set(key, replacement)
      return replacement
    })
    .replace(/"system_fingerprint"\s*:\s*"[^"]+"/g, '"system_fingerprint":"[REDACTED]"')
    .replace(PROVIDER_TIMESTAMP, (_, name: string) => `"${name}":0`)
    .replace(/[A-Za-z]:\\+(?:Users|Documents)\\+[^"\r\n]+/g, "[PERSONAL_PATH]")
    .replace(/\/(?:Users|home)\/[^/"\s]+(?:\/[^"\r\n]*)?/g, "[PERSONAL_PATH]")
}

const sensitiveHeaderNames = new Set(["authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const unsafeHeaderPaths = (value: unknown, base = ""): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap((item, index) => unsafeHeaderPaths(item, `${base}[${index}]`))
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, child]) => {
    const current = base ? `${base}.${key}` : key
    if (sensitiveHeaderNames.has(key.toLowerCase()) && child !== "[REDACTED]") return [current]
    return unsafeHeaderPaths(child, current)
  })
}

const volatileValueFindings = (value: unknown, base = ""): ReadonlyArray<string> => {
  if (typeof value === "string") {
    const uuids = [...value.matchAll(new RegExp(UUID_SOURCE, "gi"))].map(() => `${base || "value"} (provider UUID)`)
    const timestamps = [...value.matchAll(PROVIDER_TIMESTAMP)]
      .filter((match) => !match[0].endsWith(":0"))
      .map((match) => `${base || "value"} (${match[1]} provider timestamp)`)
    return [...uuids, ...timestamps]
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => volatileValueFindings(item, `${base}[${index}]`))
  if (!value || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, child]) => {
    const current = base ? `${base}.${key}` : key
    if (
      (key === "created" || key === "created_at" || key === "completed_at") &&
      typeof child === "number" &&
      child !== 0
    )
      return [`${current} (provider timestamp)`]
    return volatileValueFindings(child, current)
  })
}

export const assertTask21CassetteSafe = (cassette: unknown) => {
  const serialized = JSON.stringify(cassette)
  const volatileIDs = [...serialized.matchAll(/\b(?:resp|req|msg|call|fc|ws)_[A-Za-z0-9_-]{6,}\b/g)]
    .map((match) => match[0])
    .filter((value) => !value.endsWith("_task21"))
  const chatIDs = [...serialized.matchAll(/\bchatcmpl-[A-Za-z0-9_-]{6,}\b/g)]
    .map((match) => match[0])
    .filter((value) => value !== "chatcmpl-task21")
  const personalPaths = [/[A-Za-z]:(?:\\)+Users(?:\\)+/i, /\/(?:Users|home)\/[^/"\s]+/].filter((pattern) =>
    pattern.test(serialized),
  )
  const embeddedSensitiveFields = [
    /\\"(?:api[_-]?key|authorization|cookie|password|secret|token)\\"\s*:\s*\\"(?!\[REDACTED\])/i,
  ].filter((pattern) => pattern.test(serialized))
  const findings = [
    ...secretFindings(cassette).map((finding) => `${finding.path} (${finding.reason})`),
    ...unsafeHeaderPaths(cassette).map((path) => `${path} (unredacted sensitive header)`),
    ...volatileValueFindings(cassette),
    ...volatileIDs.map(() => "volatile provider id"),
    ...chatIDs.map(() => "volatile provider id"),
    ...personalPaths.map((pattern) => `${pattern.source} (personal path)`),
    ...embeddedSensitiveFields.map((pattern) => `${pattern.source} (unredacted sensitive JSON field)`),
  ]
  if (findings.length > 0) throw new Error(`unsafe Task21 cassette: ${[...new Set(findings)].join(", ")}`)
}

type Task21LiveEnv = Record<string, string | undefined>
type Task21InteractionID = (typeof task21LiveContractPlan)[number]["id"]

export const makeTask21LiveBudget = (env: Task21LiveEnv) => {
  if (env.RECORD !== "true") throw new Error("Task21 live recording requires RECORD=true")
  if (env.RECORDED_PREFIX !== "kimi-k3,deepseek-responses")
    throw new Error("Task21 live recording requires RECORDED_PREFIX=kimi-k3,deepseek-responses")
  if (env[TASK21_LIVE_APPROVAL_ENV] !== String(TASK21_LIVE_TOKEN_CEILING))
    throw new Error(
      `Task21 live recording requires explicit approval: ${TASK21_LIVE_APPROVAL_ENV}=${TASK21_LIVE_TOKEN_CEILING}`,
    )
  for (const name of ["MOONSHOT_API_KEY", "DEEPSEEK_API_KEY"]) {
    if (!env[name]) throw new Error(`Task21 live recording requires ${name}`)
  }

  const requests = new Map<Task21InteractionID, number>()
  let providerRequests = 0
  let generatedTokenCeiling = 0

  return {
    authorize(id: Task21InteractionID, body: unknown) {
      const plan = task21LiveContractPlan.find((item) => item.id === id)!
      if (!isRecord(body)) throw new Error(`Task21 ${id} request body must be an object`)
      const record = body
      if (record.model !== plan.model) throw new Error(`Task21 ${id} requires model ${plan.model}`)

      const outputField = plan.provider === "kimi" ? "max_completion_tokens" : "max_output_tokens"
      const outputTokens = record[outputField]
      if (
        typeof outputTokens !== "number" ||
        !Number.isInteger(outputTokens) ||
        outputTokens < 1 ||
        outputTokens > plan.maxOutputTokens
      )
        throw new Error(`Task21 ${id} requires max output ${plan.maxOutputTokens} tokens or fewer`)

      const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength
      if (bytes > plan.maxRequestBytes)
        throw new Error(`Task21 ${id} request body exceeds ${plan.maxRequestBytes} UTF-8 bytes`)

      const interactionRequests = requests.get(id) ?? 0
      if (interactionRequests >= plan.providerRequests)
        throw new Error(`Task21 ${id} provider request limit is ${plan.providerRequests}`)
      if (generatedTokenCeiling + outputTokens > TASK21_LIVE_TOKEN_CEILING)
        throw new Error(`Task21 hard generated-token ceiling is ${TASK21_LIVE_TOKEN_CEILING}`)

      requests.set(id, interactionRequests + 1)
      providerRequests += 1
      generatedTokenCeiling += outputTokens
    },
    snapshot: () => ({ providerRequests, generatedTokenCeiling }),
  }
}
