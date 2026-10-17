import fs from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"
import { canonicalJson } from "../../campaign/canonical"
import { directRoot, ordinaryFiles } from "../../corpus/evaluation-bundle"
import {
  freeze,
  type EvaluationIdentityV2,
  type EvaluationOracle,
  type TaskExecutionProfile,
} from "../../corpus/evaluation-profile"
import type { FileEntry } from "../../corpus/manifest"
import { sha256Bytes } from "../../hash"
import { scoreAccessibility, type AccessibilityResult } from "../accessibility"
import { FIXED_VIEWPORTS } from "../browser-protocol"
import type { BrowserRuntime } from "../browser-runtime"
import { bindEvidenceFile, type EvidenceReference } from "../evidence"
import { aggregateVisualViewports, evaluateVisualViewport, type VisualResult } from "../visual"
import type { BuildManifest, PreviewObservation } from "./host"
import { requireFixtureObservation } from "./host"

export type IndependentBrowser = Readonly<{
  runtime: Pick<BrowserRuntime, "capture">
  referenceRoot: string
  evidenceRoot: string
  browserSha256: string
  fontSha256: string
}>
export type VisualFacts = Readonly<{
  identity: EvaluationIdentityV2
  buildSha256: string
  browserSha256: string
  fontSha256: string
  captures: readonly string[]
  result: VisualResult
  accessibility: AccessibilityResult
  evidence: readonly EvidenceReference[]
}>
export async function evaluateVisual(input: {
  identity: EvaluationIdentityV2
  profile: TaskExecutionProfile
  oracle: EvaluationOracle
  build: BuildManifest
  preview: PreviewObservation
  browser: IndependentBrowser
}): Promise<VisualFacts> {
  const { identity, profile, oracle, build, preview, browser } = input
  requireFixtureObservation(preview)
  if (
    !profile.preview ||
    !oracle.visual ||
    preview.kind !== "ok" ||
    !build.files.some((f) => f.path === profile.preview!.entry) ||
    build.candidateSha256 !== identity.candidateSha256 ||
    preview.buildSha256 !== build.buildSha256 ||
    canonicalJson(preview.identity) !== canonicalJson(identity) ||
    preview.candidate.configSha256 !== build.configSha256
  )
    throw new TypeError("TASK24_VISUAL_BUILD_INVALID")
  if (
    browser.browserSha256 !== oracle.visual.browserSha256 ||
    browser.fontSha256 !== oracle.visual.fontSha256 ||
    preview.browserSha256 !== browser.browserSha256 ||
    preview.fontSha256 !== browser.fontSha256
  )
    throw new TypeError("TASK24_VISUAL_RUNTIME_INVALID")
  const url = new URL(preview.handle)
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password)
    throw new TypeError("TASK24_PREVIEW_HANDLE_INVALID")
  await directRoot(browser.referenceRoot)
  await directRoot(browser.evidenceRoot)
  const referenceFiles = await ordinaryFiles(browser.referenceRoot)
  async function readReference(file: FileEntry) {
    if (!referenceFiles.some((f) => f.path === file.path && f.sha256 === file.sha256 && f.size === file.size))
      throw new TypeError("TASK24_VISUAL_REFERENCE_INVALID")
    const bytes = await fs.readFile(path.join(browser.referenceRoot, file.path))
    if (sha256Bytes(bytes) !== file.sha256) throw new TypeError("TASK24_VISUAL_REFERENCE_DRIFT")
    return bytes
  }
  const viewports = [],
    captures: string[] = [],
    evidence: EvidenceReference[] = []
  const keyboard: { id: string; required: boolean; passed: boolean }[] = [],
    responsive: { id: string; required: boolean; passed: boolean }[] = []
  const violations: Parameters<typeof scoreAccessibility>[0]["axeViolations"][number][] = []
  let overflowPassed = true,
    clippingPassed = true
  for (const id of ["mobile", "tablet", "desktop"] as const) {
    const viewport = { id, ...FIXED_VIEWPORTS[id] }
    const captured = await browser.runtime.capture({
      runID: identity.runID,
      previewID: identity.attemptID,
      previewURL: preview.handle,
      viewportID: viewport.id,
      readySelector: "body",
      interactionScriptID: profile.preview.interaction,
      timeoutMs: profile.preview.timeoutMs,
      signal: new AbortController().signal,
    })
    await directRoot(captured.root)
    const pngRef = bindEvidenceFile(browser.evidenceRoot, captured.screenshot, "screenshot"),
      jsonRef = bindEvidenceFile(browser.evidenceRoot, captured.evidence, "browser-capture")
    if (
      pngRef.sha256 !== captured.screenshotSha256 ||
      jsonRef.sha256 !== captured.evidenceSha256 ||
      pngRef.bytes !== captured.screenshotBytes
    )
      throw new TypeError("TASK24_VISUAL_CAPTURE_INVALID")
    const data = JSON.parse(await fs.readFile(captured.evidence, "utf8")) as Record<string, unknown>
    if (
      data.runID !== identity.runID ||
      data.previewID !== identity.attemptID ||
      data.viewportID !== viewport.id ||
      data.screenshotSha256 !== pngRef.sha256 ||
      !Array.isArray(data.dom) ||
      !data.keyboard ||
      !data.axe ||
      !Array.isArray(data.consoleErrors) ||
      !Array.isArray(data.pageErrors)
    )
      throw new TypeError("TASK24_VISUAL_CAPTURE_INVALID")
    const kb = data.keyboard as Record<string, unknown>,
      axe = data.axe as { violations: Parameters<typeof scoreAccessibility>[0]["axeViolations"] }
    if (
      !Array.isArray(axe.violations) ||
      !["tabFocusMoved", "focusVisible", "enterActivated", "spaceActivated"].every((k) => typeof kb[k] === "boolean")
    )
      throw new TypeError("TASK24_VISUAL_CAPTURE_INVALID")
    const healthy = data.consoleErrors.length === 0 && data.pageErrors.length === 0
    for (const k of ["tabFocusMoved", "focusVisible", "enterActivated", "spaceActivated"])
      keyboard.push({ id: `${viewport.id}-${k.toLowerCase()}`, required: true, passed: kb[k] === true })
    const state = data.stateProbe as { interactionAttempted?: unknown; visible?: unknown } | undefined
    const interaction =
      profile.preview.interaction === "none"
        ? healthy
        : healthy && state?.interactionAttempted === true && state.visible === true
    responsive.push({ id: `${viewport.id}-interaction`, required: true, passed: interaction })
    violations.push(...axe.violations)
    for (const raw of data.dom) {
      const box = (raw as { box?: { x: number; y: number; width: number; height: number } }).box
      if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite))
        throw new TypeError("TASK24_VISUAL_DOM_INVALID")
      if (box.x < 0 || box.x + box.width > viewport.width) overflowPassed = false
      if (box.width < 0 || box.height < 0) clippingPassed = false
    }
    const png = await fs.readFile(captured.screenshot),
      reference = await readReference(oracle.visual.references[viewport.id])
    const dimensions = await sharp(png).metadata()
    if (dimensions.width !== viewport.width || dimensions.height !== viewport.height)
      throw new TypeError("TASK24_VISUAL_DIMENSIONS_INVALID")
    const referenceDom: unknown = JSON.parse(
      (await readReference(oracle.visual.domReferences[viewport.id])).toString("utf8"),
    )
    if (!Array.isArray(referenceDom)) throw new TypeError("TASK24_VISUAL_REFERENCE_INVALID")
    const refs = [pngRef, jsonRef]
    viewports.push(
      await evaluateVisualViewport({
        viewportID: viewport.id,
        referencePng: reference,
        candidatePng: png,
        referenceDom,
        candidateDom: data.dom,
        interactionCheckpoints: [{ id: "health-and-interaction", passed: interaction }],
        masks: oracle.visual.masks,
        evidence: refs,
      }),
    )
    captures.push(viewport.id)
    evidence.push(...refs)
  }
  return freeze({
    identity,
    buildSha256: build.buildSha256,
    browserSha256: browser.browserSha256,
    fontSha256: browser.fontSha256,
    captures,
    result: aggregateVisualViewports(viewports),
    accessibility: scoreAccessibility({
      axeViolations: violations,
      keyboardCheckpoints: keyboard,
      responsiveCheckpoints: responsive,
      overflowPassed,
      clippingPassed,
      evidence,
    }),
    evidence,
  })
}
