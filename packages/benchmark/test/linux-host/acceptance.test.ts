import { test, expect } from "bun:test"
import { acceptLinuxEngine, summarizeEngineChecks, engineCheckIDs } from "../../src/sandbox/acceptance"
import { sessionFixture } from "./fixture"
import { sessionState } from "../../src/sandbox/preflight"
import { createOwnedContainer, cleanupOwnedContainer } from "../../src/sandbox/ownership"
import { linuxSafetyWorkerSource } from "../../src/sandbox/acceptance-worker"
import { makeProcessRunner } from "../../src/sandbox/docker"
import { verifyFrozenArtifacts } from "../../src/sandbox/engine-evidence"
test("missing acceptance authority and fixture-only transports cannot mint an engine receipt", async () => {
  expect(await acceptLinuxEngine({} as never)).toMatchObject({ status: "blocked" })
  const f = await sessionFixture()
  try {
    const r = await acceptLinuxEngine({
      session: f.session,
      manifest: f.manifest,
      approval: sessionState(f.session).approval,
      runner: f.runner,
      guard: async () => {},
    } as never)
    expect(r.status).toBe("blocked")
    expect(r).not.toHaveProperty("receipt")
    expect(f.calls).toHaveLength(0)
  } finally {
    await f.dispose()
  }
})
test("missing, duplicate, simulated or unrun matrix rows remain non-ready", () => {
  const checks = engineCheckIDs.map((id) => ({ id, status: "passed" as const, evidence: [], code: null }))
  expect(summarizeEngineChecks(checks)).toBe("blocked")
  expect(summarizeEngineChecks(checks.slice(1))).toBe("blocked")
  expect(summarizeEngineChecks([...checks, checks[0]!])).toBe("blocked")
})
test("create-before-start acceptance case remains owned and cleanup never starts it", async () => {
  const f = await sessionFixture()
  try {
    const owner = await createOwnedContainer({
      session: f.session,
      runner: f.runner,
      owner: f.owner,
      spec: { image: f.image, argv: ["/usr/local/bin/node", "-e", "setInterval(()=>{},1000)"] },
      guard: async () => {},
      signal: new AbortController().signal,
      start: false,
    })
    expect(f.state.running).toBe(false)
    expect(f.calls.some((c) => c.argv[1] === "start")).toBe(false)
    expect(await cleanupOwnedContainer({ session: f.session, runner: f.runner, owner, guard: async () => {} })).toEqual(
      { ended: true, removed: true },
    )
  } finally {
    await f.dispose()
  }
})
test("own Linux safety driver fails closed on the Windows controller before any Linux probe", async () => {
  const f = await sessionFixture()
  try {
    const runner = makeProcessRunner({
      executable: process.execPath,
      argvPrefix: ["--no-env-file"],
      cwd: f.root,
      env: Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
      ),
    })
    const result = await runner.execute({
      argv: ["-e", linuxSafetyWorkerSource()],
      stdin: Buffer.from("{}"),
      timeoutMs: 5000,
      maxStdoutBytes: 1048576,
      maxStderrBytes: 65536,
      signal: new AbortController().signal,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout.byteLength).toBe(0)
  } finally {
    await f.dispose()
  }
})
test("frozen artifact revalidation checks actual image platform and repo digest, not only the reference string", async () => {
  const f = await sessionFixture()
  try {
    let arch = "amd64"
    const runner = {
      execute: async () => ({
        started: true,
        exitCode: 0,
        stdout: Buffer.from(
          JSON.stringify({ Os: "linux", Architecture: arch, RepoDigests: [f.image], Id: "sha256:" + "e".repeat(64) }),
        ),
        stderr: new Uint8Array(),
        truncated: false,
      }),
    }
    await verifyFrozenArtifacts(f.manifest, runner)
    arch = "arm64"
    await expect(verifyFrozenArtifacts(f.manifest, runner)).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})
