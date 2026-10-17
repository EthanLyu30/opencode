import { test, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { sessionFixture } from "./fixture"
import { linuxProbeWorkerSource } from "../../src/sandbox/worker"
import { isReadonlyDockerInvocation, makeProcessRunner } from "../../src/sandbox/docker"
import { browserLaunchPolicy } from "../../src/sandbox/browser-helper"
import { dataFrameWasBlocked, verifyBrowserFileInventory } from "../../src/sandbox/browser"
import { loadLinuxBrowserRelease } from "../../src/sandbox/browser"
import { browserBuildSha256 } from "../../src/evaluator/browser-runtime"
import { canonicalJson } from "../../src/campaign/canonical"
import { sha256Text } from "../../src/hash"
import { bindFixtureOutputs } from "../../src/sandbox/fixture-provider"
import { bindEffectiveSwap } from "../../src/sandbox/storage-source"
import { reuseLinuxPreview, startLinuxPreview } from "../../src/sandbox/preview"
import { dispatchAcceptanceProbe } from "../../src/sandbox/runtime"
import { validateDependencyAudit } from "../../src/sandbox/dependency-auditors"
import { verifyBinaryBuildRecords, validateBinaryBuildLocation } from "../../src/sandbox/binary-build"
import { requireBrowserIsolationRunner } from "../../src/sandbox/capability"
import { fileIdentity } from "../../src/sandbox/storage"
import { validateFontPath } from "../../src/sandbox/fonts"
test("R10 native font inputs are explicitly read-only inputs, not an arbitrary C-drive file reader", () => {
  expect(validateFontPath("C:\\Windows\\Fonts\\own.ttf")).toBe("C:\\Windows\\Fonts\\own.ttf")
  for (const name of [
    "C:\\Users\\own\\.env.local",
    "C:\\Windows\\Fonts\\..\\secret.ttf",
    "C:\\Windows\\Fonts\\private.json",
  ])
    expect(() => validateFontPath(name)).toThrow()
})

test("R1 probe child never receives observation authority or full-case result channel", () => {
  const source = linuxProbeWorkerSource()
  expect(source).not.toContain("TASK24_PROBE_REPLY")
  expect(source).not.toContain("outputs:cases.map")
})
test("R2 sandbox is explicit and candidate browser execution has no ordinary native fallback", () => {
  expect(browserLaunchPolicy()).toMatchObject({ chromiumSandbox: true })
  expect(browserLaunchPolicy().args).not.toContain("--no-sandbox")
  expect(() =>
    requireBrowserIsolationRunner(
      makeProcessRunner({ executable: process.execPath, argvPrefix: [], cwd: process.cwd(), env: {} }),
    ),
  ).toThrow("TASK24_BROWSER_OS_ISOLATION_REQUIRED")
})
test("R3 actual frozen-artifact image command is admitted as exactly read-only", () => {
  const image = "example.invalid/task24@sha256:" + "a".repeat(64)
  expect(isReadonlyDockerInvocation(["image", "inspect", "--format", "{{json .}}", image], true)).toBe(true)
  expect(isReadonlyDockerInvocation(["image", "inspect", image, "--format", "{{json .}}"], true)).toBe(true)
  expect(
    isReadonlyDockerInvocation(["image", "inspect", "--format", "{{json .}}", image, "--config", "C:\\private"], true),
  ).toBe(false)
})
test("R5 correct native CSP blocking does not become a false data-frame failure", () => {
  expect(dataFrameWasBlocked({ executed: false, closed: false, frameURL: "about:blank", cspDenied: true })).toBe(true)
  expect(dataFrameWasBlocked({ executed: true, closed: false, frameURL: "data:text/html,own", cspDenied: false })).toBe(
    false,
  )
})
test("R6 pre-attestation dispatcher routes a browser probe only through the browser", async () => {
  const calls: string[] = []
  const result = await dispatchAcceptanceProbe({
    mode: "browser",
    browser: async () => {
      calls.push("browser")
      return "actual-browser-data"
    },
    linux: async () => {
      calls.push("linux")
      return "wrong"
    },
  })
  expect(result).toBe("actual-browser-data")
  expect(calls).toEqual(["browser"])
})
test("R7 finite fixture event binds only an actually returned public tool ID", () => {
  const body = {
    messages: [{ role: "tool", tool_call_id: "own-preview", content: JSON.stringify({ previewID: "b".repeat(64) }) }],
  }
  expect(bindFixtureOutputs({ arguments: '{"previewID":"{{tool:own-preview:previewID}}"}' }, body)).toEqual({
    arguments: '{"previewID":"' + "b".repeat(64) + '"}',
  })
  expect(() => bindFixtureOutputs({ arguments: "{{tool:missing:previewID}}" }, body)).toThrow()
  expect(() => bindFixtureOutputs({ arguments: "{{tool:own-preview:capability}}" }, body)).toThrow()
})
test("R8 current dependency audit refuses changed tree, absent identity or wrong platform", () => {
  const expected = {
    platform: "linux/amd64",
    workerSha256: "a".repeat(64),
    volumes: [{ name: "task24-dep-" + "b".repeat(64), treeSha256: "b".repeat(64), fileID: "1:2:3" }],
  }
  expect(() => validateDependencyAudit({ ...expected, tools: ["node", "bun"] }, expected)).not.toThrow()
  expect(() =>
    validateDependencyAudit(
      { ...expected, volumes: [{ ...expected.volumes[0]!, treeSha256: "c".repeat(64) }], tools: ["node", "bun"] },
      expected,
    ),
  ).toThrow()
  expect(() =>
    validateDependencyAudit({ ...expected, platform: "win32/amd64", tools: ["node", "bun"] }, expected),
  ).toThrow()
  expect(() =>
    validateDependencyAudit(
      {
        ...expected,
        volumes: [{ name: expected.volumes[0]!.name, treeSha256: expected.volumes[0]!.treeSha256 }],
        tools: ["node", "bun"],
      },
      expected,
    ),
  ).toThrow()
})
test("R9 old deployment cannot serve as newly built toolchain provenance", async () => {
  expect(() => validateBinaryBuildLocation("D:\\OpenCode-Local\\bin\\opencode-local.exe")).toThrow()
  expect(() =>
    validateBinaryBuildLocation("D:\\OpenCode-Benchmark\\Task24\\toolchain\\new-own\\opencode.exe"),
  ).not.toThrow()
  const f = await sessionFixture()
  try {
    await expect(verifyBinaryBuildRecords({ manifest: f.manifest })).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})
test("R10 full browser file identities are reread, including indirect semantic artifacts", async () => {
  const f = await sessionFixture()
  try {
    const identity = await fileIdentity(f.cli.path)
    await verifyBrowserFileInventory([identity])
    await fs.writeFile(f.cli.path, "drift")
    await expect(verifyBrowserFileInventory([identity])).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})
test("R10 common guard loads the complete content-addressed browser manifest in read-only mode", async () => {
  const f = await sessionFixture(),
    parent = "D:\\OpenCode-Benchmark\\Task24\\toolchain\\browser"
  const content = {
      "node.exe": "own-node-" + f.root,
      "helper.mjs": "own-helper-" + f.root,
      "chrome.exe": "own-chrome-" + f.root,
    },
    files = Object.entries(content)
      .map(([p, value]) => ({ path: p, sha256: sha256Text(value), bytes: Buffer.byteLength(value) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    body = {
      schemaVersion: 1 as const,
      protocolVersion: 1 as const,
      nodeFile: "node.exe",
      helperFile: "helper.mjs",
      browserExecutableFile: "chrome.exe",
      files,
    },
    sha = browserBuildSha256(body),
    root = path.join(parent, sha)
  let created = false
  try {
    await fs.mkdir(parent, { recursive: true })
    await fs.mkdir(root)
    created = true
    for (const [p, bytes] of Object.entries(content)) await fs.writeFile(path.join(root, p), bytes, { flag: "wx" })
    await fs.writeFile(
      path.join(root, "task24-browser-runtime.manifest.json"),
      canonicalJson({ ...body, buildSha256: sha }),
      { flag: "wx" },
    )
    expect(loadLinuxBrowserRelease(root, sha).buildSha256).toBe(sha)
    await fs.writeFile(path.join(root, "chrome.exe"), "replacement")
    expect(() => loadLinuxBrowserRelease(root, sha)).toThrow()
  } finally {
    if (created) {
      if (path.dirname(root) !== parent || (await fs.realpath(root)) !== root) throw Error("own-cleanup")
      await fs.rm(root, { recursive: true })
    }
    await f.dispose()
  }
})
test("R11 swap=0 in an unrelated file or unapplied configuration cannot establish effective state", () => {
  const base = {
    sourcePath: "C:\\Users\\own\\.wslconfig",
    windowsProfile: "C:\\Users\\own",
    swap: { kind: "disabled" as const },
    active: true,
    swapsText: "Filename Type Size Used Priority\n",
  }
  expect(() => bindEffectiveSwap(base)).not.toThrow()
  expect(() => bindEffectiveSwap({ ...base, sourcePath: "D:\\fake\\.wslconfig" })).toThrow()
  expect(() => bindEffectiveSwap({ ...base, swapsText: base.swapsText + "/dev/sdz partition 1024 0 -2\n" })).toThrow()
})
test("R4/R12 bound previews retain inline fixtures, reuse a lease and revoke every endpoint on dispose", async () => {
  const f = await sessionFixture()
  try {
    const cache = new Map(),
      file = path.join(f.manifest.roots.work, "index.html")
    await fs.writeFile(file, "<style>p{color:red}</style><script>window.own=1</script><p>own</p>")
    const id = await fileIdentity(file),
      source = {
        root: f.manifest.roots.work,
        files: [{ path: "index.html", sha256: id.sha256, size: (await fs.stat(file)).size }],
        buildSha256: "a".repeat(64),
        async stop() {},
      }
    let creates = 0
    const create = async () => {
      creates++
      return startLinuxPreview({
        source,
        policy: { methods: ["GET"], paths: ["/index.html"] },
        guard: async () => {},
        signal: new AbortController().signal,
      })
    }
    const first = await reuseLinuxPreview(cache, "own", "a".repeat(64), create),
      second = await reuseLinuxPreview(cache, "own", "a".repeat(64), create)
    expect(first).toBe(second)
    expect(creates).toBe(1)
    const response = await fetch(first.url + "index.html")
    expect(response.headers.get("content-security-policy")).toContain("script-src 'self' 'unsafe-inline'")
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'")
    for (const lease of cache.values()) await lease.stop()
    await expect(fetch(first.url + "index.html")).rejects.toThrow()
  } finally {
    await f.dispose()
  }
})
test("R13 inherited descendant pipes cannot extend a canceled native operation indefinitely", async () => {
  const f = await sessionFixture(),
    cancel = new AbortController()
  let abortedAt = 0,
    done: () => void = () => {}
  const ended = new Promise<void>((resolve) => {
      done = resolve
    }),
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(r) {
        if (new URL(r.url).pathname === "/started") {
          abortedAt = Date.now()
          cancel.abort()
        } else done()
        return new Response("own")
      },
    })
  try {
    const origin = `http://127.0.0.1:${server.port}`,
      runner = makeProcessRunner({
        executable: process.execPath,
        argvPrefix: ["--no-env-file"],
        cwd: f.root,
        env: { BUN_OPTIONS: "--no-env-file" },
      })
    const child = `await fetch('${origin}/started');setTimeout(()=>process.exit(0),1500)`
    const code = `Bun.spawn([process.execPath,'--no-env-file','-e',${JSON.stringify(child)}],{stdin:'ignore',stdout:'inherit',stderr:'inherit'});setInterval(()=>{},1000)`
    const r = await runner.execute({
      argv: ["-e", code],
      timeoutMs: 5000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      signal: cancel.signal,
    })
    const elapsed = Date.now() - abortedAt
    await new Promise((resolve) => setTimeout(resolve, 1700))
    expect(abortedAt).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(1000)
    expect(r).toMatchObject({ exitCode: 130, cleanupUncertain: true, truncated: true })
  } finally {
    server.stop(true)
    await f.dispose()
  }
})
