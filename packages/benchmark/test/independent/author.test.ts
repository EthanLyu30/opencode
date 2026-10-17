import {expect,test} from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import {prepareEvaluationCorpus,validatePreparationRoots,prepareTaskMaterials} from "../../src/corpus/evaluation-author"
import {evaluationCatalogue} from "../../src/corpus/evaluation-catalogue"
import {independentFixture} from "./fixture"
import {sha256Text} from "../../src/hash"
test("preparation roots reject reuse, overlap, deployment and arbitrary source roots before writes",async()=>{
  const sourceRoot="D:\\OpenCode-Benchmark\\Task24\\assets\\tasks"
  for(const outputRoot of [sourceRoot,"D:\\","D:\\OpenCode-Local","D:\\OpenCode-Benchmark\\Task24\\runs\\new","D:\\OpenCode-Benchmark\\Task24\\assets"])await expect(validatePreparationRoots({sourceRoot,outputRoot})).rejects.toThrow()
  const f=await independentFixture("author-roots")
  try{
    await expect(prepareEvaluationCorpus({sourceRoot:f.sourceRoot,outputRoot:path.join(f.root,"new")})).rejects.toThrow()
    await expect(validatePreparationRoots({sourceRoot,outputRoot:f.root})).rejects.toThrow()
    expect(await fs.readFile(path.join(f.sourceRoot,"src/math.js"),"utf8")).toBe(f.source)
  }finally{await f.dispose()}
})
test("material author keeps raw hidden tests private and missing true engine assets blocked, never fake hashes",async()=>{
  const f=await independentFixture("author-material")
  try{
    const task=evaluationCatalogue().find(t=>t.taskID==="guardrail-data-normalization")!
    const sourceFiles={"starter/package.json":Buffer.from('{"type":"module"}'),"starter/src/usage.js":Buffer.from("export const normalizeUsage=()=>[]"),"gold/functional.test.ts":Buffer.from(f.oracleCanary),"LICENSES.json":Buffer.from("[]")}
    const item=await prepareTaskMaterials({task,outputRoot:path.join(f.root,"prepared"),sourceFiles,sourceRevision:"fixture",sourceSha256:sha256Text("source")})
    expect(item.status).toBe("blocked");expect(item.oracleSha256).toBeNull();expect(item.missing).toContain("independent-oracle-cases")
    const publicText=await fs.readFile(path.join(f.root,"prepared/public/.task24/smoke.test.ts"),"utf8")
    expect(publicText).not.toContain(f.oracleCanary)
    expect(await fs.readFile(path.join(f.root,"prepared/private/legacy/functional.test.ts"),"utf8")).toBe(f.oracleCanary)
    const controls=JSON.parse(await fs.readFile(path.join(f.root,"prepared/private/calibration-plan.json"),"utf8"))
    expect(controls.required).toEqual(["correct","alternate-correct","seed","functional-bad","policy-bad"])
    expect(controls.executed).toBe(false)
  }finally{await f.dispose()}
})
