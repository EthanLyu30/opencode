import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowModelCatalogPolicy } from "@opencode-ai/core/workflow/model-catalog/policy"
import { Effect, Schema } from "effect"
import { OpenCode } from "@opencode-ai/client"
import { confirm, isCancel } from "@clack/prompts"
import { CliError, effectCmd, fail } from "../effect-cmd"
export interface ActivationOptions {
  client: {
    list: () => Promise<WorkflowModelCatalog.View>
    activate: (input: WorkflowModelCatalog.ActivationInput) => Promise<WorkflowModelCatalog.View>
  }
  family: WorkflowModelCatalog.SelectedFamily
  modelID: string
  yes: boolean
  interactive: boolean
  confirm?: () => Promise<boolean>
  preview: (line: string) => void
}
export function formatModelChoices(input: WorkflowModelCatalog.View): string[] {
  const view = Schema.decodeUnknownSync(WorkflowModelCatalog.View)(input)
  return [
    ...(view.policy
      ? Object.entries(view.policy.choices).map(([family, entry]) => `${family}: ${entry.providerID}/${entry.modelID}`)
      : ["selection_required: configure and refresh the workflow catalogue"]),
    ...(view.catalogue?.models.map(
      (entry) =>
        `${entry.providerID}/${entry.modelID} ${entry.family} ${entry.availability} ${entry.compatibility} ${entry.lifecycle} price:${entry.priceSha256 ?? "unknown"}`,
    ) ?? []),
    ...(view.stale ? ["stale: refresh before confirming a change"] : []),
    ...(view.failureCode ? [`status: ${view.failureCode}`] : []),
    "Existing tasks remain pinned; provider weights cannot be pinned beyond advertised revisions.",
  ]
}
export async function activateWorkflowModel(input: ActivationOptions): Promise<WorkflowModelCatalog.View | undefined> {
  if (!input.yes && !input.interactive) throw new Error("Noninteractive activation requires --yes")
  const family = Schema.decodeUnknownSync(WorkflowModelCatalog.SelectedFamily)(input.family)
  const modelID = Schema.decodeUnknownSync(WorkflowModelCatalog.ModelID)(input.modelID)
  const view = Schema.decodeUnknownSync(WorkflowModelCatalog.View)(await input.client.list())
  if (!view.head || !view.policy || !view.catalogue || view.stale)
    throw new Error("selection_required: refresh and confirm a current catalogue")
  const providerID = family === "kimi-flagship" ? "kimi" : "deepseek"
  const entry = view.catalogue.models.find((entry) => entry.providerID === providerID && entry.modelID === modelID)
  const roles = Object.entries(WorkflowModelCatalogPolicy.requirements)
    .filter(([, required]) => required.family === family)
    .map(([role]) =>
      Schema.decodeUnknownSync(
        Schema.Literals(["design", "decompose", "implement", "test", "visual_review", "repair", "deliver"]),
      )(role),
    )
  if (!entry || entry.family !== family || roles.some((role) => !WorkflowModelCatalogPolicy.eligible(entry, role)))
    throw new Error("unverified_contract: candidate cannot satisfy every affected role")
  input.preview(
    `${view.policy.choices[family].modelID} → ${modelID}; roles: ${roles.join(", ")}; price revision: ${entry.priceSha256}; existing tasks stay pinned`,
  )
  if (!input.yes && !(await input.confirm?.())) return undefined
  return input.client.activate(
    Schema.decodeUnknownSync(WorkflowModelCatalog.ActivationInput)({
      expectedHeadSha256: view.head.sha256,
      replacements: [{ family, providerID, modelID }],
    }),
  )
}
async function localClient() {
  const { makeLocalHandler } = await import("@opencode-ai/server/workflow/model-catalog-local")
  const local = makeLocalHandler()
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const headers = new Headers(request.headers)
      headers.set("Authorization", local.header)
      return local.handler(new Request(request, { headers }))
    },
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch
  return {
    client: OpenCode.make({ baseUrl: "http://opencode.internal", fetch }).workflowModels,
    dispose: local.dispose,
  }
}
const ActivateCommand = effectCmd({
  command: "activate <family> <modelID>",
  describe: "confirm a workflow model replacement",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("family", {
        type: "string",
        choices: WorkflowModelCatalog.SelectedFamily.literals,
        demandOption: true,
      })
      .positional("modelID", { type: "string", demandOption: true })
      .option("yes", { type: "boolean", default: false }),
  handler: Effect.fn("Cli.workflowModels.activate")(function* (args) {
    const local = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: localClient, catch: () => new CliError({ message: "Catalogue client unavailable" }) }),
      (local) => Effect.promise(local.dispose),
    )
    yield* Effect.tryPromise({
      try: () =>
        activateWorkflowModel({
          client: local.client,
          family: Schema.decodeUnknownSync(WorkflowModelCatalog.SelectedFamily)(args.family),
          modelID: args.modelID,
          yes: args.yes,
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
          preview: (line) => process.stderr.write(line + "\n"),
          confirm: async () => {
            const answer = await confirm({ message: "Activate this replacement?", initialValue: false })
            return !isCancel(answer) && answer === true
          },
        }),
      catch: () => new Error("Model activation rejected; refresh and confirm a compatible choice"),
    }).pipe(Effect.catch(() => fail("Model activation rejected; refresh and confirm a compatible choice")))
  }, Effect.scoped),
})
export const WorkflowModelsCommand = effectCmd({
  command: "models",
  describe: "list and confirm workflow model choices",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("refresh", { type: "boolean", default: false })
      .option("json", { type: "boolean", default: false })
      .command(ActivateCommand),
  handler: Effect.fn("Cli.workflowModels.list")(function* (args) {
    const local = yield* Effect.acquireRelease(
      Effect.tryPromise({ try: localClient, catch: () => new CliError({ message: "Catalogue client unavailable" }) }),
      (local) => Effect.promise(local.dispose),
    )
    const view = yield* Effect.tryPromise({
      try: () => (args.refresh ? local.client.refresh({ force: true }) : local.client.list()),
      catch: () => new Error("Catalogue unavailable"),
    }).pipe(Effect.catch(() => fail("Catalogue unavailable; check provider configuration")))
    process.stdout.write(args.json ? JSON.stringify(view) + "\n" : formatModelChoices(view).join("\n") + "\n")
  }, Effect.scoped),
})
