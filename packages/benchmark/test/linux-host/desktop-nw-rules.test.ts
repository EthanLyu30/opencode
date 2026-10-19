import { expect, test } from "bun:test"
import { desktopFeature } from "./desktop-native-fixture"
import { nativeRuleFixture } from "./desktop-nw-fixture"

const api = await desktopFeature<typeof import("../../src/sandbox/desktop/native-v2/rules")>("native-v2/rules")

test("NW1 boundary: partial_record_never_enables_native", () => {
  expect(api.assessNativePrerequisites).toBeFunction()
  const result = api.assessNativePrerequisites!()
  expect(result.status).toBe("blocked")
  for (const missing of [
    "offline_reader_unavailable",
    "workload_layout_unproved",
    "workload_handoff_unproved",
    "stop_owned_unproved",
  ])
    expect(result.missing).toContain(missing)
  expect(result.evidence.length).toBeGreaterThan(0)
  for (const evidence of result.evidence) {
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(evidence.sha256).not.toBe("0".repeat(64))
    expect(evidence.source.length).toBeGreaterThan(0)
    expect(evidence.location.length).toBeGreaterThan(0)
  }
})

test("fixture_descriptor_cannot_select_native", () => {
  expect(api.selectNativeRuleDescriptor).toBeFunction()
  const f = nativeRuleFixture()
  const fixture = f.descriptor
  for (const input of ["0".repeat(64), fixture.installSha256, "", "not-a-sha256", fixture.installSha256.toUpperCase()])
    expect(api.selectNativeRuleDescriptor!(input).kind).toBe("blocked")
  // Even a complete-looking or incomplete JSON object cannot register a rule.
  for (const key of ["readerSha256", "handoffSha256", "settingsSha256"] as const) {
    const { [key]: omitted, ...partial } = fixture
    expect(api.selectNativeRuleDescriptor!(partial as unknown as string).kind).toBe("blocked")
  }
  expect(api.selectNativeRuleDescriptor!(fixture as unknown as string).kind).toBe("blocked")
  expect(api.selectNativeRuleDescriptor!(f.untrusted as unknown as string).kind).toBe("blocked")
  expect(f.calls.proofReads).toBe(0)
  expect(api.assessNativePrerequisites!().status).toBe("blocked")
})

test("matching the real static sample still supplies no native descriptor", () => {
  expect(api.selectNativeRuleDescriptor).toBeFunction()
  // Independently captured canonical manifest digest, not the selector's own expected value.
  const gate = api.selectNativeRuleDescriptor!("d731b751f4f5afed81b46923ad5c0f381000988089d5b2474538e5b6f9de3f5f")
  expect(gate.kind).toBe("blocked")
  if (gate.kind !== "blocked") throw Error("NW1_UNEXPECTED_DESCRIPTOR")
  expect(gate.code).toBe("TASK24_DESKTOP_NATIVE_RULES_UNPROVED")
  for (const missing of ["offline_reader_unavailable", "workload_layout_unproved", "workload_handoff_unproved"])
    expect(gate.missing).toContain(missing)
  expect("value" in gate).toBe(false)
  expect(gate.missing).not.toContain("native_installation_unregistered")
})

test("evidence and refusal diagnostics cannot be mutated into readiness", () => {
  expect(api.assessNativePrerequisites).toBeFunction()
  const first = api.assessNativePrerequisites!()
  expect(Reflect.set(first, "status", "ready_for_implementation")).toBe(false)
  expect(Reflect.set(first.missing, "length", 0)).toBe(false)
  expect(Reflect.set(first.evidence[0]!, "sha256", "0".repeat(64))).toBe(false)
  const clone = JSON.parse(JSON.stringify(first))
  clone.status = "ready_for_implementation"
  clone.missing = []
  expect(api.selectNativeRuleDescriptor!(clone).kind).toBe("blocked")
  expect(api.assessNativePrerequisites!().status).toBe("blocked")
})
