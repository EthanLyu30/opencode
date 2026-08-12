import { appendFileSync, writeFileSync } from "node:fs"
import { Effect } from "effect"
import { ResponsesV2 } from "@opencode-ai/core/responses"
import { WorkflowV2 } from "@opencode-ai/core/workflow"
import { Responses, Workflow } from "../src"
import { createdOnlyBody, runtimeLayer, seedPair } from "./lib/native-responses-runtime"

const [databasePath, rawWorkflowID, rawResponseID, markerPath, attemptPath, envPath] = process.argv.slice(2)
if (!databasePath || !rawWorkflowID || !rawResponseID || !markerPath || !attemptPath || !envPath) {
  throw new Error("Expected database, workflow, response, marker, attempt, and env paths")
}

const credentialNames = Object.keys(process.env).filter((name) => /(KEY|TOKEN|SECRET|AUTH)/i.test(name))
await Bun.write(envPath, JSON.stringify({ credentialNames }))
if (credentialNames.length > 0) throw new Error(`Credential variables reached child: ${credentialNames.join(",")}`)

const workflowID = Workflow.ID.make(rawWorkflowID)
const responseID = Responses.ID.make(rawResponseID)
const body = createdOnlyBody()
await seedPair(databasePath, workflowID, responseID, true)

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      yield* WorkflowV2.Service
      yield* ResponsesV2.Service
      return yield* Effect.never
    }).pipe(
      Effect.provide(
        runtimeLayer({
          databasePath,
          body,
          ownerID: "crash-worker",
          attemptPath,
          onNativeCreated: (observation) => {
            appendFileSync(attemptPath, "provider-attempt-1:response.created\n")
            writeFileSync(markerPath, JSON.stringify({ responseID, ...observation }))
            process.exit(23)
          },
        }),
      ),
    ),
  ),
)
