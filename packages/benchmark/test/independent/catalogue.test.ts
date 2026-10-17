import {expect,test} from "bun:test"
import {evaluationCatalogue} from "../../src/corpus/evaluation-catalogue"
import {publicFixture} from "../../src/corpus/evaluation-author"
test("fixed 16 tasks, 12 primary, four guardrails and unchanged three pilot identities",()=>{
  const tasks=evaluationCatalogue()
  expect(tasks).toHaveLength(16);expect(tasks.filter(t=>t.kind==="primary")).toHaveLength(12);expect(tasks.filter(t=>t.kind==="guardrail")).toHaveLength(4)
  expect(new Set(tasks.map(t=>t.taskID)).size).toBe(16)
  for(const id of ["private-analytics-dashboard","d2c-g29-spelling-bee","swe-chartjs__chart.js-10157"])expect(tasks.some(t=>t.taskID===id)).toBe(true)
  for(const t of tasks){expect(t.requiredOracleCases.length).toBeGreaterThan(2);expect(JSON.stringify(publicFixture(t))).not.toMatch(/expected|gold|patch\.diff|PRIVATE_ORACLE/)}
  expect(tasks.find(t=>t.taskID==="swe-diegomura__react-pdf-1363")!.requiredCapabilities).toContain("pdf-raster")
  expect(publicFixture(tasks.find(t=>t.taskID==="swe-markedjs__marked-1535")!)[".task24/preview.html"]).toContain("lib/marked.js")
  expect(publicFixture(tasks.find(t=>t.taskID==="swe-chartjs__chart.js-10301")!)[".task24/preview.html"]).toContain("mouseleave")
})
