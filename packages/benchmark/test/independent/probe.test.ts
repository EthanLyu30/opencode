import { expect, test } from "bun:test"
import { decodeProbeResponse, makeProbeRequest, probeWorkerSource } from "../../src/evaluator/independent/probe"
import {
  makeUnavailableEvaluationHost,
  validateObservation,
  fixtureObservation,
} from "../../src/evaluator/independent/host"
import { decodeTaskExecutionProfile } from "../../src/corpus/evaluation-profile"
import { independentFixture, identity, candidate } from "./fixture"
import fs from "node:fs/promises"
import path from "node:path"

test("review: actual trusted fixture worker retains bounded service handles and input references", async () => {
  const f = await independentFixture("worker-state")
  try {
    const worker = path.join(f.root, "worker.ts")
    await fs.writeFile(worker, probeWorkerSource())
    await fs.writeFile(
      path.join(f.sourceRoot, "src/state.js"),
      `export function createStore(rows){return {add(n){rows.push(n);return rows.slice()},values(){return rows.slice()},clear(values){values.pop();return values}}}`,
    )
    const profile = decodeTaskExecutionProfile({ ...f.profile, probeModules: ["src/state.js"] })
    const cases = [
      {
        id: "state",
        fixtures: { rows: [1] },
        operations: [
          { kind: "call", target: "createStore", args: [{ $ref: "rows" }], store: "service" },
          { kind: "method", target: "service.add", args: [2], store: "copy" },
          { kind: "method", target: "service.clear", args: [{ $ref: "copy" }] },
          { kind: "method", target: "service.values", args: [] },
          { kind: "get", target: "rows", args: [] },
        ],
      },
    ]
    const request = makeProbeRequest({
      identity: identity(),
      profile,
      inputs: { candidate, module: "src/state.js", cases: cases as never },
    })
    const child = Bun.spawn([process.execPath, "--no-env-file", "run", worker, f.sourceRoot], {
      cwd: f.root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    child.stdin.write(JSON.stringify(request))
    child.stdin.end()
    const [output, error] = await Promise.all([new Response(child.stdout).bytes(), new Response(child.stderr).text()])
    expect(await child.exited).toBe(0)
    expect(error).toBe("")
    const actual = decodeProbeResponse(output)
    expect(actual.cases[0]!.outputs).toEqual([
      { kind: "value", value: {} },
      { kind: "value", value: [1, 2] },
      { kind: "value", value: [1] },
      { kind: "value", value: [1, 2] },
      { kind: "value", value: [1, 2] },
    ])
    // Caller-owned input stays unchanged; only the worker's per-case copy is mutable.
    expect(cases[0]!.fixtures.rows).toEqual([1])
    expect(() =>
      makeProbeRequest({
        identity: identity(),
        profile,
        inputs: {
          candidate,
          module: "src/state.js",
          cases: [{ ...cases[0], operations: [{ kind: "get", target: "__proto__.x", args: [] }] }] as never,
        },
      }),
    ).toThrow()
  } finally {
    await f.dispose()
  }
})

test("strict bounded probe responses never accept verdicts or malformed output", () => {
  for (const value of [
    '{"passed":true}',
    '{"cases":[]}',
    '{"cases":[{"id":"x","outputs":[],"passed":true}]}',
    '{"cases":[{"id":"x","outputs":[{"kind":"value","value":NaN}]}]}',
    "{}\n{}",
  ]) {
    expect(() => decodeProbeResponse(Buffer.from(value))).toThrow("TASK24_PROBE_RESPONSE_INVALID")
  }
  expect(() => decodeProbeResponse(new Uint8Array(1024 * 1024 + 1))).toThrow("TASK24_PROBE_SIZE_INVALID")
  expect(() =>
    decodeProbeResponse(
      Buffer.from(
        JSON.stringify({
          cases: [
            { id: "x", outputs: [{ kind: "value", value: 5 }] },
            { id: "x", outputs: [{ kind: "value", value: 5 }] },
          ],
        }),
      ),
    ),
  ).toThrow()
  expect(probeWorkerSource()).not.toMatch(/oracle|expected|passed/)
})
test("only public inputs cross boundary; no host means unavailable and fake attestation rejected", async () => {
  const f = await independentFixture("probe")
  try {
    const profile = decodeTaskExecutionProfile(f.profile)
    const request = makeProbeRequest({
      identity: identity(),
      profile,
      inputs: {
        candidate,
        module: "src/math.js",
        cases: f.oracle.cases.map((c) => ({ id: c.id, operations: c.operations })),
      },
    })
    expect(JSON.stringify(request)).not.toMatch(/PRIVATE_ORACLE|expected|private\//)
    expect(await makeUnavailableEvaluationHost().probe(request)).toMatchObject({
      kind: "unavailable",
      reason: "EVALUATION_HOST_UNAVAILABLE",
    })
    expect(() =>
      makeProbeRequest({
        identity: identity(),
        profile,
        inputs: { candidate, module: "private/answer.js", cases: [] },
      }),
    ).toThrow()
    const o = fixtureObservation(request, {
      kind: "ok",
      response: { cases: [{ id: "sum", outputs: [{ kind: "value", value: 5 }] }] },
    })
    expect(() => validateObservation(request, o)).not.toThrow()
    expect(() => validateObservation(request, { ...o, assurance: "linux-attested" })).toThrow()
    expect(() => validateObservation(request, { ...o, passed: true })).toThrow()
  } finally {
    await f.dispose()
  }
})
