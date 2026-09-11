import fs from "node:fs/promises"
import path from "node:path"
import { Database as BunDatabase } from "bun:sqlite"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ResponsesProjector } from "@opencode-ai/core/responses/projector"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { WorkflowProjector } from "@opencode-ai/core/workflow/projector"
import { Cause, Effect, Exit, Option } from "effect"
import { scanDatabase } from "./workflow-production-safety"

const replayProjectionTables = Object.freeze([
  "workflow_run",
  "workflow_stage",
  "workflow_artifact",
  "response",
  "response_item",
  "session",
  "session_input",
  "session_message",
  "message",
  "part",
  "conversation",
  "conversation_item",
] as const)

interface SerializedEventRow {
  readonly id: string
  readonly aggregateID: string
  readonly seq: number
  readonly type: string
  readonly data: unknown
  readonly batchID: string
  readonly batchIndex: number
  readonly batchSize: number
}

export async function replayProductionBatches(
  databasePath: string,
  caseRoot: string,
): Promise<{
  readonly eventCount: number
  readonly batchCount: number
  readonly incompleteCases: number
  readonly secondReplayIdempotent: true
}> {
  const source = new BunDatabase(databasePath, { readonly: true })
  let rows: Array<{
    id: string
    aggregate_id: string
    seq: number
    type: string
    data: string
    batch_id: string | null
    batch_index: number | null
    batch_size: number | null
  }>
  try {
    rows = source
      .query<
        {
          id: string
          aggregate_id: string
          seq: number
          type: string
          data: string
          batch_id: string | null
          batch_index: number | null
          batch_size: number | null
        },
        []
      >("SELECT id, aggregate_id, seq, type, data, batch_id, batch_index, batch_size FROM event ORDER BY rowid")
      .all()
  } finally {
    source.close()
  }
  const serialized = rows.map((row): SerializedEventRow => {
    if (row.batch_id === null || row.batch_index === null || row.batch_size === null) {
      throw new Error("Production replay encountered a legacy unbatched EventV2 row")
    }
    return {
      id: row.id,
      aggregateID: row.aggregate_id,
      seq: row.seq,
      type: row.type,
      data: JSON.parse(row.data),
      batchID: row.batch_id,
      batchIndex: row.batch_index,
      batchSize: row.batch_size,
    }
  })
  const batches = Map.groupBy(serialized, (event) => event.batchID)
  const sourceProjection = projectionSnapshot(databasePath)
  const replayRoot = path.join(caseRoot, "replay")
  await fs.mkdir(replayRoot, { recursive: true })
  const replayPath = path.join(replayRoot, "complete.sqlite")
  await runReplay(replayPath, serialized)
  const first = projectionSnapshot(replayPath)
  if (JSON.stringify(first) !== JSON.stringify(sourceProjection)) {
    throw new Error("Fresh EventV2 replay differs from the production projection")
  }
  await runReplay(replayPath, serialized)
  const second = projectionSnapshot(replayPath)
  if (JSON.stringify(second) !== JSON.stringify(first)) {
    throw new Error("A second EventV2 replay was not idempotent")
  }

  const selected = [
    [...batches.values()].find((batch) => batch.some((event) => event.type === "workflow.created.1")),
    [...batches.values()].find((batch) => batch.some((event) => event.type === "workflow.stage.skipped.1")),
    [...batches.values()].find(
      (batch) =>
        batch.some((event) => event.type === "response.completed.1") &&
        batch.some((event) => event.type === "workflow.succeeded.1"),
    ),
  ]
  if (selected.some((batch) => batch === undefined || batch.length <= 1)) {
    throw new Error("Admission, skipped visual, or terminal related batch is absent")
  }
  const incompletePath = path.join(replayRoot, "incomplete.sqlite")
  let incompleteCases = 0
  await runIncompleteReplays(
    incompletePath,
    selected.flatMap((batch) =>
      batch!.map((_, missing) => {
        incompleteCases++
        return batch!.filter((_member, index) => index !== missing)
      }),
    ),
  )
  const incompleteProjection = projectionSnapshot(incompletePath)
  if (Object.values(incompleteProjection).some((table) => table.length !== 0)) {
    throw new Error("An incomplete related batch mutated a business projection")
  }
  scanDatabase(replayPath, "$replayDatabase", new Set())
  scanDatabase(incompletePath, "$incompleteReplayDatabase", new Set())
  return {
    eventCount: serialized.length,
    batchCount: batches.size,
    incompleteCases,
    secondReplayIdempotent: true,
  }
}

async function runReplay(file: string, events: readonly SerializedEventRow[]): Promise<void> {
  const layer = replayLayer(file)
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* EventV2.Service
      yield* service.replayBatches(events as never)
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}

async function runIncompleteReplays(file: string, cases: readonly (readonly SerializedEventRow[])[]): Promise<void> {
  const layer = replayLayer(file)
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* EventV2.Service
      for (const partial of cases) {
        const result = yield* service.replayBatches(partial as never).pipe(Effect.exit)
        const error = Exit.isFailure(result) ? Option.getOrUndefined(Cause.findErrorOption(result.cause)) : undefined
        if (error === undefined || Reflect.get(error, "reason") !== "incomplete_batch") {
          return yield* Effect.die("Incomplete related EventV2 batch did not fail closed")
        }
      }
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
}

function replayLayer(file: string) {
  return AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      WorkflowProjector.node,
      ResponsesProjector.node,
      SessionProjector.node,
    ]),
    [[Database.node, Database.layerFromPath(file)]],
  )
}

function projectionSnapshot(file: string): Readonly<Record<string, readonly unknown[]>> {
  const database = new BunDatabase(file, { readonly: true })
  try {
    return Object.fromEntries(
      replayProjectionTables.map((table) => {
        const rows = database.query<Record<string, unknown>, []>(`SELECT * FROM ${table}`).all()
        return [table, rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))]
      }),
    )
  } finally {
    database.close()
  }
}
