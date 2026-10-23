import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { loadBrowserRelease } from "../../src/evaluator/browser-runtime"
import { buildBrowserProtocolHelper } from "../../src/sandbox/public-mcp-build"
import { createWindowsBrowserDispatch } from "../../src/sandbox/host-isolation/windows-browser-dispatch"
import { fileIdentity } from "../../src/sandbox/storage"
import { canonicalJson } from "../../src/campaign/canonical"
import { identity } from "../independent/fixture"

test.skipIf(process.platform !== "win32" || process.env.TASK24_WINDOWS_BROWSER_LIVE !== "1")(
  "real admission ignores candidate page API overrides and probes only the controller document",
  async () => {
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "browser-admission-live-"))
    const temp = path.join(root, "temp"),
      evidence = path.join(root, "evidence")
    let preview: ReturnType<typeof Bun.serve> | undefined,
      safe = true,
      hits = 0
    try {
      await fs.mkdir(temp)
      await fs.mkdir(evidence)
      const releaseRoot = process.env.TASK24_WINDOWS_BROWSER_RELEASE!
      const release = loadBrowserRelease(releaseRoot, { readOnly: true })
      const helper = await buildBrowserProtocolHelper({ outputRoot: path.join(root, "helper") })
      const previewID = "b".repeat(64),
        id = identity()
      preview = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === `/${previewID}/probe.js`)
            return new Response("export const answer=42", { headers: { "content-type": "application/javascript" } })
          if (url.pathname !== `/${previewID}/index.html`) return new Response(null, { status: 404 })
          hits++
          return new Response(
            `<!doctype html><html><body><h1>Candidate</h1><script>document.addEventListener=()=>{throw Error('candidate override')};window.fetch=()=>Promise.resolve(new Response('forged'))</script></body></html>`,
            {
              headers: {
                "content-type": "text/html",
                "content-security-policy": "default-src 'self';script-src 'self' 'unsafe-inline';frame-src 'none'",
              },
            },
          )
        },
      })
      const base = `http://127.0.0.1:${preview.port}/${previewID}/`
      const dispatch = await createWindowsBrowserDispatch(
        {
          root: temp,
          evidenceRoot: evidence,
          releaseRoot,
          helper: helper.executable,
          manifestSha256: "d".repeat(64),
          allowedEvidenceRoots: [evidence],
        },
        async () => {},
      )
      const data = {
        identity: id,
        candidate: {
          archiveFile: path.join(root, "own-unused-archive"),
          archiveSha256: "e".repeat(64),
          candidateSha256: id.candidateSha256,
          configSha256: "f".repeat(64),
        },
        profileSha256: id.profileSha256,
        timeoutMs: 30000,
        module: "probe.js",
        inputs: [{ id: "answer" }],
        operations: [{ id: "answer", steps: [{ kind: "get", target: "answer", args: [] }] }],
      }
      const result = await dispatch({
        executable: release.nodeExecutable,
        helper: helper.executable,
        browser: await fileIdentity(release.browserExecutable),
        node: await fileIdentity(release.nodeExecutable),
        cwd: temp,
        env: {},
        manifestSha256: "d".repeat(64),
        previewID,
        previewURL: base,
        chromiumSandboxRequired: true,
        denyNonPreviewNetwork: true,
        invocation: {
          argv: [helper.executable.path],
          stdin: Buffer.from(
            canonicalJson({
              schemaVersion: 2,
              operation: "probe",
              identity: id,
              base,
              previewID,
              paths: ["/index.html", "/probe.js"],
              browser: release.browserExecutable,
              temp,
              evidence,
              plans: [],
              data,
            }),
          ),
          timeoutMs: 30000,
          maxStdoutBytes: 2097152,
          maxStderrBytes: 65536,
          signal: new AbortController().signal,
        },
      })
      expect(result.execution.exitCode).toBe(0)
      expect(JSON.parse(Buffer.from(result.execution.stdout).toString("utf8")).result).toEqual({
        cases: [{ id: "answer", outputs: [{ kind: "value", value: 42 }] }],
      })
      expect(hits).toBe(1)
      expect(result.observation).toMatchObject({
        nonPreviewNetworkBlocked: true,
        deniedCanaryAttempts: 2,
        canaryHits: 0,
      })
      await fs.writeFile(
        path.join(process.env.TMPDIR!, "browser-admission-" + crypto.randomUUID() + "-evidence.json"),
        canonicalJson({
          scope: "controller-owned admission and adversarial page probe; not full engine readiness",
          observation: result.observation,
          providerApiCalls: 0,
        }),
        { flag: "wx" },
      )
    } catch (cause) {
      if (cause && typeof cause === "object" && Reflect.get(cause, "cleanupUncertain") === true) safe = false
      throw cause
    } finally {
      await preview?.stop(false)
      if (safe) await fs.rm(root, { recursive: true })
    }
  },
  180000,
)
