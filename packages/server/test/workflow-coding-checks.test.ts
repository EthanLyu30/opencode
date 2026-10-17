import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CodingJUnit } from "../src/workflow/coding-junit"
import { CodingCheckLauncher } from "../src/workflow/coding-check-launcher"
import { CodingChecksServer } from "../src/workflow/coding-checks"
import { CodingHostPlan } from "@opencode-ai/core/workflow/coding/host-plan"
import { CodingArtifacts } from "@opencode-ai/core/workflow/coding/artifacts"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { WorkflowWorkspaceMaterialization } from "@opencode-ai/core/workflow/workspace-materialization"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { codingFixture } from "../../core/test/fixtures/workflow-coding"

const report = (cases: string, tests = 1, failures = 0, skipped = 0) =>
  `<?xml version="1.0"?><testsuites tests="${tests}" failures="${failures}" skipped="${skipped}"><testsuite tests="${tests}">${cases}</testsuite></testsuites>`
describe("Coding trusted check reporting", () => {
  test("recovery reuses only the exact fenced host record for unchanged source and configuration", async () => {
    await fixture(async (root) => {
      const original = codingFixture("test")
      const location = Location.Ref.make({ directory: AbsolutePath.make(root) })
      const plan = CodingHostPlan.freeze({ authority: "admission", location, checks: { cwd: ".", test: "bun-test" } })
      const archive = await WorkflowWorkspaceMaterialization.seal([], async () => {
        throw new Error("no entries")
      })
      const sealedSnapshot = WorkflowWorkspaceMaterialization.bind({
        workflowID: original.workflow.id,
        stageID: original.stage.id,
        revision: 0,
        location,
        snapshotRef: Snapshot.ID.make("coding-cached-source"),
        manifestSha256: "b".repeat(64),
        workspaceSha256: archive.workspaceSha256,
        archive,
      })
      const record: CodingArtifacts.CheckRecord = {
        schemaVersion: 1,
        workflowID: original.workflow.id,
        stageID: original.stage.id,
        attempt: 1,
        leaseOwner: "old-owner",
        revision: 0,
        locationSha256: plan.locationSha256,
        planSha256: plan.sha256,
        configSha256: plan.configSha256,
        implementationSha256: sealedSnapshot.manifestSha256,
        workspaceSha256: sealedSnapshot.workspaceSha256,
        snapshotRef: sealedSnapshot.snapshotRef,
        sealedAuthoritySha256: sealedSnapshot.authoritySha256,
        checks: CodingChecksServer.measuredChecks(plan, [
          {
            id: "test",
            result: {
              exitCode: 0,
              timedOut: false,
              log: "pass",
              report: report('<testcase name="sum"/>'),
              ownerSha256: "c".repeat(64),
            },
          },
        ]),
      }
      const stage = {
        ...original.stage,
        attempt: 2,
        leaseOwner: "new-owner",
        checkpoint: { kind: "workflow.model.continuation", version: 2, codingChecks: record },
      }
      const request = { workflow: { ...original.workflow, location }, stage, revision: 0, sealedSnapshot, plan }
      expect(CodingChecksServer.reusableRecord(request)).toEqual(record)
      expect(
        CodingChecksServer.reusableRecord({ ...request, stage: { ...stage, checkpoint: undefined } }),
      ).toBeUndefined()
      expect(() =>
        CodingChecksServer.reusableRecord({ ...request, plan: { ...plan, sha256: "f".repeat(64) } }),
      ).toThrow()
      expect(() =>
        CodingChecksServer.reusableRecord({
          ...request,
          sealedSnapshot: { ...sealedSnapshot, manifestSha256: "f".repeat(64) },
        }),
      ).toThrow()
      expect(() =>
        CodingChecksServer.reusableRecord({
          ...request,
          stage: { ...stage, checkpoint: { ...stage.checkpoint, codingChecks: { ...record, stageID: "wfs_foreign" } } },
        }),
      ).toThrow()
    })
  })
  test("host records derive pass from real report, retain failures and mark only unselected checks not-applicable", async () => {
    await fixture(async (root) => {
      const location = Location.Ref.make({ directory: AbsolutePath.make(root) })
      const plan = CodingHostPlan.freeze({ authority: "admission", location, checks: { cwd: ".", test: "bun-test" } })
      const value = {
        exitCode: 0,
        timedOut: false,
        log: "1 pass",
        report: report('<testcase name="sum"/>'),
        ownerSha256: "a".repeat(64),
      }
      const checked = CodingChecksServer.measuredChecks(plan, [{ id: "test", result: value }])
      expect(CodingArtifacts.checksPassed(checked, plan)).toBe(true)
      expect(checked.slice(1)).toEqual([
        { id: "build", status: "not-applicable" },
        { id: "typecheck", status: "not-applicable" },
      ])
      for (const change of [
        { report: undefined },
        { report: "1 pass" },
        { report: report("", 0) },
        { exitCode: 1 },
        { timedOut: true },
      ]) {
        const failed = CodingChecksServer.measuredChecks(plan, [{ id: "test", result: { ...value, ...change } }])
        expect(CodingArtifacts.checksPassed(failed, plan)).toBe(false)
      }
      expect(() => CodingChecksServer.measuredChecks(plan, [])).toThrow()
      expect(() =>
        CodingChecksServer.measuredChecks(plan, [
          { id: "test", result: value },
          { id: "test", result: value },
        ]),
      ).toThrow()
    })
  })
  test("counts actual test cases once, not repeated nested suite aggregates", () => {
    expect(
      CodingJUnit.parse(report('<testsuite tests="2"><testcase name="a"/><testcase name="b"/></testsuite>', 2)),
    ).toEqual({ observedTests: 2, failedTests: 0, skippedTests: 0 })
    expect(
      CodingJUnit.parse(
        report('<testcase name="a"><failure message="wrong">diff &lt;sum&gt;</failure></testcase>', 1, 1),
      ),
    ).toEqual({ observedTests: 1, failedTests: 1, skippedTests: 0 })
    expect(CodingJUnit.parse(report('<testcase name="todo"><skipped/></testcase>', 1, 0, 1))).toEqual({
      observedTests: 0,
      failedTests: 0,
      skippedTests: 1,
    })
    expect(CodingJUnit.parse(report("", 0))).toEqual({ observedTests: 0, failedTests: 0, skippedTests: 0 })
  })
  test("rejects malformed, truncated, entity-bearing and forged positive reports", () => {
    for (const value of [
      "",
      "1 pass",
      report("", 1),
      report('<testcase name="x"/>').slice(0, -3),
      '<testsuites tests="1"><testcase></testsuites>',
      '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]>' + report('<testcase name="x"/>'),
      report('<testcase name="x"><failure/></testcase>', 1, 0),
      report('<testcase name="x"/><testcase name="y"/>', 1),
      report('<testcase name="x"/>') + "<extra/>",
      report('<testcase name="x" name="y"/>'),
      report('<testcase name="&unknown;"/>'),
      "x".repeat(300000),
    ])
      expect(() => CodingJUnit.parse(value)).toThrow()
  })
  test("trusted launcher executes real Bun tests and returns genuine bounded JUnit evidence", async () => {
    await fixture(async (root) => {
      await fs.writeFile(path.join(root, "sum.ts"), "export const sum = (a:number,b:number) => a-b")
      await fs.writeFile(
        path.join(root, "sum.test.ts"),
        'import {test,expect} from "bun:test";import {sum} from "./sum";test("sum",()=>expect(sum(2,3)).toBe(5))',
      )
      const failed = await launch(root, ["bun", "--no-env-file", "test"], "test")
      expect(failed.exitCode).not.toBe(0)
      expect(failed.timedOut).toBe(false)
      expect(CodingJUnit.parse(failed.report!)).toEqual({ observedTests: 1, failedTests: 1, skippedTests: 0 })
      await fs.writeFile(path.join(root, "sum.ts"), "export const sum = (a:number,b:number) => a+b")
      const passed = await launch(root, ["bun", "--no-env-file", "test"], "test")
      expect(passed.exitCode).toBe(0)
      expect(CodingJUnit.parse(passed.report!)).toEqual({ observedTests: 1, failedTests: 0, skippedTests: 0 })
    })
  })
  test("real empty tests and timeout never manufacture a positive report", async () => {
    await fixture(async (root) => {
      const empty = await launch(root, ["bun", "--no-env-file", "test"], "test")
      expect(empty.report === undefined || CodingJUnit.parse(empty.report).observedTests === 0).toBe(true)
      await fs.writeFile(path.join(root, "hang.test.ts"), "await Bun.sleep(60000)")
      const timeout = await launch(root, ["bun", "--no-env-file", "test"], "test", 500)
      expect(timeout.timedOut).toBe(true)
      expect(timeout.exitCode).not.toBe(0)
      expect(timeout.report).toBeUndefined()
    })
  })
  test("selected scripts do not auto-load dotenv through child Bun", async () => {
    await fixture(async (root) => {
      await fs.writeFile(path.join(root, ".env"), "CODING_FIXTURE_DOTENV=must-not-load\n")
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ scripts: { build: "bun -e \"console.log(process.env.CODING_FIXTURE_DOTENV ?? 'clean')\"" } }),
      )
      const result = await launch(root, ["bun", "--no-env-file", "run", "build"], "build")
      expect(result.exitCode).toBe(0)
      expect(result.log).toContain("clean")
      expect(result.log).not.toContain("must-not-load")
    })
  })
  test("nested Bun inherits the pinned no-dotenv option without an executable temporary shim", async () => {
    await fixture(async (root) => {
      await fs.writeFile(path.join(root, ".env"), "CODING_FIXTURE_DOTENV=must-not-load\n")
      await fs.writeFile(
        path.join(root, "nested.ts"),
        'console.log(JSON.stringify({ options: process.env.BUN_OPTIONS, canary: process.env.CODING_FIXTURE_DOTENV ?? "clean", executable: process.execPath }))',
      )
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "bun ./nested.ts" } }))
      const result = await launch(root, ["bun", "--no-env-file", "run", "build"], "build")
      expect(result.exitCode).toBe(0)
      expect(result.log).toContain('"options":"--no-env-file"')
      expect(result.log).toContain('"canary":"clean"')
      expect(result.log).not.toContain("must-not-load")
      expect(await fs.readdir(path.join(root, "owned-host"))).not.toContain("bin")
    })
  })
  test("sealed source builds in a disposable writable copy without changing host files", async () => {
    await fixture(async (root) => {
      const bytes = Buffer.from("export const sum = (a:number,b:number) => a+b")
      const archive = await WorkflowWorkspaceMaterialization.seal(
        [
          {
            path: RelativePath.make("sum.ts"),
            type: "file",
            sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
            size: bytes.length,
          },
        ],
        async () => bytes,
      )
      await fs.writeFile(path.join(root, "sum.ts"), "host file must not be built or changed")
      const result = await launch(
        root,
        ["bun", "--no-env-file", "build", "./sum.ts", "--outdir", "./dist"],
        "build",
        10000,
        JSON.stringify(archive),
      )
      expect(result.exitCode).toBe(0)
      expect(await fs.readFile(path.join(root, "sum.ts"), "utf8")).toBe("host file must not be built or changed")
      expect(await Bun.file(path.join(root, "dist", "sum.js")).exists()).toBe(false)
      expect(await fs.readFile(path.join(root, "owned-host", "workspace", "dist", "sum.js"), "utf8")).toContain("a + b")
    })
  })
  test("tampered sealed stdin is rejected before a selected command can write", async () => {
    await fixture(async (root) => {
      await expect(
        launch(
          root,
          ["bun", "--no-env-file", "-e", 'await Bun.write("unexpected", "bad")'],
          "build",
          10000,
          "{}",
          "wrong bytes",
        ),
      ).rejects.toThrow()
      expect(await Bun.file(path.join(root, "unexpected")).exists()).toBe(false)
    })
  })
})

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-coding-check-test-"))
  try {
    await run(root)
  } finally {
    const resolved = await fs.realpath(root)
    if (
      resolved !== path.resolve(root) ||
      !path.basename(resolved).startsWith("opencode-coding-check-test-") ||
      !resolved.toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase() + path.sep)
    )
      throw new Error("Unsafe owned coding fixture cleanup")
    await fs.rm(resolved, { recursive: true, force: true })
  }
}
async function launch(
  root: string,
  argv: readonly string[],
  id: "test" | "build",
  timeoutMs = 10000,
  payload?: string,
  stdin = payload,
) {
  const source = CodingCheckLauncher.source({
    argv,
    id,
    timeoutMs,
    scratchRoot: path.join(root, "owned-host"),
    ...(payload === undefined
      ? {}
      : {
          workspace: {
            cwd: ".",
            inputBytes: Buffer.byteLength(payload),
            inputSha256: new Bun.CryptoHasher("sha256").update(payload).digest("hex"),
          },
        }),
  })
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
    cwd: root,
    env: {
      PATH: process.env.PATH!,
      TEMP: os.tmpdir(),
      TMP: os.tmpdir(),
      BUN_INSTALL_CACHE_DIR: path.join(root, "owned-host", "bun-cache"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(root, "owned-host", "transpiler-cache"),
      XDG_CACHE_HOME: path.join(root, "owned-host", "cache"),
      XDG_CONFIG_HOME: path.join(root, "owned-host", "config"),
      XDG_DATA_HOME: path.join(root, "owned-host", "data"),
      USERPROFILE: path.join(root, "owned-host", "home"),
      HOME: path.join(root, "owned-host", "home"),
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (stderr) throw new Error(stderr)
  return CodingCheckLauncher.decode(stdout, exit)
}
