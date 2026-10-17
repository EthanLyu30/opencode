import { expect, test } from "bun:test"
import { decodeProbeResponse, makeProbeRequest, probeWorkerSource } from "../../src/evaluator/independent/probe"
import { makeUnavailableEvaluationHost, validateObservation, fixtureObservation } from "../../src/evaluator/independent/host"
import { decodeTaskExecutionProfile } from "../../src/corpus/evaluation-profile"
import { independentFixture, identity, candidate } from "./fixture"

test("strict bounded probe responses never accept verdicts or malformed output", () => {
  for (const value of ['{"passed":true}', '{"cases":[]}', '{"cases":[{"id":"x","outputs":[],"passed":true}]}', '{"cases":[{"id":"x","outputs":[{"kind":"value","value":NaN}]}]}', '{}\n{}']) {
    expect(() => decodeProbeResponse(Buffer.from(value))).toThrow("TASK24_PROBE_RESPONSE_INVALID")
  }
  expect(() => decodeProbeResponse(new Uint8Array(1024 * 1024 + 1))).toThrow("TASK24_PROBE_SIZE_INVALID")
  expect(() => decodeProbeResponse(Buffer.from(JSON.stringify({cases:[{id:"x",outputs:[{kind:"value",value:5}]},{id:"x",outputs:[{kind:"value",value:5}]}]})))).toThrow()
  expect(probeWorkerSource()).not.toMatch(/oracle|expected|passed/)
})
test("only public inputs cross boundary; no host means unavailable and fake attestation rejected", async () => {
  const f = await independentFixture("probe")
  try {
    const profile = decodeTaskExecutionProfile(f.profile)
    const request = makeProbeRequest({identity:identity(), profile, inputs:{candidate,module:"src/math.js",cases:f.oracle.cases.map(c=>({id:c.id,operations:c.operations}))}})
    expect(JSON.stringify(request)).not.toMatch(/PRIVATE_ORACLE|expected|private\//)
    expect(await makeUnavailableEvaluationHost().probe(request)).toMatchObject({kind:"unavailable",reason:"EVALUATION_HOST_UNAVAILABLE"})
    expect(() => makeProbeRequest({identity:identity(),profile,inputs:{candidate,module:"private/answer.js",cases:[]}})).toThrow()
    const o = fixtureObservation(request, {kind:"ok",response:{cases:[{id:"sum",outputs:[{kind:"value",value:5}]}]}})
    expect(() => validateObservation(request,o)).not.toThrow()
    expect(() => validateObservation(request,{...o,assurance:"linux-attested"})).toThrow()
    expect(() => validateObservation(request,{...o,passed:true})).toThrow()
  } finally { await f.dispose() }
})
