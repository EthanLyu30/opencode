import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { loadBrowserRelease } from "../../src/evaluator/browser-runtime"
import { buildBrowserProtocolHelper } from "../../src/sandbox/public-mcp-build"
import { runWindowsBrowserProtocol } from "../../src/sandbox/host-isolation/windows"
import { canonicalJson } from "../../src/campaign/canonical"
import { createWindowsBrowserDispatch } from "../../src/sandbox/host-isolation/windows-browser-dispatch"
import { fileIdentity } from "../../src/sandbox/storage"
import { verifyEvidenceFile } from "../../src/evaluator/evidence"
import { identity } from "../independent/fixture"

const live = process.platform === "win32" && process.env.TASK24_WINDOWS_BROWSER_LIVE === "1"
test.skipIf(!live)(
  "real production protocol captures three fixed viewports and denies non-preview browser access",
  async () => {
    const id = identity()
    const root = await fs.mkdtemp(path.join(process.env.TMPDIR!, "browser-production-live-"))
    const temp = path.join(root, "temp"),
      evidence = path.join(root, "evidence")
    await fs.mkdir(temp)
    await fs.mkdir(evidence)
    const releaseRoot = process.env.TASK24_WINDOWS_BROWSER_RELEASE!
    const release = loadBrowserRelease(releaseRoot, { readOnly: true })
    const helper = await buildBrowserProtocolHelper({ outputRoot: path.join(root, "helper") })
    const previewID = "b".repeat(64),
      canaryID = "c".repeat(64)
    let canaryHits = 0,
      previewHits = 0,
      safe = true
    const canary = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        canaryHits++
        return new Response("owned canary")
      },
    })
    const preview = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== "/" + previewID + "/index.html")
          return new Response(null, { status: 404 })
        previewHits++
        return new Response(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Production browser</title></head><body><h1>Real protocol</h1><button data-task24-interaction="primary" onclick="document.querySelector('output').textContent=String(++window.count)">Run</button><output>0</output><script>window.count=0</script></body></html>`,
          {
            headers: {
              "content-type": "text/html",
              "content-security-policy":
                "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'none'; object-src 'none'",
            },
          },
        )
      },
    })
    const base = `http://127.0.0.1:${preview.port}/${previewID}/`
    const canaryURL = `http://127.0.0.1:${canary.port}/${canaryID}`
    const file = path.join(root, "private-canary.txt")
    await fs.writeFile(file, "OWN_PRIVATE_CANARY", { flag: "wx" })
    expect(await (await fetch(canaryURL)).text()).toBe("owned canary")
    canaryHits = 0
    const records = []
    try {
      for (const [viewportID, width, height] of [
        ["mobile", 390, 844],
        ["tablet", 768, 1024],
        ["desktop", 1440, 900],
      ] as const) {
        const frame = {
          schemaVersion: 2,
          operation: "capture",
          identity: id,
          base,
          previewID,
          paths: ["/index.html"],
          browser: release.browserExecutable,
          temp,
          evidence,
          plans: [{ kind: "dom", selector: "h1" }],
          data: {
            runID: id.runID,
            previewID,
            previewURL: base + "index.html",
            viewportID,
            readySelector: "body",
            interactionScriptID: "primary-click",
            timeoutMs: 30000,
          },
        }
        const bytes = Buffer.from(canonicalJson(frame))
        safe = false
        const observed = await runWindowsBrowserProtocol({
          root: temp,
          releaseRoot,
          helper: helper.executable,
          tempRoot: temp,
          evidenceRoot: evidence,
          previewID,
          previewURL: base,
          invocation: {
            argv: [helper.executable.path],
            stdin: bytes,
            timeoutMs: 30000,
            maxStdoutBytes: 2097152,
            maxStderrBytes: 65536,
            signal: new AbortController().signal,
          },
        })
        safe = true
        expect({
          started: observed.execution.started,
          exitCode: observed.execution.exitCode,
          truncated: observed.execution.truncated,
          diagnostic: Buffer.from(observed.execution.stderr).toString("utf8"),
        }).toEqual({ started: true, exitCode: 0, truncated: false, diagnostic: "" })
        const value = JSON.parse(Buffer.from(observed.execution.stdout).toString("utf8"))
        expect(value.identity).toEqual(id)
        expect(value.operation).toBe("capture")
        expect(value.observations.dom).toEqual([{ selector: "h1", count: 1, text: "Real protocol", visible: true }])
        const png = await fs.readFile(value.result.screenshot)
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([width, height])
        const capture = JSON.parse(await fs.readFile(value.result.evidence, "utf8"))
        expect(capture.keyboard).toMatchObject({ tabFocusMoved: true, enterActivated: true, spaceActivated: true })
        expect(observed.containment.renderers.length).toBeGreaterThan(0)
        expect(observed.containment.metadataRegistrations).toHaveLength(6)
        records.push({ viewportID, screenshotSha256: value.result.screenshotSha256, containment: observed.containment })
      }
      const admissionBytes = Buffer.from(
        canonicalJson({
          schemaVersion: 2,
          operation: "admission",
          identity: id,
          base,
          previewID,
          paths: ["/index.html"],
          browser: release.browserExecutable,
          temp,
          evidence,
          plans: [],
          data: { canaryURL, fileURL: pathToFileURL(file).href },
        }),
      )
      safe = false
      const admitted = await runWindowsBrowserProtocol({
        root: temp,
        releaseRoot,
        helper: helper.executable,
        tempRoot: temp,
        evidenceRoot: evidence,
        previewID,
        previewURL: base,
        invocation: {
          argv: [helper.executable.path],
          stdin: admissionBytes,
          timeoutMs: 30000,
          maxStdoutBytes: 2097152,
          maxStderrBytes: 65536,
          signal: new AbortController().signal,
        },
      })
      safe = true
      expect(admitted.execution).toMatchObject({ started: true, exitCode: 0, truncated: false })
      const admission = JSON.parse(Buffer.from(admitted.execution.stdout).toString("utf8"))
      expect(admission.result).toMatchObject({
        networkBlocked: true,
        websocketBlocked: true,
        fileBlocked: true,
        dataBlocked: true,
        crossCapabilityBlocked: true,
      })
      expect(canaryHits).toBe(0)
      expect(previewHits).toBeGreaterThanOrEqual(4)
      expect(await fs.readFile(file, "utf8")).toBe("OWN_PRIVATE_CANARY")
      let guards = 0
      const dispatch = await createWindowsBrowserDispatch(
        {
          root: temp,
          evidenceRoot: evidence,
          releaseRoot,
          helper: helper.executable,
          manifestSha256: "d".repeat(64),
          allowedEvidenceRoots: [evidence],
        },
        async () => {
          guards++
        },
      )
      const request = {
        executable: release.nodeExecutable,
        helper: helper.executable,
        browser: await fileIdentity(release.browserExecutable),
        node: await fileIdentity(release.nodeExecutable),
        cwd: temp,
        env: {},
        manifestSha256: "d".repeat(64),
        previewID,
        previewURL: base,
        chromiumSandboxRequired: true as const,
        denyNonPreviewNetwork: true as const,
        invocation: {
          argv: [helper.executable.path],
          stdin: admissionBytes,
          timeoutMs: 30000,
          maxStdoutBytes: 2097152,
          maxStderrBytes: 65536,
          signal: new AbortController().signal,
        },
      }
      await expect(dispatch({ ...request, manifestSha256: "e".repeat(64) })).rejects.toThrow(
        "TASK24_BROWSER_DISPATCH_BINDING",
      )
      safe = false
      const wired = await dispatch(request)
      safe = true
      expect(wired.execution.exitCode).toBe(0)
      const observation = wired.observation as {
        ended: boolean
        sandboxEnabled: boolean
        canaryHits: number
        deniedCanaryAttempts: number
        evidence: Parameters<typeof verifyEvidenceFile>[1][]
      }
      expect(observation).toMatchObject({ ended: true, sandboxEnabled: true, canaryHits: 0, deniedCanaryAttempts: 2 })
      expect(guards).toBeGreaterThanOrEqual(4)
      expect(observation.evidence).toHaveLength(1)
      for (const ref of observation.evidence) verifyEvidenceFile(evidence, ref)
      await fs.writeFile(
        path.join(process.env.TMPDIR!, "browser-production-dispatch-" + crypto.randomUUID() + "-evidence.json"),
        canonicalJson({
          scope: "real protocol v2 browser plus production dispatch; not full engine readiness",
          records,
          admission: admission.result,
          observation,
          canaryHits,
          providerApiCalls: 0,
          deploymentReplaced: false,
        }),
        { flag: "wx" },
      )
    } finally {
      await preview.stop(false)
      await canary.stop(false)
      if (safe) await fs.rm(root, { recursive: true })
    }
  },
  300000,
)
