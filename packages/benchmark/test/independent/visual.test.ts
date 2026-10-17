import { expect, test } from "bun:test"
import { evaluateVisual } from "../../src/evaluator/independent/visual"
import { evaluationFactsFixture, identity } from "./fixture"
import { independentFixture, candidate } from "./fixture"
import fs from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"
import { FIXED_VIEWPORTS } from "../../src/evaluator/browser-protocol"
import { decodeEvaluationOracle, decodeTaskExecutionProfile } from "../../src/corpus/evaluation-profile"
import { fixtureObservation } from "../../src/evaluator/independent/host"
import { sha256Bytes, sha256Text } from "../../src/hash"

test("reject stale build, wrong preview entry, browser/font identity before capture", async () => {
  const f = evaluationFactsFixture()
  let calls = 0
  const browser = {
    capture: async () => {
      calls++
      throw Error("must not capture")
    },
  }
  for (const reason of ["candidate", "entry", "font", "browser"]) {
    const input = {
      identity: identity(),
      profile: { preview: { entry: "index.html", interaction: "none", timeoutMs: 30000, requiredCapabilities: [] } },
      oracle: { visual: { browserSha256: "b".repeat(64), fontSha256: "f".repeat(64) } },
      build: f.build.status === "passed" ? f.build.manifest : null,
      preview: {
        kind: "ok",
        handle: "http://127.0.0.1:1234",
        buildSha256: "x".repeat(64),
        fontSha256: "bad",
        browserSha256: "bad",
      },
      browser: {
        runtime: browser,
        browserSha256: "b".repeat(64),
        fontSha256: "f".repeat(64),
        referenceRoot: "unused",
        evidenceRoot: "unused",
      },
    }
    // Adversarial boundary input intentionally bypasses compile-time types.
    await expect(evaluateVisual(input as never)).rejects.toThrow()
  }
  expect(calls).toBe(0)
})

test("three actual fixture PNG/DOM captures use fixed viewport sizes and detect runtime faults", async () => {
  const f = await independentFixture("visual-real")
  try {
    await fs.mkdir(f.resultRoot)
    await fs.mkdir(path.join(f.bundleRoot, "private"))
    const references: Record<string, { path: string; sha256: string; size: number }> = {},
      domReferences: typeof references = {},
      privateFiles = []
    const dom = [
      {
        index: 0,
        tag: "main",
        id: "app",
        role: "main",
        testID: "main",
        box: { x: 10, y: 20, width: 100, height: 80 },
        style: { color: "rgb(0, 0, 0)", "font-size": "16px", "font-family": "Inter" },
      },
    ]
    for (const id of ["mobile", "tablet", "desktop"] as const) {
      const png = await sharp({ create: { ...FIXED_VIEWPORTS[id], channels: 4, background: "#336699" } })
        .png()
        .toBuffer()
      for (const [target, bytes, ext] of [
        [references, png, "png"],
        [domReferences, Buffer.from(JSON.stringify(dom)), "json"],
      ] as const) {
        const file = { path: `private/${id}.${ext}`, sha256: sha256Bytes(bytes), size: bytes.length }
        target[id] = file
        privateFiles.push(file)
        await fs.writeFile(path.join(f.bundleRoot, file.path), bytes)
      }
    }
    const browserSha256 = sha256Text("browser"),
      fontSha256 = sha256Text("font")
    const profile = decodeTaskExecutionProfile({
      ...f.profile,
      kind: "primary",
      stratum: "private",
      executionKind: "visual-build",
      preview: { entry: "index.html", kind: "html", requiredCapabilities: [], interaction: "none", timeoutMs: 30000 },
    })
    const oracle = decodeEvaluationOracle({
      ...f.oracle,
      kind: "primary",
      privateFiles,
      visual: { references, domReferences, masks: [], tolerance: 0, browserSha256, fontSha256 },
    })
    const facts = evaluationFactsFixture(),
      build = facts.build.status === "passed" ? facts.build.manifest : undefined!
    const request = { identity: identity(), candidate, profileSha256: identity().profileSha256, timeoutMs: 30000 }
    const preview = fixtureObservation(request, {
      kind: "ok",
      handle: "http://127.0.0.1:1234",
      buildSha256: build.buildSha256,
      browserSha256,
      fontSha256,
    })
    let captures = 0
    const browser = {
      browserSha256,
      fontSha256,
      referenceRoot: f.bundleRoot,
      evidenceRoot: f.resultRoot,
      runtime: {
        capture: async (input: { viewportID: keyof typeof FIXED_VIEWPORTS }) => {
          captures++
          const id = input.viewportID,
            root = path.join(f.resultRoot, id)
          await fs.mkdir(root)
          const screenshot = path.join(root, "screenshot.png"),
            evidence = path.join(root, "capture.json")
          const bytes = await fs.readFile(path.join(f.bundleRoot, references[id]!.path))
          await fs.writeFile(screenshot, bytes)
          const json = JSON.stringify({
            runID: identity().runID,
            previewID: identity().attemptID,
            viewportID: id,
            screenshotSha256: sha256Bytes(bytes),
            dom,
            consoleErrors: [],
            pageErrors: [],
            keyboard: { tabFocusMoved: true, focusVisible: true, enterActivated: true, spaceActivated: true },
            axe: { violations: [] },
          })
          await fs.writeFile(evidence, json)
          return {
            root,
            screenshot,
            evidence,
            screenshotSha256: sha256Bytes(bytes),
            evidenceSha256: sha256Text(json),
            screenshotBytes: bytes.length,
          }
        },
      },
    }
    const v = await evaluateVisual({ identity: identity(), profile, oracle, build, preview, browser })
    expect(captures).toBe(3)
    expect(v.result.composite).toBe(100)
    expect(v.accessibility.requiredPassed).toBe(true)
    for (const change of [{ candidateSha256: "a".repeat(64) }, { files: [] as never[] }])
      await expect(
        evaluateVisual({ identity: identity(), profile, oracle, build: { ...build, ...change }, preview, browser }),
      ).rejects.toThrow()
    await expect(
      evaluateVisual({
        identity: identity(),
        profile,
        oracle,
        build,
        preview,
        browser: { ...browser, fontSha256: "a".repeat(64) },
      }),
    ).rejects.toThrow("TASK24_VISUAL_RUNTIME_INVALID")
    await expect(
      evaluateVisual({
        identity: identity(),
        profile,
        oracle,
        build,
        preview,
        browser: {
          ...browser,
          runtime: {
            capture: async () => {
              throw Error("browser crashed")
            },
          },
        },
      }),
    ).rejects.toThrow("browser crashed")
  } finally {
    await f.dispose()
  }
})
