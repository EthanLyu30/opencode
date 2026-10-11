import { WorkflowModelCatalogStore } from "../src/workflow/model-catalog/store"
import { fixtureCatalogue, fixturePolicy, fixtureScope } from "./fixtures/workflow-model-catalog"

const [root, mode, expected, time] = process.argv.slice(2)
if (!root || !mode || !expected || !time || !process.send) throw new Error("catalogue fixture arguments required")
const go = new Promise<void>((resolve) => process.once("message", () => resolve()))
process.send({ phase: "ready" })
await go
try {
  const store = await WorkflowModelCatalogStore.open(root, fixtureScope, {
    onPublish: async (phase) => {
      if (phase !== mode) return
      process.send?.({ phase })
      await new Promise<void>(() => {})
    },
  })
  const catalogue = fixtureCatalogue({ observedAt: Number(time) })
  const head = await store.publish({
    expectedHeadSha256: expected === "null" ? null : expected,
    catalogue,
    policy: fixturePolicy(catalogue),
  })
  process.send({ head })
} catch (error) {
  process.send({ code: error && typeof error === "object" && "code" in error ? error.code : "worker_failed" })
}
process.disconnect()
