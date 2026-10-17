import { test, expect } from "bun:test"
import { makeProcessRunner, makeDockerRunner } from "../../src/sandbox/docker"
import { hostFixture } from "./fixture"

test("actual trusted fixture process preserves binary stdin/stdout and enforces output/cancel limits", async () => {
  const f = await hostFixture()
  try {
    const runner = makeProcessRunner({
      executable: Bun.which("bun")!,
      argvPrefix: ["--no-env-file", "-e"],
      cwd: f.root,
      env: { TEMP: f.request.roots.temp, TMP: f.request.roots.temp, BUN_OPTIONS: "--no-env-file" },
    })
    const common = { timeoutMs: 2000, maxStdoutBytes: 100, maxStderrBytes: 100, signal: new AbortController().signal }
    const echo = await runner.execute({
      ...common,
      argv: ["process.stdout.write(Buffer.from(await Bun.stdin.arrayBuffer()))"],
      stdin: new Uint8Array([0, 255, 13, 10]),
    })
    expect(Array.from(echo.stdout)).toEqual([0, 255, 13, 10])
    expect(echo.exitCode).toBe(0)
    const bounded = await runner.execute({
      ...common,
      argv: ['process.stdout.write("x".repeat(1000))'],
      maxStdoutBytes: 20,
    })
    expect(bounded.truncated).toBe(true)
    expect(bounded.stdout.length).toBeLessThanOrEqual(20)
    const cancel = new AbortController()
    cancel.abort()
    expect(
      (await runner.execute({ ...common, signal: cancel.signal, argv: ['throw Error("must not run")'] })).started,
    ).toBe(false)
    const docker = makeDockerRunner({ request: f.request })
    await expect(docker.execute({ ...common, argv: ["container", "create", "x"] })).rejects.toThrow(
      "TASK24_LINUX_OPERATION_DENIED",
    )
  } finally {
    await f.dispose()
  }
})
