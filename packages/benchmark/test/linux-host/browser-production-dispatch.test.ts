import { expect, test } from "bun:test"
import { attachBrowserIsolationDispatch } from "../../src/sandbox/capability"

test("browser production dispatch rejects forged bindings without invoking the native supervisor", async () => {
  const module = await import("../../src/sandbox/host-isolation/windows-browser-dispatch")
  const create = Reflect.get(module, "createWindowsBrowserDispatch")
  expect(typeof create).toBe("function")
  await expect(create({ root: "C:\\forbidden" })).rejects.toThrow("TASK24_BROWSER_DISPATCH_INPUT")
})

test("production browser wiring cannot turn a caller supplied adapter into trusted authority", () => {
  expect(() =>
    attachBrowserIsolationDispatch({
      adapter: {} as never,
      browser: async () => {
        throw Error("must not execute")
      },
    }),
  ).toThrow("TASK24_BROWSER_OS_ISOLATION_REQUIRED")
})
