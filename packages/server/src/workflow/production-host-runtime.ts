export * as ProductionHostRuntime from "./production-host-runtime"

import { WorkflowBenchmarkTransport } from "@opencode-ai/core/workflow/benchmark-transport"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Layer } from "effect"
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { DockerConfig } from "./docker-config"
import { HostRootPolicy } from "./host-root-policy"
import { ProductionHostRoots } from "./production-host-roots"
import { BenchmarkAclProbe } from "./benchmark-acl-probe"
import { BenchmarkAclAuthority } from "./benchmark-acl-authority"

const BENCHMARK_RUNS_ROOT = "D:\\OpenCode-Benchmark\\Task24\\runs"
const BENCHMARK_WORKSPACES_ROOT = "D:\\OpenCode-Benchmark\\Task24\\workspaces"
const MAX_TRANSPORT_FILE_BYTES = 16 * 1024
const benchmarkEnvironmentNames = [
  "OPENCODE_BENCHMARK_TRANSPORT_FILE",
  "OPENCODE_BENCHMARK_RUN_DATA_ROOT",
  "OPENCODE_BENCHMARK_CAMPAIGN_ID",
  "OPENCODE_BENCHMARK_RUN_ID",
] as const

export interface Runtime {
  readonly contract: ProductionHostRoots.Contract
  readonly dockerConfig: DockerConfig.Config
}

export function load(
  environment: Readonly<Record<string, string | undefined>>,
  options: { readonly probe?: HostRootPolicy.Probe; readonly workspaceRoots?: readonly string[] } = {},
): Runtime {
  const tempRoot = environment.OPENCODE_WORKFLOW_HOST_TEMP
  if (tempRoot === undefined || tempRoot.length === 0) throw new TypeError("OPENCODE_WORKFLOW_HOST_TEMP is required")
  const benchmark = options.probe === undefined ? benchmarkProbe(environment, tempRoot) : undefined
  const contract = ProductionHostRoots.fromEnvironment(environment, {
    probe: options.probe ?? benchmark?.probe ?? HostRootPolicy.productionProbe({ tempRoot }),
    benchmarkWriteGrant: benchmark?.writeGrant,
    workspaceRoots: options.workspaceRoots,
  })
  return Object.freeze({ contract, dockerConfig: DockerConfig.fromProductionHostRoots(contract) })
}

function benchmarkProbe(
  environment: Readonly<Record<string, string | undefined>>,
  tempRoot: string,
): { readonly probe: HostRootPolicy.Probe; readonly writeGrant?: HostRootPolicy.BenchmarkWriteGrant } | undefined {
  if (environment.OPENCODE_BENCHMARK_HOST_FILE === undefined) return undefined
  const binding = loadBenchmarkTransport(environment)
  const runDataRoot = environment.OPENCODE_BENCHMARK_RUN_DATA_ROOT
  if (
    !binding ||
    binding.evidenceMode !== "production" ||
    !runDataRoot ||
    environment.OPENCODE_BENCHMARK_HOST_FILE !== path.join(runDataRoot, "benchmark-host.json") ||
    !strictDescendant(runDataRoot, tempRoot)
  )
    throw new TypeError("TASK24_BENCHMARK_ACL_AUTHORITY")
  const guard = () => {
    if (loadBenchmarkTransport(environment)?.bindingSha256 !== binding.bindingSha256)
      throw new TypeError("TASK24_BENCHMARK_ACL_STALE")
  }
  // Missing proof never grants an exception: the original strict ACL policy
  // remains authoritative. Only a token-authenticated native record enables it.
  return existsSync(path.join(path.dirname(process.execPath), "benchmark-acl-authority.json"))
    ? BenchmarkAclAuthority.make({ binding, tempRoot, guard })
    : { probe: BenchmarkAclProbe.make({ tempRoot, guard }) }
}

export function unavailableDockerConfig(): DockerConfig.Config {
  return DockerConfig.fromEnvironment(Object.freeze({}))
}

export function loadBenchmarkTransport(
  environment: Readonly<Record<string, string | undefined>>,
  now = Date.now(),
): WorkflowBenchmarkTransport.Binding | undefined {
  const configured = benchmarkEnvironmentNames.filter((name) => environment[name] !== undefined)
  if (configured.length === 0) return undefined
  if (configured.length !== benchmarkEnvironmentNames.length)
    throw new TypeError("Benchmark transport requires its complete trusted environment contract")

  const fileInput = required(environment, "OPENCODE_BENCHMARK_TRANSPORT_FILE")
  const rootInput = required(environment, "OPENCODE_BENCHMARK_RUN_DATA_ROOT")
  const campaignID = required(environment, "OPENCODE_BENCHMARK_CAMPAIGN_ID")
  const runID = required(environment, "OPENCODE_BENCHMARK_RUN_ID")
  const runDataRoot = canonicalDirectory(rootInput, "Benchmark run data root")
  const runtimeRoot = [BENCHMARK_RUNS_ROOT, BENCHMARK_WORKSPACES_ROOT].find((root) =>
    strictDescendant(root, runDataRoot),
  )
  if (runtimeRoot === undefined)
    throw new TypeError("Benchmark run data root must be inside a Task24 controlled runtime root")
  // Only the selected allowed root is an ancestor of this isolated run. A
  // sibling namespace is irrelevant and must not require another OS grant.
  const runtimeStat = lstatSync(runtimeRoot)
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink())
    throw new TypeError("Task24 benchmark runtime root must not be a link or reparse point")
  // runDataRoot was already resolved to its full native canonical path, so
  // aliases in this ancestor chain are rejected there. Do not require list or
  // read access to the shared namespace merely to resolve it a second time.

  const file = canonicalFile(fileInput, "Benchmark transport file")
  if (!strictDescendant(runDataRoot, file))
    throw new TypeError("Benchmark transport file must be inside its isolated run data root")
  const stat = lstatSync(file)
  if (stat.size <= 0 || stat.size > MAX_TRANSPORT_FILE_BYTES)
    throw new TypeError("Benchmark transport file exceeds its trusted size bound")
  const bytes = readFileSync(file)
  if (bytes.byteLength !== stat.size) throw new TypeError("Benchmark transport file changed while it was read")

  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new TypeError("Benchmark transport file is not valid JSON")
  }
  return WorkflowBenchmarkTransport.freezeProfile({
    authority: "server",
    profile: parsed,
    expectedCampaignID: campaignID,
    expectedRunID: runID,
    now,
  })
}

export const benchmarkTransportNode = makeGlobalNode({
  service: WorkflowBenchmarkTransport.Service,
  layer: Layer.sync(WorkflowBenchmarkTransport.Service, () => {
    const binding = loadBenchmarkTransport(process.env)
    return WorkflowBenchmarkTransport.Service.of(binding === undefined ? {} : { binding })
  }),
  deps: [],
})

function required(environment: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = environment[name]
  if (value === undefined || value.length === 0) throw new TypeError(`${name} is required`)
  return value
}

function canonicalDirectory(input: string, label: string): string {
  const resolved = path.resolve(input)
  if (comparisonKey(resolved) !== comparisonKey(input))
    throw new TypeError(`${label} must be a canonical absolute path`)
  const stat = lstatSync(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError(`${label} must not be a link or reparse point`)
  const real = realpathSync.native(resolved)
  if (comparisonKey(real) !== comparisonKey(resolved)) throw new TypeError(`${label} must not use link aliases`)
  if (path.parse(real).root.toLowerCase() !== "d:\\") throw new TypeError(`${label} must be on the D drive`)
  return real
}

function canonicalFile(input: string, label: string): string {
  const resolved = path.resolve(input)
  if (comparisonKey(resolved) !== comparisonKey(input))
    throw new TypeError(`${label} must be a canonical absolute path`)
  const stat = lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new TypeError(`${label} must not be a link or reparse point`)
  const real = realpathSync.native(resolved)
  if (comparisonKey(real) !== comparisonKey(resolved)) throw new TypeError(`${label} must not use link aliases`)
  return real
}

function strictDescendant(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative.length > 0 && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
}

function comparisonKey(value: string): string {
  return path.normalize(value).toLowerCase()
}
