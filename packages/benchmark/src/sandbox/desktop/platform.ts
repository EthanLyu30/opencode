import type { DesktopPlatform } from "./contracts"
import { collectDesktopNativeAudit, unprovedDesktopNativeEvidence, type DesktopNativeDiagnostics } from "./native-audit"
import { queryDesktopWindows } from "./native-query"

const native = new WeakSet<object>()
const diagnostics = new WeakMap<DesktopPlatform, DesktopNativeDiagnostics>()
export function isNativeDesktopPlatform(platform: DesktopPlatform) {
  return native.has(platform)
}
export function readNativePlatformDiagnostics(platform: DesktopPlatform) {
  return diagnostics.get(platform)
}

/** No guessed start/stop implementation: closed-backend propagation and reuse remain unproved. */
export function makeWindowsDesktopPlatform(): DesktopPlatform {
  const platform: DesktopPlatform = {
    async audit(spec, signal) {
      if (spec.schemaVersion !== 1) throw new TypeError("TASK24_DESKTOP_NATIVE_RULES_UNPROVED")
      diagnostics.delete(platform)
      if (signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
      try {
        const result = await collectDesktopNativeAudit(spec, signal)
        if (signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
        diagnostics.set(platform, result.diagnostics)
        return result.report
      } catch (error) {
        if (signal?.aborted) throw new TypeError("TASK24_DESKTOP_CANCELLED")
        const result = unprovedDesktopNativeEvidence(
          spec,
          error instanceof Error ? error.message : "TASK24_DESKTOP_NATIVE_AUDIT",
        )
        diagnostics.set(platform, result.diagnostics)
        return result.report
      }
    },
    async observe(spec, signal) {
      if (spec.schemaVersion !== 1) throw new TypeError("TASK24_DESKTOP_NATIVE_RULES_UNPROVED")
      const snapshot = await queryDesktopWindows(spec, signal ?? new AbortController().signal)
      const runningDocker =
        snapshot.processes.some((p) => p.role !== "service") || snapshot.pipes.some((p) => p.present)
      const runningWsl = snapshot.runningWsl.length > 0
      return { phase: runningDocker || runningWsl ? "running" : "idle", sid: snapshot.sid, runningDocker, runningWsl }
    },
    async start() {
      throw new TypeError("TASK24_DESKTOP_NATIVE_RULES_UNPROVED")
    },
    async stop() {
      throw new TypeError("TASK24_DESKTOP_NATIVE_RULES_UNPROVED")
    },
  }
  native.add(platform)
  return Object.freeze(platform)
}
