import fs from "node:fs/promises"
import path from "node:path"
import type { PriceBook } from "../broker/pricing"
import { redactText, sanitizeUnknown } from "../broker/redaction"
import { startBroker } from "../broker/server"
import { assertReferenceFiles, buildLaunchEnvironment } from "../arms/environment"
import { prepareWorkflowArm } from "../arms/workflow"
import { collectDirectOutput, prepareDirectArm } from "../arms/direct"
import { superviseProcess } from "../arms/process"
import type { ArmInput, BinaryAuthority, RunRoots } from "../arms/types"
import { sha256File } from "../hash"
import { canonicalJson } from "../campaign/canonical"
import type { Task24Layout } from "../root"
import { createFakeProvider, fakeRequest } from "./fake-provider"
import { runFunctionalEvaluation } from "../evaluator/functional"
import { publishImmutable } from "./atomic"
import { bindEvidenceFile } from "../evaluator/evidence"

export interface SecurityAcceptanceResult {
  readonly checks: readonly string[]
  readonly rejected: number
  readonly leaks: 0
  readonly exactBinaryChecks: readonly string[]
  readonly evidenceFile: string
  readonly evidenceSha256: string
}

export async function runSecurityAcceptance(
  layout: Task24Layout,
  prices: PriceBook,
  exact?: Readonly<{ modified: BinaryAuthority; upstream: BinaryAuthority; evidenceRoot?: string }>,
): Promise<SecurityAcceptanceResult> {
  const root = path.join(layout.tmp, `offline-security-${crypto.randomUUID()}`)
  const roots = runRoots(root)
  await Promise.all(
    Object.values(roots)
      .filter((value) => value !== root)
      .map((directory) => fs.mkdir(directory, { recursive: true })),
  )
  const checks: string[] = []
  const exactEvidence: unknown[] = []
  try {
    const authority = armInput(roots)
    await mustReject(
      () => prepareWorkflowArm({ ...authority, brokerOrigin: "https://api.deepseek.com" }),
      "TASK24_BROKER_ORIGIN_INVALID",
    )
    checks.push("remote_endpoint_injection")

    const environment = buildLaunchEnvironment({
      roots,
      mode: "direct",
      brokerGrant: authority.brokerGrant,
      inherited: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        DEEPSEEK_API_KEY: "sk-CANARY_PUBLIC_OVERRIDE",
        OPENCODE_BENCHMARK_TRANSPORT_FILE: "C:\\escape.json",
      },
    })
    if (
      environment.DEEPSEEK_API_KEY !== undefined ||
      environment.OPENCODE_BENCHMARK_TRANSPORT_FILE !== undefined ||
      environment.OPENCODE_PERMISSION !==
        JSON.stringify({
          bash: "deny",
          external_directory: "deny",
          webfetch: "deny",
          websearch: "deny",
        })
    ) {
      throw new TypeError("TASK24_SECURITY_ENVIRONMENT_OVERRIDE")
    }
    checks.push("public_transport_override", "external_network_tools")

    await mustReject(() => assertReferenceFiles(roots, ["../gold/answer.txt"]), "TASK24_REFERENCE_PATH_INVALID")
    checks.push("workspace_traversal", "hidden_gold_access")

    const outside = path.join(root, "outside-reference.txt")
    const linked = path.join(roots.repo, "linked-reference.txt")
    await fs.writeFile(outside, "outside")
    await fs.symlink(outside, linked, "file")
    await mustReject(() => assertReferenceFiles(roots, ["linked-reference.txt"]), "TASK24_REFERENCE_FILE_INVALID")
    await fs.rm(linked)
    checks.push("symlink_reparse_escape")

    const fake = createFakeProvider()
    const broker = await startBroker({
      database: path.join(root, "replay.sqlite"),
      campaignID: "offline-security",
      runID: "run-security",
      expiresAt: Date.now() + 60_000,
      maximumCalls: 1,
      ceilings: { CNY: 10_000_000n, USD: 10_000_000n },
      prices,
      providerKeys: { kimi: "sk-TASK24_FAKE_KIMI", deepseek: "sk-TASK24_FAKE_DEEPSEEK" },
      upstream: fake.upstream,
    })
    try {
      const route = {
        role: "all",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        protocol: "responses",
        effort: "max",
      } as const
      const invoke = () =>
        fetch(`${broker.origin}/v1/deepseek/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${broker.grant}`, "content-type": "application/json" },
          body: JSON.stringify(fakeRequest(route)),
        })
      const first = await invoke()
      await first.text()
      if (!first.ok || (await invoke()).status !== 401 || fake.calls().length !== 1) {
        throw new TypeError("TASK24_SECURITY_GRANT_REPLAY")
      }
      checks.push("grant_replay")
    } finally {
      await broker[Symbol.asyncDispose]()
    }

    const malformed = createFakeProvider()
    const usageBroker = await startBroker({
      database: path.join(root, "usage.sqlite"),
      campaignID: "offline-security-usage",
      runID: "run-security-usage",
      expiresAt: Date.now() + 60_000,
      maximumCalls: 1,
      ceilings: { CNY: 10_000_000n, USD: 10_000_000n },
      prices,
      providerKeys: { kimi: "sk-TASK24_FAKE_KIMI", deepseek: "sk-TASK24_FAKE_DEEPSEEK" },
      upstream: malformed.upstream,
    })
    try {
      const response = await fetch(`${usageBroker.origin}/v1/deepseek/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${usageBroker.grant}`, "content-type": "application/json" },
        body: JSON.stringify(
          fakeRequest(
            { role: "all", provider: "deepseek", model: "deepseek-v4-pro", protocol: "responses", effort: "max" },
            "malformed_usage",
          ),
        ),
      })
      await response.text()
      if (usageBroker.ledger.records()[0]?.resultClass !== "malformed") {
        throw new TypeError("TASK24_SECURITY_FAKE_USAGE_ACCEPTED")
      }
      checks.push("fake_usage")
    } finally {
      await usageBroker[Symbol.asyncDispose]()
    }

    const redacted = JSON.stringify(
      sanitizeUnknown({ authorization: "Bearer CANARY_LOG_INJECTION", message: "sk-CANARY_LOG_INJECTION" }),
    )
    if (redacted.includes("CANARY") || redactText("sk-CANARY_LOG_INJECTION").includes("CANARY")) {
      throw new TypeError("TASK24_SECURITY_LOG_REDACTION")
    }
    checks.push("redaction_helper")

    const evaluatorRoot = path.join(root, "evaluator")
    await fs.mkdir(evaluatorRoot)
    const evaluatorCommand = path.join(evaluatorRoot, "check.js")
    const workspaceSource = path.join(roots.repo, "source.txt")
    await fs.writeFile(evaluatorCommand, "// sealed evaluator\n")
    const evaluatorCommandSha256 = await sha256File(evaluatorCommand)
    await fs.writeFile(workspaceSource, "immutable")
    await mustReject(
      () =>
        runFunctionalEvaluation({
          evaluatorRoot,
          workspaceRoot: roots.repo,
          tempRoot: roots.temp,
          executable: "D:\\Task24-Fake-Evaluator.exe",
          commandRelativePath: "check.js",
          commandSha256: evaluatorCommandSha256,
          timeoutMs: 1_000,
          evidence: [],
          runner: async () => {
            await fs.writeFile(workspaceSource, "mutated")
            return {
              exitCode: 0,
              stdout: '{"schemaVersion":1,"assertions":[{"id":"ok","mandatory":true,"passed":true,"weight":1}]}',
              stderr: "",
              timedOut: false,
            }
          },
        }),
      "TASK24_FUNCTIONAL_WORKSPACE_MUTATED",
    )
    await fs.writeFile(workspaceSource, "immutable")
    checks.push("evaluator_mutation")

    const oversizedFake = createFakeProvider()
    const oversized = await startBroker({
      database: path.join(root, "oversized.sqlite"),
      campaignID: "offline-oversized",
      runID: "run-oversized",
      expiresAt: Date.now() + 60_000,
      maximumCalls: 1,
      ceilings: { CNY: 10_000_000n, USD: 10_000_000n },
      prices,
      providerKeys: { kimi: "sk-TASK24_FAKE_KIMI", deepseek: "sk-TASK24_FAKE_DEEPSEEK" },
      upstream: oversizedFake.upstream,
    })
    try {
      const large = "x".repeat(8 * 1024 * 1024 + 1)
      const response = await fetch(`${oversized.origin}/v1/deepseek/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${oversized.grant}`, "content-type": "application/json" },
        body: large,
      })
      if (response.status !== 413 || oversizedFake.calls().length !== 0) {
        throw new TypeError("TASK24_SECURITY_OVERSIZED_INPUT")
      }
    } finally {
      await oversized[Symbol.asyncDispose]()
    }

    const oversizedOutput = await startBroker({
      database: path.join(root, "oversized-output.sqlite"),
      campaignID: "offline-oversized-output",
      runID: "run-oversized-output",
      expiresAt: Date.now() + 60_000,
      maximumCalls: 1,
      ceilings: { CNY: 10_000_000n, USD: 10_000_000n },
      prices,
      providerKeys: { kimi: "sk-TASK24_FAKE_KIMI", deepseek: "sk-TASK24_FAKE_DEEPSEEK" },
      upstream: async () =>
        new Response(`event: response.output_text.delta\ndata: ${"x".repeat(1024 * 1024 + 1)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    })
    try {
      const response = await fetch(`${oversizedOutput.origin}/v1/deepseek/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${oversizedOutput.grant}`, "content-type": "application/json" },
        body: JSON.stringify(
          fakeRequest({
            role: "all",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            protocol: "responses",
            effort: "max",
          }),
        ),
      })
      await response.text()
      if (oversizedOutput.ledger.records()[0]?.resultClass !== "malformed") {
        throw new TypeError("TASK24_SECURITY_OVERSIZED_OUTPUT")
      }
      checks.push("oversized_input_output")
    } finally {
      await oversizedOutput[Symbol.asyncDispose]()
    }

    if (exact) {
      const incompleteEvidence = await runExactTerminalCase(root, prices, exact.modified, "B", "incomplete")
      exactEvidence.push(incompleteEvidence)
      checks.push("exact_binary_incomplete")
      exactEvidence.push(await runExactTerminalCase(root, prices, exact.upstream, "D", "failed"))
      checks.push("exact_binary_failed")
      exactEvidence.push(await runExactNetworkCase(root, prices, exact.modified))
      checks.push("exact_binary_external_network")
      exactEvidence.push(await runEvaluatorSandboxCase(root))
      checks.push("evaluator_sandbox_boundary")
      if (incompleteEvidence.logInjectionRedacted !== true) {
        throw new TypeError("TASK24_SECURITY_EXACT_LOG_REDACTION_MISSING")
      }
      checks.push("log_injection")
    }
    const evidenceRoot = exact?.evidenceRoot ?? root
    await fs.mkdir(evidenceRoot, { recursive: true })
    const retainedEvidence = []
    if (exact) {
      const retained = path.join(evidenceRoot, "binary-evidence")
      await fs.mkdir(retained)
      for (const caseID of ["exact-modified-incomplete", "exact-upstream-failed", "exact-modified-network", "evaluator-sandbox"]) {
        const caseRoot = path.join(root, caseID)
        for (const relative of ["output/stdout.jsonl", "output/stderr.log", "broker.sqlite"]) {
          const source = path.join(caseRoot, relative)
          if (!(await Bun.file(source).exists())) continue
          const target = path.join(retained, `${caseID}-${path.basename(relative)}`)
          await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL)
          retainedEvidence.push(bindEvidenceFile(evidenceRoot, target, relative.endsWith("sqlite") ? "security-ledger" : "security-log"))
        }
      }
    }
    const evidenceFile = path.join(evidenceRoot, "security-acceptance.json")
    await publishImmutable(
      evidenceFile,
      canonicalJson({ schemaVersion: 1, checks, exactBinaryChecks: exactEvidence, retainedEvidence }) + "\n",
    )
    return Object.freeze({
      checks: Object.freeze(checks),
      rejected: checks.length,
      leaks: 0,
      exactBinaryChecks: Object.freeze(
        exactEvidence
          .map((item) => (record(item) && typeof item.check === "string" ? item.check : "invalid"))
          .filter((check) => check.startsWith("exact_binary_")),
      ),
      evidenceFile,
      evidenceSha256: await sha256File(evidenceFile),
    })
  } finally {
    await removeOwnedTree(layout.tmp, root)
  }
}

async function runEvaluatorSandboxCase(root: string): Promise<Readonly<Record<string, unknown>>> {
  const manifestFile = "D:\\OpenCode-Local\\runtime\\sandbox\\workflow-sandbox.manifest.json"
  const manifest: unknown = JSON.parse(await fs.readFile(manifestFile, "utf8"))
  if (!record(manifest) || typeof manifest.image !== "string" || typeof manifest.engineSha256 !== "string") {
    throw new TypeError("TASK24_SECURITY_SANDBOX_MANIFEST_INVALID")
  }
  const roots = await exactRoots(root, "evaluator-sandbox")
  const stdoutFile = path.join(roots.output, "stdout.jsonl")
  const stderrFile = path.join(roots.output, "stderr.log")
  const probe = [
    "let networkDenied=false",
    'try{await fetch("http://host.docker.internal:9/task24")}catch{networkDenied=true}',
    "let writeDenied=false",
    'try{await Bun.write("/starter/task24-probe","x")}catch{writeDenied=true}',
    'const socket=await Bun.file("/var/run/docker.sock").exists()',
    'const hiddenGoldAbsent=!(await Bun.file("/evaluation/functional.test.ts").exists())',
    'const vectorAbsent=process.env.TASK24_VECTOR_REQUEST===undefined',
    'if(!networkDenied||!writeDenied||socket||!hiddenGoldAbsent||!vectorAbsent)process.exit(2)',
    'console.log(JSON.stringify({networkDenied,writeDenied,dockerSocketAbsent:!socket,hiddenGoldAbsent,vectorAbsent}))',
  ].join(";")
  const result = await superviseProcess({
    executable: "D:\\Applications\\Docker\\resources\\bin\\docker.exe",
    expectedExecutableSha256: manifest.engineSha256,
    args: [
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--user",
      "65532:65532",
      "--pids-limit",
      "16",
      "--memory",
      "128m",
      "--cpus",
      "0.5",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "--mount",
      `type=bind,src=${roots.repo},dst=/starter,readonly`,
      "--entrypoint",
      "/usr/local/bin/bun",
      manifest.image,
      "-e",
      probe,
    ],
    cwd: roots.runRoot,
    environment: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      TEMP: roots.temp,
      TMP: roots.temp,
      DOCKER_CONFIG: roots.config,
    },
    stdoutFile,
    stderrFile,
    maximumCaptureBytes: 1024 * 1024,
    maximumDurationMs: 60_000,
  })
  if (result.classification !== "exited" || result.exitCode !== 0) {
    throw new TypeError("TASK24_SECURITY_SANDBOX_BOUNDARY_FAILED")
  }
  const value: unknown = JSON.parse((await fs.readFile(stdoutFile, "utf8")).trim())
  if (
    !record(value) ||
    value.networkDenied !== true ||
    value.writeDenied !== true ||
    value.dockerSocketAbsent !== true ||
    value.hiddenGoldAbsent !== true ||
    value.vectorAbsent !== true ||
    (await Bun.file(path.join(roots.repo, "task24-probe")).exists())
  ) {
    throw new TypeError("TASK24_SECURITY_SANDBOX_BOUNDARY_FAILED")
  }
  return Object.freeze({
    check: "evaluator_sandbox_boundary",
    engineSha256: result.executableSha256,
    image: manifest.image,
    manifestSha256: await sha256File(manifestFile),
    stdoutSha256: await sha256File(stdoutFile),
    stderrSha256: await sha256File(stderrFile),
    networkDenied: true,
    writeDenied: true,
    dockerSocketAbsent: true,
    hiddenGoldAbsent: true,
    vectorAbsent: true,
  })
}

async function runExactTerminalCase(
  root: string,
  prices: PriceBook,
  binary: BinaryAuthority,
  armID: "B" | "D",
  terminal: "incomplete" | "failed",
): Promise<Readonly<Record<string, unknown>>> {
  const caseID = `exact-${binary.runtime}-${terminal}`
  const roots = await exactRoots(root, caseID)
  const fake = createFakeProvider({ terminals: [terminal] })
  const broker = await startBroker({
    database: path.join(roots.runRoot, "broker.sqlite"),
    campaignID: "offline-security-exact",
    runID: caseID,
    expiresAt: Date.now() + 60_000,
    maximumCalls: 1,
    ceilings: { CNY: 10_000_000n, USD: 10_000_000n },
    prices,
    providerKeys: { kimi: "sk-TASK24_FAKE_KIMI", deepseek: "sk-TASK24_FAKE_DEEPSEEK" },
    upstream: fake.upstream,
  })
  const logCanary = `sk-TASK24_LOG_CANARY_${terminal.toUpperCase()}_012345678901234567890123456789`
  const prompt = `TASK24_EXACT_TERMINAL_CANARY_${terminal.toUpperCase()} Authorization: Bearer ${logCanary}`
  try {
    const launch = await prepareDirectArm({
      armID,
      campaignID: "offline-security-exact",
      runID: caseID,
      binary,
      roots,
      prompt,
      referenceFiles: [],
      brokerOrigin: broker.origin,
      brokerGrant: broker.grant,
      grantExpiresAt: Date.now() + 60_000,
      budget: securityBudget(),
    })
    const stdoutFile = path.join(roots.output, "stdout.jsonl")
    const stderrFile = path.join(roots.output, "stderr.log")
    const result = await superviseProcess({
      executable: launch.executable,
      expectedExecutableSha256: launch.snapshot.executableSha256,
      args: launch.args,
      cwd: launch.cwd,
      environment: launch.environment,
      stdoutFile,
      stderrFile,
      maximumCaptureBytes: 1024 * 1024,
      maximumDurationMs: 120_000,
    })
    let rejected = result.classification !== "exited" || result.exitCode !== 0
    if (!rejected) {
      try {
        collectDirectOutput(await fs.readFile(stdoutFile, "utf8"))
      } catch {
        rejected = true
      }
    }
    const records = broker.ledger.records()
    if (
      !rejected ||
      fake.calls().length !== 1 ||
      records.length !== 1 ||
      records[0]?.resultClass !== terminal ||
      (await Bun.file(path.join(roots.repo, "task24-offline-provider-edit.txt")).exists())
    ) {
      throw new TypeError(`TASK24_SECURITY_EXACT_TERMINAL_ACCEPTED:${terminal}`)
    }
    await scanDurableText([roots.output], [prompt, logCanary, broker.grant, "sk-TASK24_FAKE_"])
    return Object.freeze({
      check: `exact_binary_${terminal}`,
      binarySha256: result.executableSha256,
      stdoutSha256: await sha256File(stdoutFile),
      stderrSha256: await sha256File(stderrFile),
      resultClass: records[0].resultClass,
      recordSha256: records[0].recordSha256,
      rejected: true,
      logInjectionRedacted: true,
    })
  } finally {
    await broker[Symbol.asyncDispose]()
  }
}

async function runExactNetworkCase(
  root: string,
  prices: PriceBook,
  binary: BinaryAuthority,
): Promise<Readonly<Record<string, unknown>>> {
  const roots = await exactRoots(root, "exact-modified-network")
  let networkHits = 0
  const canary = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      networkHits++
      return new Response("TASK24_FORBIDDEN_NETWORK_CANARY")
    },
  })
  const fake = createFakeProvider({ webfetchURL: `http://127.0.0.1:${canary.port}/forbidden` })
  const broker = await startBroker({
    database: path.join(roots.runRoot, "broker.sqlite"),
    campaignID: "offline-security-network",
    runID: "exact-modified-network",
    expiresAt: Date.now() + 60_000,
    maximumCalls: 2,
    ceilings: { CNY: 10_000_000n, USD: 10_000_000n },
    prices,
    providerKeys: { kimi: "sk-TASK24_FAKE_KIMI", deepseek: "sk-TASK24_FAKE_DEEPSEEK" },
    upstream: fake.upstream,
  })
  const prompt = "TASK24_EXACT_NETWORK_CANARY"
  try {
    const launch = await prepareDirectArm({
      armID: "B",
      campaignID: "offline-security-network",
      runID: "exact-modified-network",
      binary,
      roots,
      prompt,
      referenceFiles: [],
      brokerOrigin: broker.origin,
      brokerGrant: broker.grant,
      grantExpiresAt: Date.now() + 60_000,
      budget: securityBudget(),
    })
    const stdoutFile = path.join(roots.output, "stdout.jsonl")
    const stderrFile = path.join(roots.output, "stderr.log")
    const result = await superviseProcess({
      executable: launch.executable,
      expectedExecutableSha256: launch.snapshot.executableSha256,
      args: launch.args,
      cwd: launch.cwd,
      environment: launch.environment,
      stdoutFile,
      stderrFile,
      maximumCaptureBytes: 1024 * 1024,
      maximumDurationMs: 120_000,
    })
    const stdout = await fs.readFile(stdoutFile, "utf8")
    const parsed = result.classification === "exited" && result.exitCode === 0 ? collectDirectOutput(stdout) : undefined
    const parsedToolRequest = fake.calls().length === 2
    const typedDeniedToolResult = fake.calls()[1]?.toolResultDisposition === "permission_denied"
    const toolCatalogDenied = fake.calls().every((call) => !call.webfetchAdvertised)
    const outputDenialEvent = hasDeniedToolEvent(stdout)
    const explicitlyDenied = parsed !== undefined && parsedToolRequest && toolCatalogDenied && networkHits === 0
    if (networkHits !== 0 || fake.calls().length === 0 || fake.calls().length > 2 || !explicitlyDenied) {
      throw new TypeError(
        `TASK24_SECURITY_EXACT_NETWORK_ESCAPE:${result.classification}:${result.exitCode ?? "null"}:${fake.calls().length}:${parsed?.toolCalls ?? -1}:${explicitlyDenied}:${networkHits}`,
      )
    }
    if (result.classification !== "exited" || result.exitCode !== 0) {
      throw new TypeError("TASK24_SECURITY_EXACT_NETWORK_PROCESS_INVALID")
    }
    await scanDurableText([roots.output], [prompt, broker.grant, "sk-TASK24_FAKE_", "TASK24_FORBIDDEN_NETWORK_CANARY"])
    return Object.freeze({
      check: "exact_binary_external_network",
      binarySha256: result.executableSha256,
      stdoutSha256: await sha256File(stdoutFile),
      stderrSha256: await sha256File(stderrFile),
      exitCode: result.exitCode,
      toolCalls: parsed.toolCalls,
      parsedToolRequest,
      typedDeniedToolResult,
      toolCatalogDenied,
      explicitlyDenied,
      outputDenialEvent,
      denialObservedBy: "permission-pruned-tool-catalog-with-zero-network-hits",
      networkHits,
    })
  } finally {
    await broker[Symbol.asyncDispose]()
    await canary.stop(true)
  }
}

function hasDeniedToolEvent(stdout: string): boolean {
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    try {
      const event: unknown = JSON.parse(line)
      if (!record(event) || event.type !== "tool_use") continue
      const serialized = JSON.stringify(event).toLowerCase()
      if (/permission|denied|forbidden/.test(serialized) && /deny|denied|forbidden|error/.test(serialized)) return true
    } catch {
      return false
    }
  }
  return false
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function exactRoots(root: string, caseID: string): Promise<RunRoots> {
  const roots = runRoots(path.join(root, caseID))
  await Promise.all(Object.values(roots).map((directory) => fs.mkdir(directory, { recursive: true })))
  return roots
}

function securityBudget() {
  return Object.freeze({
    aggregateInputTokens: 20_000,
    aggregateOutputTokens: 4_000,
    maxToolCalls: 4,
    maxRetries: 1,
    maxDurationMs: 120_000,
  })
}

export async function scanDurableText(roots: readonly string[], forbidden: readonly string[]): Promise<void> {
  const inspect = async (file: string) => {
    const bytes = await fs.readFile(file)
    if (bytes.byteLength > 64 * 1024 * 1024) throw new TypeError("TASK24_LEAKAGE_FILE_TOO_LARGE")
    const text = bytes.toString("utf8")
    if (/\bsk-[A-Za-z0-9_-]{8,}\b/.test(text) || /authorization\s*:\s*bearer\s+\S+/i.test(text)) {
      throw new TypeError("TASK24_DURABLE_SECRET_LEAK")
    }
    if (forbidden.some((value) => value.length > 0 && text.includes(value))) {
      throw new TypeError("TASK24_DURABLE_CANARY_LEAK")
    }
  }
  for (const root of roots) {
    const resolved = path.resolve(root)
    const stat = await fs.lstat(resolved)
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) {
      throw new TypeError("TASK24_LEAKAGE_ROOT_UNSAFE")
    }
    if (stat.isFile()) await inspect(resolved)
    else await walk(resolved, inspect)
  }
}

function runRoots(runRoot: string): RunRoots {
  return Object.freeze({
    runRoot,
    repo: path.join(runRoot, "repo"),
    data: path.join(runRoot, "data"),
    config: path.join(runRoot, "config"),
    cache: path.join(runRoot, "cache"),
    temp: path.join(runRoot, "temp"),
    output: path.join(runRoot, "output"),
  })
}

function armInput(roots: RunRoots): ArmInput {
  return {
    armID: "A",
    campaignID: "offline-security",
    runID: "run-security",
    binary: {
      runtime: "modified",
      executable: "D:\\OpenCode-Local\\bin\\opencode-local.exe",
      version: "offline",
      sha256: "a".repeat(64),
    },
    roots,
    prompt: "offline",
    referenceFiles: [],
    brokerOrigin: "http://127.0.0.1:1",
    brokerGrant: "TASK24_BROKER_GRANT_abcdefghijklmnopqrstuvwxyz",
    grantExpiresAt: Date.now() + 60_000,
    budget: {
      aggregateInputTokens: 100,
      aggregateOutputTokens: 100,
      maxToolCalls: 10,
      maxRetries: 1,
      maxDurationMs: 10_000,
    },
  }
}

async function mustReject(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation()
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes(code)) return
    throw cause
  }
  throw new TypeError(`TASK24_SECURITY_EXPECTED_REJECTION:${code}`)
}

async function walk(root: string, visit: (file: string) => Promise<void>): Promise<void> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isSymbolicLink()) throw new TypeError("TASK24_LEAKAGE_LINK_UNSAFE")
    if (entry.isDirectory()) await walk(candidate, visit)
    else if (entry.isFile()) await visit(candidate)
  }
}

async function removeOwnedTree(parent: string, target: string): Promise<void> {
  const resolvedParent = path.resolve(parent) + path.sep
  const resolvedTarget = path.resolve(target)
  if (!resolvedTarget.startsWith(resolvedParent)) throw new TypeError("TASK24_SECURITY_CLEANUP_UNSAFE")
  await fs.rm(resolvedTarget, { recursive: true, force: true })
}
