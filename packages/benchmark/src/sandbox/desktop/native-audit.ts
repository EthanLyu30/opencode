import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { canonicalJson } from "../../campaign/canonical"
import { freeze } from "../../corpus/evaluation-profile"
import { sha256Text } from "../../hash"
import type { DesktopLaunchSpec, DesktopCompatibilityReport, DesktopPlatform } from "./contracts"
import {
  decodeDesktopNativeSnapshot,
  queryDesktopWindows,
  requireDesktopNativeSpec,
  type DesktopNativeSnapshot,
} from "./native-query"
import { readDesktopBindings } from "./bindings"
import { revalidateDesktopSpec, canonicalDesktopPath } from "./compatibility"
import { runDesktopProbe } from "./native-process"
import { withDesktopReadLease } from "./publication"
import { readNativePlatformDiagnostics } from "./platform"
import { boundedDesktopOperation } from "./launch"

export type DesktopNativeDiagnostics = Readonly<{
  checks: DesktopCompatibilityReport["checks"]
  missing: readonly string[]
  productionEndpoint: string | null
  profileEndpoint: string | null
  production_default_compatible: boolean | null
  observationSha256: string
}>
const endpoint = "npipe:////./pipe/home-oc-task24-dd479dockerDesktopEngine"
const unknown = [
  "path_routing_unproved",
  "backend_environment_unproved",
  "registration_reuse_unproved",
  "stop_owned_unproved",
  "settings_mutation_unproved",
  "existing_workload_restart_unproved",
  "automatic_behavior_unproved",
]

export function decodeDesktopCliEndpoint(bytes: Uint8Array) {
  if (bytes.byteLength > 8192) throw new TypeError("TASK24_DESKTOP_CLI_OUTPUT")
  const value = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  )
  if (
    typeof value !== "string" ||
    ![endpoint, "npipe:////./pipe/docker_engine", "npipe:////./pipe/dockerDesktopEngine"].includes(value)
  )
    throw new TypeError("TASK24_DESKTOP_CLI_ENDPOINT")
  return value
}

export function describeDesktopNativeEvidence(
  spec: DesktopLaunchSpec,
  snapshot: DesktopNativeSnapshot,
  cli: { production: string; profile: string },
): DesktopCompatibilityReport {
  decodeDesktopNativeSnapshot(snapshot, spec)
  const production = decodeDesktopCliEndpoint(Buffer.from(JSON.stringify(cli.production))),
    profile = decodeDesktopCliEndpoint(Buffer.from(JSON.stringify(cli.profile)))
  return freeze({
    assurance: "native-static" as const,
    specSha256: sha256Text(canonicalJson(spec)),
    checks: [
      {
        id: "path_routing" as const,
        source: spec.install.asar.path,
        sourceSha256: spec.install.asar.sha256,
        location:
          "entry-cli.main.js home/userData paths are partial; complete frontend/native/service/cache coverage unproved",
        conclusion: "unproved" as const,
      },
      {
        id: "backend_environment" as const,
        source: spec.install.backend.path,
        sourceSha256: spec.install.backend.sha256,
        location: "paths.init.func1 reads home override; launcher/service propagation unproved",
        conclusion: "unproved" as const,
      },
      {
        id: "registration_reuse" as const,
        source: spec.install.backend.path,
        sourceSha256: spec.install.backend.sha256,
        location: "distroName and build 230596 prerequisites match; disk discovery/reimport/migration still unproved",
        conclusion: "unproved" as const,
      },
      {
        id: "stop_owned" as const,
        source: spec.install.asar.path,
        sourceSha256: spec.install.asar.sha256,
        location: "POST /app/quit is candidate only; complete backend/engine/WSL teardown scope unproved",
        conclusion: "unproved" as const,
      },
      {
        id: "cli_default" as const,
        source: spec.install.cli.path,
        sourceSha256: spec.install.cli.sha256,
        location: canonicalJson({
          query:
            "--config <isolated-nonexistent-probe> --context default context inspect default --format {{json .Endpoints.docker.Host}}",
          production,
          profile,
        }),
        conclusion: "proved" as const,
      },
    ],
    missing: [...unknown, ...(profile !== endpoint ? ["profile_endpoint_mismatch"] : [])],
  })
}

export function readDesktopNativeDiagnostics(platform: DesktopPlatform) {
  return readNativePlatformDiagnostics(platform)
}

export function unprovedDesktopNativeEvidence(spec: DesktopLaunchSpec, reason: string) {
  const checks = (
    ["path_routing", "backend_environment", "registration_reuse", "stop_owned", "cli_default"] as const
  ).map((id) => ({
    id,
    source: id === "cli_default" ? spec.install.cli.path : spec.install.asar.path,
    sourceSha256: id === "cli_default" ? spec.install.cli.sha256 : spec.install.asar.sha256,
    location: "native preconditions not established",
    conclusion: "unproved" as const,
  }))
  const report = freeze({
    assurance: "native-static" as const,
    specSha256: sha256Text(canonicalJson(spec)),
    checks,
    missing: [...unknown, "cli_default_unproved", reason],
  })
  const diagnostics: DesktopNativeDiagnostics = freeze({
    checks,
    missing: report.missing,
    productionEndpoint: null,
    profileEndpoint: null,
    production_default_compatible: null,
    observationSha256: sha256Text(canonicalJson({ missing: report.missing })),
  })
  return { report, diagnostics }
}

export async function collectDesktopNativeAudit(raw: DesktopLaunchSpec, external?: AbortSignal) {
  if (external?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
  const signal = AbortSignal.any([external ?? new AbortController().signal, AbortSignal.timeout(45000)])
  const collect = async () => {
    const spec = requireDesktopNativeSpec(raw)
    const bindings = await readDesktopBindings(path.resolve(import.meta.dir, "../../../../.."), signal)
    if (
      bindings.sourceSha256 !== spec.sourceSha256 ||
      bindings.specSha256 !== spec.specSha256 ||
      bindings.planSha256 !== spec.planSha256
    )
      throw new TypeError("TASK24_DESKTOP_DOCUMENT_BINDING")
    await revalidateDesktopSpec(spec)
    const snapshot = await queryDesktopWindows(spec, signal)
    const cli = await withDesktopReadLease(spec.install.cli, async (leaseSignal) => {
      const probeSignal = AbortSignal.any([signal, leaseSignal])
      const temp = canonicalDesktopPath(process.env.TEMP ?? "")
      const query = async (host: string) => {
        const config = path.join(temp, "desktop-cli-" + crypto.randomUUID())
        if (await fs.exists(config)) throw new TypeError("TASK24_DESKTOP_PROBE_EXISTS")
        const value = await runDesktopProbe({
          exe: spec.install.cli.path,
          argv: [
            "--config",
            config,
            "--context",
            "default",
            "context",
            "inspect",
            "default",
            "--format",
            "{{json .Endpoints.docker.Host}}",
          ],
          timeoutMs: 5000,
          stdoutLimit: 8192,
          stderrLimit: 8192,
          signal: probeSignal,
          env: {
            DOCKER_CONFIG: config,
            DOCKER_CONTEXT: "default",
            DOCKER_HOST: host,
            DOCKER_TLS_VERIFY: "",
            DOCKER_CERT_PATH: "",
            BUILDX_BUILDER: "",
            BUILDKIT_HOST: "",
          },
        })
        if (value.exitCode || value.stderr.length || (await fs.exists(config)))
          throw new TypeError("TASK24_DESKTOP_CLI_QUERY")
        return decodeDesktopCliEndpoint(value.stdout)
      }
      return { production: await query(""), profile: await query(endpoint) }
    })
    await revalidateDesktopSpec(spec)
    if (
      canonicalJson(bindings) !==
        canonicalJson(await readDesktopBindings(path.resolve(import.meta.dir, "../../../../.."), signal)) ||
      signal.aborted
    )
      throw new TypeError("TASK24_DESKTOP_NATIVE_DRIFT")
    const report = describeDesktopNativeEvidence(spec, snapshot, cli)
    const diagnostics: DesktopNativeDiagnostics = freeze({
      checks: report.checks,
      missing: report.missing,
      productionEndpoint: cli.production,
      profileEndpoint: cli.profile,
      production_default_compatible: cli.production === cli.profile,
      observationSha256: sha256Text(canonicalJson(snapshot)),
    })
    return { report, diagnostics }
  }
  return boundedDesktopOperation(collect(), 45000, signal)
}
