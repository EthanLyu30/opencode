import { expect, test } from "bun:test"
import { identity } from "../independent/fixture"
import {
  decodeProductionWorkflowCase,
  openProductionWorkflowHost,
  decodeProductionWorkflowSummary,
  makeProductionGitGuard,
  tryDecodeProductionWorkflowSummary,
  completeProductionCaptureViews,
} from "../../src/sandbox/production-workflow-host"
import { startFixtureCapabilityProvider } from "../../src/sandbox/fixture-provider"
import { sha256Text } from "../../src/hash"
import { sessionFixture } from "./fixture"
import fs from "node:fs/promises"

const image = "own/runtime@sha256:" + "a".repeat(64)
test("visual completion requires all three independently captured viewports on both real preview identities", () => {
  const captures = ["reference", "implementation"].flatMap((previewID) =>
    ["mobile", "tablet", "desktop"].map((viewportID) => ({ previewID, viewportID })),
  )
  expect(completeProductionCaptureViews(captures)).toBe(true)
  expect(completeProductionCaptureViews(captures.slice(0, 5))).toBe(false)
  expect(completeProductionCaptureViews(captures.filter((c) => c.viewportID === "desktop"))).toBe(false)
  expect(completeProductionCaptureViews(captures.slice(0, 3))).toBe(false)
})
test("empty or crashed CLI summaries remain rejected without masking native retirement evidence", () => {
  expect(tryDecodeProductionWorkflowSummary(new Uint8Array())).toBeUndefined()
  expect(tryDecodeProductionWorkflowSummary(Buffer.from("native crash, not JSON"))).toBeUndefined()
  expect(tryDecodeProductionWorkflowSummary(Buffer.from('{"workflow":{"status":"succeeded"}}'))).toBeUndefined()
})
test("native Git guard checks live round and exact pinned files without invoking the unrelated Docker daemon", async () => {
  const f = await sessionFixture()
  try {
    const before = f.calls.length
    const guard = makeProductionGitGuard(f.session, () => [f.cli])
    await guard()
    expect(f.calls.length).toBe(before)
    await fs.appendFile(f.cli.path, "changed")
    await expect(guard()).rejects.toThrow("TASK24_PRODUCTION_GIT_BINDING")
    expect(f.calls.length).toBe(before)
    await expect(makeProductionGitGuard({ ...f.session }, () => [f.cli])()).rejects.toThrow(
      "TASK24_LINUX_SESSION_AUTHORITY",
    )
  } finally {
    await f.dispose()
  }
})
function fixture() {
  const id = identity({ campaignID: "case-a", runID: "case-a", armID: "A" })
  const plan = {
    schemaVersion: 1,
    identity: id,
    image,
    publicImage: image,
    readonlyToolCallID: "ro-write",
    commands: [{ argv: ["bun", "test"], workdir: "/workspace" }],
    previews: [
      {
        entrypoint: "index.html",
        root: "",
        readySelector: "#ready",
        files: [
          { path: "index.html", contentBase64: Buffer.from('<main id="ready">public</main>').toString("base64") },
        ],
      },
    ],
  }
  return {
    plan,
    binding: {
      kind: "visual" as const,
      campaignID: id.campaignID,
      runID: id.runID,
      binarySha256: id.binarySha256,
      profileSha256: id.profileSha256,
      images: [image],
    },
  }
}

test("production case is closed frozen public preparation data, bound to the actual A route, profile, binary and image", () => {
  const f = fixture()
  const value = decodeProductionWorkflowCase(f.plan, f.binding)
  f.plan.previews[0]!.files[0]!.contentBase64 = Buffer.from("changed after decode").toString("base64")
  expect(Buffer.from(value.previews[0]!.files[0]!.contentBase64, "base64").toString()).toBe(
    '<main id="ready">public</main>',
  )
  expect(Object.isFrozen(value)).toBe(true)
  expect(Object.isFrozen(value.previews[0]!.files)).toBe(true)
  for (const binding of [
    { ...f.binding, runID: "other" },
    { ...f.binding, binarySha256: "b".repeat(64) },
    { ...f.binding, profileSha256: "b".repeat(64) },
    { ...f.binding, images: [] },
  ])
    expect(() => decodeProductionWorkflowCase(f.plan, binding)).toThrow("TASK24_PRODUCTION_CASE_BINDING")
})

test("production case freezes only declared public Git states and rejects noncanonical bytes or private paths", () => {
  const f = fixture()
  const gitStates = [[{ path: "index.html", contentBase64: "c2VlZA==" }]]
  const decoded = decodeProductionWorkflowCase({ ...f.plan, gitStates }, f.binding)
  gitStates[0]![0]!.contentBase64 = "Y2hhbmdlZA=="
  expect(decoded.gitStates?.[0]?.[0]?.contentBase64).toBe("c2VlZA==")
  for (const states of [
    [],
    [[{ path: "../private", contentBase64: "eA==" }]],
    [[{ path: ".git/config", contentBase64: "eA==" }]],
    [[{ path: "index.html", contentBase64: "eA==junk" }]],
  ])
    expect(() => decodeProductionWorkflowCase({ ...f.plan, gitStates: states }, f.binding)).toThrow()
})

test("production case refuses arbitrary transport, mutable mounts, ambiguous bytes and missing role coverage before host startup", () => {
  const f = fixture()
  for (const patch of [
    { environment: { API_KEY: "never accepted" } },
    { engine: "C:\\docker.exe" },
    {
      commands: [{ argv: ["bun", "test"], workdir: "/workspace", workspace: { source: "D:\\other", readonly: false } }],
    },
    { previews: [{ ...f.plan.previews[0], files: [{ path: "../private", contentBase64: "eA==" }] }] },
    { previews: [{ ...f.plan.previews[0], files: [{ path: "index.html", contentBase64: "eA==junk" }] }] },
    { previews: [] },
    { publicImage: "own/runtime@sha256:" + "b".repeat(64) },
    { commands: [] },
  ])
    expect(() => decodeProductionWorkflowCase({ ...f.plan, ...patch }, f.binding)).toThrow()
  expect(() => decodeProductionWorkflowCase(f.plan, { ...f.binding, kind: "coding" })).toThrow(
    "TASK24_PRODUCTION_CASE_COVERAGE",
  )
  expect(decodeProductionWorkflowCase({ ...f.plan, previews: [] }, { ...f.binding, kind: "coding" }).previews).toEqual(
    [],
  )
})

test("host composition refuses missing, cloned or cross-round providers before touching any host paths", async () => {
  const provider = startFixtureCapabilityProvider([{ protocol: "chat_completions", model: "kimi-k3", events: [] }])
  try {
    const request = {
      launch: {
        snapshot: {
          armID: "A",
          mode: "workflow",
          brokerOrigin: provider.origin,
          brokerGrantSha256: sha256Text(provider.grant),
        },
      },
      fixture: provider,
    }
    await expect(openProductionWorkflowHost({ request: { ...request, fixture: undefined } } as never)).rejects.toThrow(
      "TASK24_PRODUCTION_CASE_PROVIDER",
    )
    await expect(
      openProductionWorkflowHost({ request: { ...request, fixture: { ...provider } } } as never),
    ).rejects.toThrow("TASK24_FIXTURE_PROVIDER_AUTHORITY")
    await expect(
      openProductionWorkflowHost({
        request: {
          ...request,
          launch: { snapshot: { ...request.launch.snapshot, brokerOrigin: "http://127.0.0.1:23456" } },
        },
      } as never),
    ).rejects.toThrow("TASK24_PRODUCTION_CASE_PROVIDER")
    expect(provider.observation()).toEqual({ calls: 0, rejected: 0, complete: false })
  } finally {
    await provider.stop()
  }
})

test("production composition accepts the genuine CLI's sanitized summary without inventing artifact hashes", () => {
  const summary = {
    workflow: { id: "wfl_own", status: "succeeded" },
    response: { workflowID: "wfl_own", status: "completed" },
    artifacts: [{ kind: "workflow.delivery", mime: "application/json", size: 12, timeCreated: 1 }],
  }
  expect(decodeProductionWorkflowSummary(Buffer.from(JSON.stringify(summary)))).toEqual({
    workflow: summary.workflow,
    response: summary.response,
    artifacts: [{ kind: "workflow.delivery" }],
  })
  expect(() => decodeProductionWorkflowSummary(Buffer.from('{"workflow":{"status":"succeeded"}}'))).toThrow()
})
