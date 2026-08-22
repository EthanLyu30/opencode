export * as WorkflowTools from "./workflow"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const commandName = "workflow_command"
export const finalizeName = "workflow_finalize"

const Input = Schema.Struct({
  paths: Schema.Array(
    Schema.String.annotate({ description: "Location-relative or internal absolute workspace path to validate" }),
  ),
})

const Output = Schema.Struct({ paths: Schema.Array(Schema.String) })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service
    const make = (name: typeof commandName | typeof finalizeName, description: string) =>
      Tool.make({
        description,
        input: Input,
        output: Output,
        toModelOutput: ({ output }) => [
          { type: "text", text: `Validated workspace paths: ${output.paths.join(", ") || "."}` },
        ],
        execute: (input, context) =>
          Effect.gen(function* () {
            const targets = yield* Effect.forEach(input.paths, (path) => mutation.resolve({ path, kind: "directory" }))
            if (targets.some((target) => target.externalDirectory !== undefined)) {
              return yield* new ToolFailure({ message: "Workflow operations must stay inside the persisted Location" })
            }
            yield* permission.assert({
              action: name,
              resources: targets.map((target) => target.resource),
              save: ["*"],
              sessionID: context.sessionID,
              agent: context.agent,
              source: {
                type: "tool",
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              },
            })
            return { paths: targets.map((target) => target.resource) }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ToolFailure
                ? error
                : new ToolFailure({ message: "Unable to validate workflow workspace paths" }),
            ),
          ),
      })

    yield* tools
      .register({
        [commandName]: make(
          commandName,
          "Run the workflow's fixed in-process workspace validation operation. This never spawns a process, accepts no command string, and rejects paths outside the persisted Location.",
        ),
        [finalizeName]: make(
          finalizeName,
          "Finalize delivery by validating declared paths inside the persisted Location. This never mutates files, spawns a process, or accepts a command string.",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/workflow",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, PermissionV2.node],
})
