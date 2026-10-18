import { sha256Text } from "../../hash"
import { canonicalJson } from "../../campaign/canonical"
import type { DesktopPlatform } from "./contracts"

const native = new WeakSet<object>()
export function isNativeDesktopPlatform(platform: DesktopPlatform) {
  return native.has(platform)
}

/** No guessed start/stop implementation: closed-backend propagation and reuse remain unproved. */
export function makeWindowsDesktopPlatform(): DesktopPlatform {
  const platform: DesktopPlatform = {
    async audit(spec) {
      return {
        assurance: "native-static",
        specSha256: sha256Text(canonicalJson(spec)),
        checks: (
          ["path_routing", "backend_environment", "registration_reuse", "stop_owned", "cli_default"] as const
        ).map((id) => ({
          id,
          source: spec.install.asar.path,
          sourceSha256: spec.install.asar.sha256,
          location: "4.79 frontend overrides observed; backend/VM/stop and CLI behavior not attested",
          conclusion: "unproved" as const,
        })),
        missing: [
          "backend_environment_unproved",
          "registration_reuse_unproved",
          "stop_owned_unproved",
          "path_routing_unproved",
          "cli_default_unproved",
        ],
      }
    },
    async observe() {
      throw new TypeError("TASK24_DESKTOP_NATIVE_RULES_UNPROVED")
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
