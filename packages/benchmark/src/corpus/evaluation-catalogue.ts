import { freeze, type TaskExecutionProfile } from "./evaluation-profile"
export type TaskAdapterDefinition=Readonly<{taskID:string;kind:TaskExecutionProfile["kind"];stratum:TaskExecutionProfile["stratum"];executionKind:TaskExecutionProfile["executionKind"];adapterID:string;sourceEntry:string;probeModules:readonly string[];publicFixtureTemplate:"private"|"design2code"|"chartjs"|"react-pdf"|"marked"|"guardrail";requiredCapabilities:readonly string[];requiredOracleCases:readonly string[]}>
function task(taskID:string,template:TaskAdapterDefinition["publicFixtureTemplate"],sourceEntry:string,requiredOracleCases:string[],capabilities:string[]=[]):TaskAdapterDefinition {
  const kind=template==="guardrail"?"guardrail":"primary"
  return {taskID,kind,stratum:template==="guardrail"?"guardrail":template==="private"?"private":template==="design2code"?"design2code":"swebench-multimodal",executionKind:kind==="guardrail"?"coding-build":"visual-build",adapterID:`${taskID}-v2`,sourceEntry,probeModules:[sourceEntry],publicFixtureTemplate:template,requiredCapabilities:["linux-isolation",...capabilities,...(kind==="primary"?["browser-three-viewports"]:[])],requiredOracleCases}
}
const catalogue=freeze([
  task("private-analytics-dashboard","private","src/analytics.js",["filter","summary","error-state"]),
  task("private-checkout-recovery","private","src/checkout.js",["checkout","recovery","idempotency"]),
  task("private-inventory-admin","private","src/inventory.js",["inventory","filter","validation"]),
  task("private-travel-search","private","src/search.js",["filter","sort","empty","error"]),
  ...["d2c-g29-spelling-bee","d2c-g38-icfp-editorial","d2c-g41-jasmine-docs","d2c-g63-range-engine"].map(id=>task(id,"design2code","index.html",["required-dom","image-load","local-links","page-health"],["dom-probe"])),
  task("swe-chartjs__chart.js-10157","chartjs","src/controllers/controller.bar.js",["zero-bar-radius","min-bar-length","border-skipped","nonzero-regression"],["locked-build","canvas-probe"]),
  task("swe-chartjs__chart.js-10301","chartjs","src/plugins/plugin.legend.js",["legend-hover","legend-leave","on-leave-once","normal-hover"],["locked-build","canvas-events"]),
  task("swe-diegomura__react-pdf-1363","react-pdf","packages/renderer/src/index.js",["text-rgba","view-rgba","background-alpha","non-rgba"],["locked-build","pdf-render","pdf-raster"]),
  task("swe-markedjs__marked-1535","marked","lib/marked.js",["gfm-checkbox","blank-line","nested-list","ordinary-list"],["locked-build","dom-probe"]),
  task("guardrail-data-normalization","guardrail","src/usage.js",["cached-reasoning","uncached","integers","negative","aggregate","stable-order"]),
  task("guardrail-idempotent-orders","guardrail","src/orders.js",["same-key","conflict","reserve-once","cancel","defensive-copy"]),
  {...task("guardrail-registry-refactor","guardrail","src/registry.js",["aliases","cycle","collision-atomicity","sorted-help","original-execution"]),probeModules:["src/registry.js","src/commands.js"]},
  task("guardrail-session-debug","guardrail","src/session.js",["out-of-order","exact-duplicate","conflicting-duplicate","no-input-mutation"]),
])
export function evaluationCatalogue():readonly TaskAdapterDefinition[]{return catalogue}
