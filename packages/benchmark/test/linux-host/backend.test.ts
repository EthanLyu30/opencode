import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"
import { orchestratorFixture } from "../independent/fixture"
import { sessionFixture } from "./fixture"
import { makeLinuxBackend } from "../../src/sandbox/linux-backend"
import { buildWorkerSource } from "../../src/sandbox/worker"
import { makeProcessRunner } from "../../src/sandbox/docker"
import { linuxProbeWorkerSource } from "../../src/sandbox/worker"
test("R1 forged valid IPC coverage is only candidate return data, never private oracle authority", async () => {
  const f = await sessionFixture(),
    c = await orchestratorFixture()
  try {
    const value = { cases: [{ id: "literal", outputs: [{ kind: "value", value: 5 }] }] },
      source = `process.on('message',r=>process.send(r.kind==='begin'?{seq:r.seq,kind:'reset'}:{seq:r.seq,kind:'value',value:${JSON.stringify(value)}}));process.send({kind:'ready'});await new Promise(()=>{})`
    await fs.writeFile(path.join(f.root, "own.mjs"), source)
    const request = makeProbeRequest({
      identity: c.input.identity,
      profile: { ...c.input.bundle.profile, probeModules: ["own.mjs"] },
      inputs: {
        candidate: c.input.snapshot,
        module: "own.mjs",
        cases: [{ id: "literal", operations: [{ kind: "call", target: "add", args: [2, 3] }] }],
      },
    })
    const runner = makeProcessRunner({
        executable: process.execPath,
        argvPrefix: ["--no-env-file"],
        cwd: f.root,
        env: { BUN_OPTIONS: "--no-env-file" },
      }),
      result = await runner.execute({
        argv: ["-e", linuxProbeWorkerSource(process.execPath), f.root],
        stdin: Buffer.from(canonicalJson(request)),
        timeoutMs: 5000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        signal: new AbortController().signal,
      })
    expect(result.exitCode).toBe(0)
    const actual = decodeProbeResponse(result.stdout).cases[0]!.outputs[0]!
    expect(actual).toEqual({ kind: "value", value })
    expect(actual.kind === "value" && actual.value === 5).toBe(false)
  } finally {
    await f.dispose()
    await c.dispose()
  }
})
test("Linux probe control is separate from candidate stdout, including a valid JSON forgery followed by exit", async () => {
  const f = await sessionFixture(),
    c = await orchestratorFixture()
  try {
    const file = path.join(f.root, "own.mjs"),
      runner = makeProcessRunner({
        executable: process.execPath,
        argvPrefix: ["--no-env-file"],
        cwd: f.root,
        env: { BUN_OPTIONS: "--no-env-file" },
      })
    const request = makeProbeRequest({
      identity: c.input.identity,
      profile: { ...c.input.bundle.profile, probeModules: ["own.mjs"] },
      inputs: {
        candidate: c.input.snapshot,
        module: "own.mjs",
        cases: [{ id: "literal", operations: [{ kind: "call", target: "add", args: [2, 3] }] }],
      },
    })
    for (const [source, success] of [
      [
        'process.stdout.write(\'{"cases":[{"id":"literal","outputs":[{"kind":"value","value":5}]}]}\');process.exit(0)',
        false,
      ],
      ["console.log('not protocol');export const add=(a,b)=>a+b", true],
    ] as const) {
      await fs.writeFile(file, source)
      const r = await runner.execute({
        argv: ["-e", linuxProbeWorkerSource(process.execPath), f.root],
        stdin: Buffer.from(canonicalJson(request)),
        timeoutMs: 10000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        signal: new AbortController().signal,
      })
      expect(r.exitCode === 0).toBe(success)
      if (success) expect(decodeProbeResponse(r.stdout).cases[0]!.outputs).toEqual([{ kind: "value", value: 5 }])
      else expect(r.stdout.length).toBe(0)
    }
  } finally {
    await f.dispose()
    await c.dispose()
  }
})
import { probeWorkerSource, decodeProbeResponse, makeProbeRequest } from "../../src/evaluator/independent/probe"

test("backend binds commands and immutable source, produces raw receipts and always ends its owned container", async () => {
  const f = await sessionFixture(),
    c = await orchestratorFixture()
  try {
    const evidenceRoot = path.join(f.manifest.roots.evidence, "own-evaluation")
    await fs.mkdir(evidenceRoot)
    const runner = {
      async execute(r: Parameters<typeof f.runner.execute>[0]) {
        if (r.argv.includes("exec"))
          return {
            started: true,
            exitCode: 0,
            stdout: Buffer.from('{"commands":[{"id":"test","exitCode":0}]}'),
            stderr: new Uint8Array(),
            truncated: false,
          }
        return f.runner.execute(r)
      },
    }
    const backend = makeLinuxBackend({
      evidenceRoot,
      session: f.session,
      images: {
        schemaVersion: 2,
        platform: "linux/amd64",
        manifestSha256: f.session.manifestSha256,
        tasks: [{ taskID: c.input.identity.taskID, image: f.image, volumes: [], receiptSha256: sha256Text("deps") }],
      },
      runner,
      guard: async () => {},
      profiles: [{ profile: c.input.bundle.profile, outputs: [] }],
    })
    const request = {
      identity: c.input.identity,
      candidate: c.input.snapshot,
      profileSha256: c.input.bundle.profileSha256,
      timeoutMs: 300000,
      commands: c.input.bundle.profile.checks,
      dependency: { kind: "none" as const },
    }
    await expect(
      backend.build({ ...request, commands: [{ ...request.commands[0]!, argv: ["arbitrary"] }] }),
    ).rejects.toThrow()
    expect(f.calls.length).toBe(0)
    const before = await fs.readFile(c.input.snapshot.archiveFile)
    const raw = await backend.build(request)
    expect(raw.payload.kind).toBe("ok")
    expect(raw.receipt.assurance).toBe("fixture")
    expect(await fs.stat(path.join(evidenceRoot, raw.receipt.evidence.relativePath)).then((s) => s.isFile())).toBe(true)
    expect(raw.receipt.binding?.candidateSha256).toBe(c.input.identity.candidateSha256)
    expect(raw).not.toHaveProperty("assurance")
    expect(backend.probeMode({ ...request, module: "src/math.js" })).toBe("node")
    await expect(
      backend.previewSource({
        ...request,
        build: raw.payload.kind === "ok" ? raw.payload.build : undefined,
        preview: {
          entry: "src/math.js",
          kind: "html",
          requiredCapabilities: [],
          interaction: "none",
          timeoutMs: 30000,
        },
      } as never),
    ).rejects.toThrow()
    expect(f.state.removed).toBe(true)
    expect(await fs.readFile(c.input.snapshot.archiveFile)).toEqual(before)
    await expect(
      backend.build({ ...request, candidate: { ...request.candidate, archiveSha256: "0".repeat(64) } }),
    ).rejects.toThrow()
    await backend.dispose()
  } finally {
    await c.dispose()
    await f.dispose()
  }
})

test("trusted build worker and original probe worker execute only own synthetic state factories with literal results", async () => {
  const f = await sessionFixture(),
    c = await orchestratorFixture()
  try {
    const root = path.join(f.manifest.roots.work, "own-synthetic")
    await fs.mkdir(root)
    const runner = makeProcessRunner({
      executable: process.execPath,
      argvPrefix: [],
      cwd: root,
      env: Object.fromEntries(
        Object.entries({ ...process.env, BUN_OPTIONS: "--no-env-file" }).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      ),
    })
    const run = (argv: string[], input: unknown) =>
      runner.execute({
        argv: ["--no-env-file", ...argv],
        stdin: Buffer.from(canonicalJson(input)),
        timeoutMs: 10000,
        maxStdoutBytes: 1048576,
        maxStderrBytes: 65536,
        signal: new AbortController().signal,
      })
    const built = await run(["-e", buildWorkerSource(), root], {
      commands: [
        {
          id: "test",
          cwd: ".",
          argv: [process.execPath, "--no-env-file", "-e", "console.log('not protocol');process.exit(3)"],
          timeoutMs: 5000,
        },
      ],
    })
    expect(JSON.parse(Buffer.from(built.stdout).toString())).toEqual({ commands: [{ id: "test", exitCode: 3 }] })
    for (const [source, expected] of [
      ["export const add=(a,b)=>a-b", -1],
      ["export const add=(a,b)=>a+b", 5],
      ["export const add=(a,b)=>b+a", 5],
    ] as const) {
      await fs.writeFile(path.join(root, "own.mjs"), source)
      const request = makeProbeRequest({
        identity: c.input.identity,
        profile: { ...c.input.bundle.profile, probeModules: ["own.mjs"] },
        inputs: {
          candidate: c.input.snapshot,
          module: "own.mjs",
          cases: [{ id: "literal", operations: [{ kind: "call", target: "add", args: [2, 3] }] }],
        },
      })
      const result = await run(["-e", "process.argv[2]=process.argv.at(-1);\n" + probeWorkerSource(), root], request)
      expect(decodeProbeResponse(result.stdout).cases[0]?.outputs).toEqual([{ kind: "value", value: expected }])
    }
    expect(() => decodeProbeResponse(Buffer.from('{"passed":true}'))).toThrow()
    expect(() => decodeProbeResponse(Buffer.from('{"cases":[]}\n{"passed":true}'))).toThrow()
  } finally {
    await c.dispose()
    await f.dispose()
  }
})
