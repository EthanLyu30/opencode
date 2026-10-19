import { sha256Text } from "../../src/hash"

/** Untrusted rule data only: no executable, callback, registration or native capability. */
export function nativeRuleFixture() {
  const descriptor = {
    installSha256: sha256Text("synthetic installation"),
    readerSha256: sha256Text("synthetic reader"),
    layoutSha256: sha256Text("synthetic layout"),
    settingsSha256: sha256Text("synthetic settings"),
    lifecycleSha256: sha256Text("synthetic lifecycle"),
    handoffSha256: sha256Text("synthetic handoff"),
    evidenceSha256: sha256Text("synthetic evidence"),
  }
  const calls = { proofReads: 0 }
  const untrusted = Object.fromEntries(Object.entries(descriptor))
  Object.defineProperty(untrusted, "installSha256", {
    get() {
      calls.proofReads++
      return descriptor.installSha256
    },
  })
  return { descriptor, untrusted, calls }
}
