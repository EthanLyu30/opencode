import { expect, test } from "bun:test"
import { decodeWindowsBrowserNativeResult } from "../../src/sandbox/host-isolation/windows"

const browser = "D:\\OpenCode-Benchmark\\Task24\\tmp\\browser-unit\\browser\\chrome.exe"
const names = ["xr", "cdm", "net", "odm", "prnc", "pxy"].map(
  (type) => "cr.sb." + type + "A60B6F16BB6AB11F667DD73D2ABEE64218355D53",
)
const result = () => ({
  started: true,
  exitCode: 0,
  stdout: "b2s=",
  stderr: "",
  truncated: false,
  containment: {
    processTreeEnded: true,
    dynamicNetworkPolicy: true,
    cleanupCompleted: true,
    persistentNetworkPolicy: true,
    persistentPolicyRetired: true,
    policyJournal: "D:\\OpenCode-Benchmark\\Task24\\tmp\\browser-unit\\network-policy.intent.json",
    browserPath: browser,
    renderers: [{ pid: 741, appContainer: false, restricted: true, integrity: 0 }],
    metadataRegistrations: names.map((name, index) => ({
      name,
      sid: `S-1-15-2-1-2-3-4-5-6-${index + 7}`,
      defaultPathAbsent: true,
      unregistered: true,
    })),
  },
})
async function decode(raw: unknown, stdoutLimit = 1024) {
  return decodeWindowsBrowserNativeResult(raw, { browser, stdoutLimit, stderrLimit: 1024 })
}

test("browser evidence requires observed renderer sandbox, not merely a successful broker exit", async () => {
  const valid = await decode(result())
  expect(Buffer.from(valid.execution.stdout).toString()).toBe("ok")
  expect(valid.containment.renderers).toEqual([{ pid: 741, appContainer: false, restricted: true, integrity: 0 }])
  for (const renderers of [
    [],
    [{ pid: 741, appContainer: false, restricted: false, integrity: 0 }],
    [{ pid: 741, appContainer: false, restricted: true, integrity: 8192 }],
    [
      { pid: 741, appContainer: false, restricted: true, integrity: 0 },
      { pid: 742, appContainer: false, restricted: false, integrity: 0 },
    ],
    [
      { pid: 741, appContainer: false, restricted: true, integrity: 0 },
      { pid: 741, appContainer: false, restricted: true, integrity: 0 },
    ],
  ]) {
    const value = result()
    value.containment.renderers = renderers
    await expect(decode(value)).rejects.toThrow("TASK24_BROWSER_NATIVE_PROTOCOL")
  }
})

test("browser evidence rejects missing cleanup, a different clone, and unowned metadata", async () => {
  for (const mutate of [
    (value: ReturnType<typeof result>) => {
      value.containment.processTreeEnded = false
    },
    (value: ReturnType<typeof result>) => {
      value.containment.dynamicNetworkPolicy = false
    },
    (value: ReturnType<typeof result>) => {
      value.containment.cleanupCompleted = false
    },
    (value: ReturnType<typeof result>) => {
      value.containment.persistentNetworkPolicy = false
    },
    (value: ReturnType<typeof result>) => {
      value.containment.persistentPolicyRetired = false
    },
    (value: ReturnType<typeof result>) => {
      value.containment.policyJournal = "C:\\policy.json"
    },
    (value: ReturnType<typeof result>) => {
      value.containment.browserPath += ".other"
    },
    (value: ReturnType<typeof result>) => {
      value.containment.metadataRegistrations.pop()
    },
    (value: ReturnType<typeof result>) => {
      value.containment.metadataRegistrations[0]!.name = "unrelated"
    },
    (value: ReturnType<typeof result>) => {
      value.containment.metadataRegistrations[0]!.unregistered = false
    },
    (value: ReturnType<typeof result>) => {
      value.containment.metadataRegistrations[0]!.defaultPathAbsent = false
    },
    (value: ReturnType<typeof result>) => {
      value.containment.metadataRegistrations[0]!.sid = "S-1-5-18"
    },
  ]) {
    const value = result()
    mutate(value)
    await expect(decode(value)).rejects.toThrow("TASK24_BROWSER_NATIVE_PROTOCOL")
  }
})

test("browser native output enforces canonical base64, exact budgets, and strict fields", async () => {
  expect((await decode(result(), 2)).execution.stdout.length).toBe(2)
  await expect(decode(result(), 1)).rejects.toThrow("TASK24_BROWSER_NATIVE_PROTOCOL")
  await expect(decode({ ...result(), stdout: "b2t=" })).rejects.toThrow("TASK24_BROWSER_NATIVE_PROTOCOL")
  await expect(decode({ ...result(), sandboxEnabled: true })).rejects.toThrow("TASK24_BROWSER_NATIVE_PROTOCOL")
})

test("prestart browser cancellation cannot carry forged page output or renderer observations", async () => {
  const early = {
    ...result(),
    started: false,
    exitCode: 130,
    stdout: "",
    stderr: "",
    containment: {
      ...result().containment,
      renderers: [],
      metadataRegistrations: [],
      dynamicNetworkPolicy: false,
      persistentNetworkPolicy: false,
      policyJournal: "",
    },
  }
  expect((await decode(early)).execution).toMatchObject({ started: false, exitCode: 130 })
  const afterSetup = {
    ...early,
    containment: {
      ...early.containment,
      metadataRegistrations: result().containment.metadataRegistrations,
      dynamicNetworkPolicy: true,
      persistentNetworkPolicy: true,
      policyJournal: result().containment.policyJournal,
    },
  }
  expect((await decode(afterSetup)).execution).toMatchObject({ started: false, exitCode: 130 })
  for (const invalid of [
    { ...early, stdout: "b2s=" },
    { ...early, stderr: "b2s=" },
    { ...early, truncated: true },
    { ...early, containment: { ...early.containment, renderers: result().containment.renderers } },
    { ...early, containment: { ...early.containment, dynamicNetworkPolicy: true } },
    { ...afterSetup, containment: { ...afterSetup.containment, dynamicNetworkPolicy: false } },
  ])
    await expect(decode(invalid)).rejects.toThrow("TASK24_BROWSER_NATIVE_PROTOCOL")
})
