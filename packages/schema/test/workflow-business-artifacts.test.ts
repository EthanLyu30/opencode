import { describe, expect, test } from "bun:test"
import { WorkflowDecompositionArtifact } from "../src/workflow-decomposition-artifact"
import { WorkflowDeliveryArtifact } from "../src/workflow-delivery-artifact"
import { WorkflowImplementationArtifact } from "../src/workflow-implementation-artifact"
import { WorkflowTestArtifact } from "../src/workflow-test-artifact"
import { Schema } from "effect"

const hash = "a".repeat(64)
const workflowID = "wfl_business_artifacts"

const plan = {
  schemaVersion: 1,
  workflowID,
  revision: 2,
  snapshotRef: "snapshot:design-r2",
  acceptanceCriteria: ["The release page renders the approved design"],
  tasks: [
    {
      id: "implement-release-page",
      title: "Implement the release page",
      description: "Build the approved responsive release page.",
      acceptanceCriteria: ["The primary action is visible at desktop width"],
      dependsOn: [],
      files: ["src/app.ts"],
    },
  ],
}

const manifest = {
  schemaVersion: 1,
  workflowID,
  revision: 2,
  snapshotRef: "snapshot:design-r2",
  workspaceSha256: hash,
  changes: [{ path: "src/app.ts", beforeSha256: "b".repeat(64), afterSha256: "c".repeat(64) }],
}

const result = {
  schemaVersion: 1,
  workflowID,
  revision: 2,
  implementationSha256: hash,
  verdict: "pass" as const,
  tests: [
    {
      name: "unit",
      argv: ["bun", "test"],
      cwd: ".",
      exitCode: 0,
      log: {
        uri: `workflow://artifact/${workflowID}/test-log/${"b".repeat(64)}.txt`,
        sha256: "b".repeat(64),
        size: 120,
      },
    },
  ],
  preview: {
    workflowID,
    revision: 2,
    implementationSha256: hash,
    uri: `workflow://preview/${workflowID}/r2/${hash}`,
  },
}

describe("workflow business artifact schemas", () => {
  test("decodes strict decomposition, implementation, test, and delivery values", () => {
    expect(Schema.decodeUnknownSync(WorkflowDecompositionArtifact.Plan)(plan as unknown) as unknown).toEqual(plan)
    expect(Schema.decodeUnknownSync(WorkflowImplementationArtifact.Manifest)(manifest).changes[0]).toEqual({
      path: "src/app.ts",
      beforeSha256: "b".repeat(64),
      afterSha256: "c".repeat(64),
    })
    expect(Schema.decodeUnknownSync(WorkflowTestArtifact.Result)(result as unknown) as unknown).toEqual(result)
    expect(
      Schema.decodeUnknownSync(WorkflowDeliveryArtifact.Delivery)({
        schemaVersion: 1,
        workflowID,
        revision: 2,
        implementationSha256: hash,
        testSha256: "b".repeat(64),
        visualReviewSha256: "c".repeat(64),
        summary: "Release page implemented and verified.",
      }).summary,
    ).toBe("Release page implemented and verified.")
  })

  test("rejects empty acceptance criteria and unknown fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkflowDecompositionArtifact.Plan)({ ...plan, acceptanceCriteria: [] }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowDecompositionArtifact.Plan)({ ...plan, commentary: "trust me" }),
    ).toThrow()
  })

  test("allows separate decomposition tasks to reference the same exact path", () => {
    const tasks = [plan.tasks[0], { ...plan.tasks[0], id: "verify-release-page", files: ["src/app.ts"] }]
    expect(() => Schema.decodeUnknownSync(WorkflowDecompositionArtifact.Plan)({ ...plan, tasks })).not.toThrow()
  })

  test("rejects case-insensitive path aliases across decomposition tasks", () => {
    const tasks = [
      { ...plan.tasks[0], files: ["src/App.ts"] },
      { ...plan.tasks[0], id: "verify-release-page", files: ["src/app.ts"] },
    ]
    expect(() => Schema.decodeUnknownSync(WorkflowDecompositionArtifact.Plan)({ ...plan, tasks })).toThrow()
  })

  test("rejects file-directory aliases across decomposition tasks", () => {
    const tasks = [
      { ...plan.tasks[0], files: ["src/app"] },
      { ...plan.tasks[0], id: "verify-release-page", files: ["src/app/index.ts"] },
    ]
    expect(() => Schema.decodeUnknownSync(WorkflowDecompositionArtifact.Plan)({ ...plan, tasks })).toThrow()
  })

  test("rejects traversal, absolute, device, case-alias, and topology-conflicting change paths", () => {
    for (const path of ["../app.ts", "/src/app.ts", "C:/src/app.ts", "src/CON.ts", "src\\app.ts"]) {
      expect(() =>
        Schema.decodeUnknownSync(WorkflowImplementationArtifact.Manifest)({
          ...manifest,
          changes: [{ path, afterSha256: hash }],
        }),
      ).toThrow()
    }
    for (const changes of [
      [
        { path: "src/App.ts", afterSha256: hash },
        { path: "src/app.ts", afterSha256: hash },
      ],
      [
        { path: "src/app", afterSha256: hash },
        { path: "src/app/index.ts", afterSha256: hash },
      ],
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(WorkflowImplementationArtifact.Manifest)({ ...manifest, changes }),
      ).toThrow()
    }
  })

  test("rejects prose-only and empty implementation manifests", () => {
    expect(() => Schema.decodeUnknownSync(WorkflowImplementationArtifact.Manifest)("I changed src/app.ts")).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowImplementationArtifact.Manifest)({ ...manifest, changes: [] }),
    ).toThrow()
  })

  test("requires argv records, bounded referenced logs, and current preview identity", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkflowTestArtifact.Result)({
        ...result,
        tests: [{ ...result.tests[0], argv: "bun test" }],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowTestArtifact.Result)({
        ...result,
        tests: [{ ...result.tests[0], log: { ...result.tests[0].log, size: WorkflowTestArtifact.MAX_LOG_BYTES + 1 } }],
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowTestArtifact.Result)({
        ...result,
        preview: { ...result.preview, revision: 1 },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(WorkflowTestArtifact.Result)({
        ...result,
        tests: [{ ...result.tests[0], output: "x".repeat(100_000) }],
      }),
    ).toThrow()
  })
})
