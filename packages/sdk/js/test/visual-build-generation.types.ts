import type { WorkflowVisualBuildScriptPreviewInput } from "../src/v2/gen/types.gen.js"

const stringEnvironment = {
  kind: "script",
  argv: ["bun", "run", "preview"],
  env: { NODE_ENV: "test", PORT: "4096" },
} satisfies WorkflowVisualBuildScriptPreviewInput

const numericEnvironment = {
  kind: "script",
  argv: ["bun", "run", "preview"],
  env: {
    // @ts-expect-error generated SDK must reject values the endpoint rejects
    PORT: 4096,
  },
} satisfies WorkflowVisualBuildScriptPreviewInput

void [stringEnvironment, numericEnvironment]
