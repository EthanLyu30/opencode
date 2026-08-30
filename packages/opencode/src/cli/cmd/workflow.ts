import { ClientError, isWorkflowConflictError, OpenCode } from "@opencode-ai/client"
import { WorkflowEvent } from "@opencode-ai/schema/workflow-event"
import type { Argv } from "yargs"
import { Effect, Schema } from "effect"
import { writeSync } from "node:fs"
import { EOL } from "os"
import { effectCmd } from "../effect-cmd"

const DEFAULT_BUDGET = Object.freeze({
  maxTokens: 20_000,
  maxTurns: 20,
  maxToolCalls: 40,
  maxAttempts: 3,
  maxDurationMs: 1_800_000,
})
const DEFAULT_VISUAL = Object.freeze({
  maxRevisions: 1,
  maxTokens: 12_000,
  maxTurns: 12,
  maxToolCalls: 24,
})
const HISTORY_PAGE_SIZE = 100
const RECONNECT_DELAYS = [50, 100, 250, 500, 1_000] as const
const ADMISSION_DELAYS = [50, 100] as const

const roles = {
  design: "Kimi K3",
  decompose: "Kimi K3",
  visual_review: "Kimi K3",
  implement: "DeepSeek V4 Pro",
  repair: "DeepSeek V4 Pro",
  deliver: "DeepSeek V4 Pro",
  test: "DeepSeek V4 Flash",
} as const

type Role = keyof typeof roles
type TerminalStatus = "succeeded" | "failed" | "cancelled"
type Format = "default" | "json"
type EventInput = { readonly workflowID: string; readonly after?: number }
type RequestOptions = { readonly signal?: AbortSignal }

export type WorkflowObserverClient = {
  readonly events: (input: EventInput, options?: RequestOptions) => AsyncIterable<unknown>
  readonly history: (
    input: { readonly workflowID: string; readonly after?: number; readonly limit?: number },
    options?: RequestOptions,
  ) => Promise<unknown>
  readonly get: (input: { readonly workflowID: string }, options?: RequestOptions) => Promise<unknown>
}

export type WorkflowObservation =
  | { readonly type: "terminal"; readonly status: TerminalStatus; readonly seq: number }
  | {
      readonly type: "approval"
      readonly status: "waiting_approval"
      readonly seq: number
      readonly workflow: unknown
    }
  | { readonly type: "interrupted" }

type ParsedEvent = {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
}

type Stage = {
  readonly role: Role
  readonly revision: number
}

class ObservationError extends Error {
  override readonly name = "WorkflowObservationError"
}

const decodeWorkflowEvent = Schema.decodeUnknownSync(WorkflowEvent.Durable)

export async function observeWorkflow(input: {
  readonly workflowID: string
  readonly client: WorkflowObserverClient
  readonly signal: AbortSignal
  readonly onProgress: (line: string) => void
  readonly onTerminal?: (status: TerminalStatus) => void
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}): Promise<WorkflowObservation> {
  const stages = new Map<string, Stage>()
  const pause = input.sleep ?? sleep
  let lastSeq = 0
  let firstConnection = true
  let consecutiveDisconnects = 0

  const processEvent = async (event: ParsedEvent): Promise<WorkflowObservation | undefined> => {
    if (event.type === "workflow.created") recordStages(event.data, stages)

    const progress = progressLine(event, stages)
    if (event.type === "workflow.approval.requested") {
      const detail = await input.client.get({ workflowID: input.workflowID }, { signal: input.signal })
      if (workflowStatus(detail) !== "waiting_approval") return undefined
      input.onProgress("Approval required")
      return { type: "approval", status: "waiting_approval", seq: event.seq, workflow: detail }
    }

    const status = terminalStatus(event.type)
    if (status) input.onTerminal?.(status)
    if (progress) input.onProgress(progress)
    if (status) return { type: "terminal", status, seq: event.seq }
    return undefined
  }

  const accept = async (raw: unknown): Promise<WorkflowObservation | undefined> => {
    const event = parseEvent(raw, input.workflowID)
    if (event.seq <= lastSeq) return undefined
    if (event.seq !== lastSeq + 1) {
      while (true) {
        const page = parseHistory(
          await input.client.history(
            { workflowID: input.workflowID, after: lastSeq, limit: HISTORY_PAGE_SIZE },
            { signal: input.signal },
          ),
          input.workflowID,
        )
        const before = lastSeq
        for (const recovered of page.events) {
          if (recovered.seq <= lastSeq) continue
          if (recovered.seq !== lastSeq + 1) throw new ObservationError("Workflow history has a durable gap")
          const result = await processEvent(recovered)
          lastSeq = recovered.seq
          if (result) return result
        }
        if (!page.hasMore) break
        if (lastSeq === before) throw new ObservationError("Workflow history pagination did not advance")
      }
    }
    if (event.seq <= lastSeq) return undefined
    if (event.seq !== lastSeq + 1) throw new ObservationError("Workflow event gap could not be repaired")
    const result = await processEvent(event)
    lastSeq = event.seq
    return result
  }

  while (true) {
    if (input.signal.aborted) return { type: "interrupted" }
    const request = firstConnection
      ? { workflowID: input.workflowID }
      : { workflowID: input.workflowID, after: lastSeq }
    firstConnection = false
    const beforeConnectionSeq = lastSeq
    try {
      for await (const raw of input.client.events(request, { signal: input.signal })) {
        const result = await accept(raw)
        if (result) return result
      }
    } catch (error) {
      if (input.signal.aborted) return { type: "interrupted" }
      if (error instanceof ObservationError) throw error
      if (!(error instanceof ClientError) || (error.reason !== "Transport" && error.reason !== "UnexpectedStatus")) {
        throw error
      }
    }

    consecutiveDisconnects = lastSeq > beforeConnectionSeq ? 1 : consecutiveDisconnects + 1
    if (consecutiveDisconnects > RECONNECT_DELAYS.length) {
      throw new ObservationError("Workflow event stream reconnect limit reached")
    }
    try {
      await pause(RECONNECT_DELAYS[consecutiveDisconnects - 1], input.signal)
    } catch {
      if (input.signal.aborted) return { type: "interrupted" }
      throw new ObservationError("Workflow event reconnect delay failed")
    }
  }
}

export const WorkflowRunCommand = effectCmd({
  command: "run <prompt>",
  describe: "run a production visual workflow",
  builder: (yargs: Argv) =>
    yargs
      .positional("prompt", {
        describe: "workflow prompt",
        type: "string",
        demandOption: true,
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["default", "json"] as const,
        default: "default" as const,
      }),
  handler: Effect.fn("Cli.workflow.run")(function* (args) {
    yield* Effect.promise(async () => {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : ""
      const format: Format = args.format === "json" ? "json" : "default"
      if (prompt.length === 0) {
        await writeOutput(process.stderr, "Workflow prompt must not be empty" + EOL)
        process.exitCode = 1
        return
      }

      const idempotencyKey = crypto.randomUUID()
      const observationController = new AbortController()
      let client: ReturnType<typeof OpenCode.make> | undefined
      let workflowID: string | undefined
      let responseID: string | undefined
      let terminal = false
      let interrupted = false
      let signals = 0
      let cancelPromise: Promise<void> | undefined
      let interruptionAttempted = false
      let finalWritten = false
      let admittedWorkflow: unknown
      let admittedResponse: unknown

      const progress = (line: string) => {
        writeSync(process.stderr.fd, line + EOL)
      }
      const final = async (value: FinalOutput) => {
        if (finalWritten) return
        finalWritten = true
        const output = format === "json" ? JSON.stringify(value) : humanSummary(value)
        await writeOutput(process.stdout, output + EOL)
      }
      const cancelOnce = () => {
        if (cancelPromise) return cancelPromise
        if (!client || !workflowID || terminal) return Promise.resolve()
        cancelPromise = client.workflows.cancel({ workflowID })
        cancelPromise.catch(() => undefined)
        return cancelPromise
      }
      const finishInterrupted = async () => {
        if (interruptionAttempted) throw new ObservationError("Workflow interruption settlement already attempted")
        interruptionAttempted = true
        if (!client || !workflowID) throw new ObservationError("Workflow interruption authority is unavailable")

        const currentClient = client
        const currentWorkflowID = workflowID
        let summaryWorkflow = admittedWorkflow
        let statusOverride: string | undefined = "cancel_requested"
        try {
          await cancelOnce()
          progress("Cancellation acknowledged")
        } catch (error) {
          if (
            !isWorkflowConflictError(error) ||
            error.workflowID !== currentWorkflowID ||
            error.operation !== "cancel"
          ) {
            throw error
          }
          const detail = await currentClient.workflows.get({ workflowID: currentWorkflowID })
          const status = workflowStatus(detail)
          if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
            throw new ObservationError("Workflow cancellation conflict is not terminal")
          }
          terminal = true
          summaryWorkflow = readRecord(detail, "run")
          statusOverride = undefined
          progress(`Workflow already ${status}`)
        }

        await final({
          workflow: workflowSummary(summaryWorkflow, statusOverride),
          response: responseSummary(admittedResponse),
          artifacts: [],
        })
        process.exitCode = 130
      }
      const sigint = () => {
        signals++
        if (signals > 1) process.exit(130)
        if (terminal) return
        interrupted = true
        observationController.abort()
        void cancelOnce()
      }
      process.on("SIGINT", sigint)

      try {
        client = await localClient()
        const admitted = await admit(client, {
          prompt,
          budget: DEFAULT_BUDGET,
          visual: DEFAULT_VISUAL,
          delivery: "background",
          "idempotency-key": idempotencyKey,
        })
        admittedWorkflow = admitted.workflow
        admittedResponse = admitted.response
        workflowID = requireID(admitted.workflow, "workflow")
        responseID = requireID(admitted.response, "response")
        if (readString(admitted.response, "workflowID") !== workflowID) throw new ObservationError("Response mismatch")
        progress("Workflow admitted")

        if (interrupted) {
          await finishInterrupted()
          return
        }

        const observed = await observeWorkflow({
          workflowID,
          client: {
            events: (request, options) => client!.workflows.events(request, options),
            history: (request, options) => client!.workflows.history(request, options),
            get: (request, options) => client!.workflows.get(request, options),
          },
          signal: observationController.signal,
          onProgress: progress,
          onTerminal: () => {
            terminal = true
          },
        })

        if (observed.type === "interrupted" || interrupted) {
          await finishInterrupted()
          return
        }

        if (observed.type === "approval") {
          terminal = true
          await final({
            workflow: workflowSummary(readRecord(observed.workflow, "run")),
            response: responseSummary(admittedResponse),
            artifacts: [],
          })
          process.exitCode = 2
          return
        }

        const detail = await client.workflows.get({ workflowID })
        const response = await client.responses.get({ responseID })
        if (readString(response, "id") !== responseID || readString(response, "workflowID") !== workflowID) {
          throw new ObservationError("Terminal Response mismatch")
        }
        const artifacts = await client.workflows.artifacts({ workflowID })
        const output = {
          workflow: workflowSummary(detail.run),
          response: responseSummary(response),
          artifacts: artifacts.map(artifactSummary),
        } satisfies FinalOutput
        await final(output)
        process.exitCode = observed.status === "succeeded" ? 0 : observed.status === "failed" ? 1 : 130
      } catch {
        if (interrupted && workflowID && !interruptionAttempted) {
          try {
            await finishInterrupted()
            return
          } catch {
            progress("Workflow cancellation failed")
          }
        }
        progress("Workflow run failed")
        await final({ workflow: null, response: null, artifacts: [] })
        process.exitCode = 1
      } finally {
        process.off("SIGINT", sigint)
      }
    })
  }),
})

export const WorkflowCommand = effectCmd({
  command: "workflow",
  describe: "run production workflows",
  instance: false,
  builder: (yargs: Argv) => yargs.command(WorkflowRunCommand).demandCommand(),
  handler: Effect.fn("Cli.workflow")(function* () {}),
})

async function localClient() {
  const [{ Server }, { ServerAuth }] = await Promise.all([import("@/server/server"), import("@/server/auth")])
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const headers = new Headers(request.headers)
      const authorization = ServerAuth.header()
      if (authorization) headers.set("Authorization", authorization)
      return Server.Default().app.fetch(new Request(request, { headers }))
    },
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch
  return OpenCode.make({
    baseUrl: "http://opencode.internal",
    fetch,
    headers: { "x-opencode-directory": encodeURIComponent(process.cwd()) },
  })
}

async function admit(
  client: ReturnType<typeof OpenCode.make>,
  request: Parameters<typeof client.workflows.visualBuildCreate>[0],
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.workflows.visualBuildCreate(request)
    } catch (error) {
      if (!(error instanceof ClientError) || error.reason !== "Transport" || attempt >= ADMISSION_DELAYS.length)
        throw error
      await sleep(ADMISSION_DELAYS[attempt], new AbortController().signal)
    }
  }
}

function parseEvent(input: unknown, workflowID: string): ParsedEvent {
  let event: WorkflowEvent.DurableEvent
  try {
    event = decodeWorkflowEvent(input)
  } catch {
    throw new ObservationError("Workflow event schema is invalid")
  }
  if (event.data.workflowID !== workflowID || !event.durable || event.durable.aggregateID !== workflowID) {
    throw new ObservationError("Workflow event authority is invalid")
  }
  const seq = event.durable.seq
  if (!Number.isSafeInteger(seq) || typeof seq !== "number" || seq < 1) {
    throw new ObservationError("Workflow event sequence is invalid")
  }
  return { type: event.type, seq, data: event.data as Record<string, unknown> }
}

function parseHistory(input: unknown, workflowID: string) {
  if (!isRecord(input) || !Array.isArray(input.data) || typeof input.hasMore !== "boolean") {
    throw new ObservationError("Workflow history schema is invalid")
  }
  return {
    events: input.data.map((event) => parseEvent(event, workflowID)).toSorted((left, right) => left.seq - right.seq),
    hasMore: input.hasMore,
  }
}

function recordStages(data: Record<string, unknown>, stages: Map<string, Stage>) {
  if (!Array.isArray(data.stages)) throw new ObservationError("Workflow stage definitions are missing")
  for (const input of data.stages) {
    if (!isRecord(input) || !isRecord(input.input) || typeof input.id !== "string" || !isRole(input.type)) continue
    const revision = input.input.revision
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) continue
    stages.set(input.id, { role: input.type, revision })
  }
}

function progressLine(event: ParsedEvent, stages: Map<string, Stage>): string | undefined {
  if (event.type.startsWith("workflow.stage.")) {
    const stage = typeof event.data.stageID === "string" ? stages.get(event.data.stageID) : undefined
    if (!stage) return undefined
    const action = {
      "workflow.stage.queued": "queued",
      "workflow.stage.leased": "leased",
      "workflow.stage.started": "started",
      "workflow.stage.retry_scheduled": "retry scheduled",
      "workflow.stage.succeeded": "succeeded",
      "workflow.stage.skipped": "skipped",
      "workflow.stage.failed": "failed",
      "workflow.stage.cancelled": "cancelled",
    }[event.type]
    if (!action) return undefined
    return `${roles[stage.role]} ${stage.role} r${stage.revision} ${action}`
  }
  if (event.type === "workflow.artifact.created") {
    const stage = typeof event.data.stageID === "string" ? stages.get(event.data.stageID) : undefined
    if (stage?.role === "test") return `Test evidence recorded for r${stage.revision}`
    if (stage?.role === "visual_review") return `Visual evidence recorded for r${stage.revision}`
    return undefined
  }
  if (event.type === "workflow.budget.threshold_reached") {
    const percent = event.data.percent
    const dimension = event.data.dimension
    if ((percent === 50 || percent === 80 || percent === 100) && isBudgetDimension(dimension)) {
      return `Budget ${percent}% ${dimension}`
    }
    return "Budget threshold reached"
  }
  const status = terminalStatus(event.type)
  return status ? `Workflow ${status}` : undefined
}

function terminalStatus(type: string): TerminalStatus | undefined {
  if (type === "workflow.succeeded") return "succeeded"
  if (type === "workflow.failed") return "failed"
  if (type === "workflow.cancelled") return "cancelled"
  return undefined
}

function workflowStatus(input: unknown) {
  const run = readRecord(input, "run")
  return readString(run, "status")
}

type WorkflowSummary = {
  readonly id: string
  readonly status: string
  readonly usage: ReturnType<typeof usageSummary>
  readonly time: ReturnType<typeof timeSummary>
}

type ResponseSummary = {
  readonly id: string
  readonly workflowID: string
  readonly status: string
  readonly background: boolean
  readonly store: boolean
  readonly usage?: ReturnType<typeof responseUsageSummary>
  readonly createdAt: number
  readonly completedAt?: number
}

type ArtifactSummary = {
  readonly kind: string
  readonly mime: string
  readonly size: number
  readonly timeCreated: number
}

type FinalOutput = {
  readonly workflow: WorkflowSummary | null
  readonly response: ResponseSummary | null
  readonly artifacts: ReadonlyArray<ArtifactSummary>
}

function workflowSummary(input: unknown, statusOverride?: string): WorkflowSummary {
  const value = isRecord(input) ? input : {}
  return {
    id: safeID(value.id),
    status: statusOverride ?? workflowStatusValue(value.status),
    usage: usageSummary(value.usage),
    time: timeSummary(value.time),
  }
}

function responseSummary(input: unknown): ResponseSummary {
  const value = isRecord(input) ? input : {}
  const usage = isRecord(value.usage) ? responseUsageSummary(value.usage) : undefined
  return {
    id: safeID(value.id),
    workflowID: safeID(value.workflowID),
    status: responseStatusValue(value.status),
    background: value.background === true,
    store: value.store === true,
    ...(usage ? { usage } : {}),
    createdAt: safeNumber(value.createdAt),
    ...(typeof value.completedAt === "number" && Number.isSafeInteger(value.completedAt)
      ? { completedAt: value.completedAt }
      : {}),
  }
}

function artifactSummary(input: unknown): ArtifactSummary {
  const value = isRecord(input) ? input : {}
  return {
    kind: typeof value.kind === "string" && artifactKinds.has(value.kind) ? value.kind : "workflow.artifact",
    mime: typeof value.mime === "string" && artifactMimes.has(value.mime) ? value.mime : "application/octet-stream",
    size: safeNumber(value.size),
    timeCreated: safeNumber(value.timeCreated),
  }
}

const artifactKinds = new Set([
  "workflow.design.spec",
  "workflow.design.reference-app",
  "workflow.decomposition.plan",
  "workflow.implementation-manifest",
  "workflow.test.result",
  "workflow.test.log",
  "workflow.visual.reference-screenshot",
  "workflow.visual.implementation-screenshot",
  "workflow.visual-review",
  "workflow.delivery",
  "workflow.role.outcome",
])
const artifactMimes = new Set([
  "application/json",
  "application/vnd.opencode.design-spec+json",
  "application/vnd.opencode.reference-app+json",
  "application/vnd.opencode.workflow-decomposition+json",
  "application/vnd.opencode.workflow-implementation+json",
  "application/vnd.opencode.workflow-test+json",
  "application/vnd.opencode.visual-review+json",
  "application/vnd.opencode.workflow-delivery+json",
  "application/vnd.opencode.workflow-role-outcome+json",
  "text/markdown",
  "text/plain",
  "text/plain; charset=utf-8",
  "text/html",
  "image/png",
])

function usageSummary(input: unknown) {
  const value = isRecord(input) ? input : {}
  return {
    tokens: safeNumber(value.tokens),
    turns: safeNumber(value.turns),
    toolCalls: safeNumber(value.toolCalls),
    attempts: safeNumber(value.attempts),
  }
}

function responseUsageSummary(input: Record<string, unknown>) {
  return {
    inputTokens: safeNumber(input.inputTokens),
    outputTokens: safeNumber(input.outputTokens),
    totalTokens: safeNumber(input.totalTokens),
  }
}

function timeSummary(input: unknown) {
  const value = isRecord(input) ? input : {}
  return {
    created: safeNumber(value.created),
    updated: safeNumber(value.updated),
    ...(typeof value.completed === "number" && Number.isSafeInteger(value.completed)
      ? { completed: value.completed }
      : {}),
  }
}

function humanSummary(input: FinalOutput) {
  if (!input.workflow || !input.response) return "Workflow run failed"
  return [
    `Workflow ${input.workflow.id} ${input.workflow.status}`,
    `Response ${input.response.id} ${input.response.status}`,
    `Artifacts ${input.artifacts.length}`,
    ...input.artifacts.map((artifact) => `- ${artifact.kind} (${artifact.mime}, ${artifact.size} bytes)`),
  ].join(EOL)
}

function requireID(input: unknown, label: string) {
  const value = isRecord(input) ? input.id : undefined
  if (typeof value !== "string" || !safeIDPattern.test(value)) throw new ObservationError(`${label} ID is invalid`)
  return value
}

function safeID(input: unknown) {
  return typeof input === "string" && safeIDPattern.test(input) ? input : "redacted"
}

const safeIDPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function workflowStatusValue(input: unknown) {
  return typeof input === "string" && workflowStatuses.has(input) ? input : "unknown"
}

function responseStatusValue(input: unknown) {
  return typeof input === "string" && responseStatuses.has(input) ? input : "unknown"
}

const workflowStatuses = new Set([
  "queued",
  "running",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
  "cancel_requested",
])
const responseStatuses = new Set(["queued", "in_progress", "completed", "incomplete", "failed", "cancelled"])

function safeNumber(input: unknown) {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : 0
}

function readRecord(input: unknown, key: string): Record<string, unknown> {
  if (!isRecord(input) || !isRecord(input[key])) throw new ObservationError(`Workflow ${key} is invalid`)
  return input[key]
}

function readString(input: unknown, key: string) {
  return isRecord(input) && typeof input[key] === "string" ? input[key] : undefined
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function isRole(input: unknown): input is Role {
  return typeof input === "string" && Object.hasOwn(roles, input)
}

function isBudgetDimension(input: unknown): input is "tokens" | "turns" | "toolCalls" | "attempts" | "duration" {
  return (
    input === "tokens" || input === "turns" || input === "toolCalls" || input === "attempts" || input === "duration"
  )
}

function writeOutput(stream: typeof process.stdout | typeof process.stderr, output: string) {
  return new Promise<void>((resolve, reject) => {
    stream.write(output, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(new DOMException("aborted", "AbortError"))
      },
      { once: true },
    )
  })
}
