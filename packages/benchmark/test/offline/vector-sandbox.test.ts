import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { runSandboxedVector } from "../../src/offline/evaluator"
import { Task24Root } from "../../src/root"

const integration = process.env.TASK24_DOCKER_INTEGRATION === "1" ? test : test.skip
const cleanup: string[] = []
afterEach(async () => {
  for (const root of cleanup.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

integration("candidate import cannot recover hidden vector input from process environment, argv, stdin or mounted files", async () => {
  const root = path.join(Task24Root.ensure().tmp, `vector-${crypto.randomUUID()}`)
  cleanup.push(root)
  const repo = path.join(root, "repo")
  await fs.mkdir(repo, { recursive: true })
  await fs.writeFile(path.join(repo, "candidate.js"), `import fs from 'node:fs';const env=fs.readFileSync('/proc/self/environ','utf8');const encoded=env.match(/TASK24_VECTOR_REQUEST=([^\\0]+)/)?.[1]??process.env.TASK24_VECTOR_REQUEST??'';const surfaces=[env,Buffer.from(encoded,'base64').toString(),fs.readFileSync('/proc/self/cmdline','utf8'),fs.readFileSync(0,'utf8')];export function check(){return surfaces.some(s=>s.includes('HIDDEN_VECTOR_CANARY'))}`)
  const result = await runSandboxedVector({ workspaceRoot: repo, sandbox: root, request: {
    module: "candidate.js", fixtures: { secret: "HIDDEN_VECTOR_CANARY" }, operations: [{ type: "call", name: "check" }],
  } })
  expect(result.exitCode).toBe(0)
  expect(JSON.parse(result.stdout.trim())).toEqual([{ ok: true, value: false }])
  expect(result.containerRemoved).toBe(true)
}, 60_000)

integration("timeout removes the daemon-owned container, not just docker.exe", async () => {
  const root = path.join(Task24Root.ensure().tmp, `vector-${crypto.randomUUID()}`)
  cleanup.push(root)
  const repo = path.join(root, "repo")
  await fs.mkdir(repo, { recursive: true })
  await fs.writeFile(path.join(repo, "candidate.js"), "while(true){};export const check=()=>true")
  const result = await runSandboxedVector({ workspaceRoot: repo, sandbox: root, timeoutMs: 1_000, request: {
    module: "candidate.js", fixtures: {}, operations: [{ type: "call", name: "check" }],
  } })
  expect(result.timedOut).toBe(true)
  expect(result.containerRemoved).toBe(true)
}, 60_000)
