import { expect, test } from "bun:test"
import { removeClosedStoreFixture, type CleanupRuntime } from "./fixture-cleanup"

function runtime(platform: NodeJS.Platform, remove: CleanupRuntime["remove"]) {
  let elapsed = 0
  let collections = 0
  const waits: number[] = []
  const value: CleanupRuntime = {
    platform,
    remove,
    collect: () => {
      collections++
    },
    now: () => elapsed,
    sleep: async (milliseconds) => {
      waits.push(milliseconds)
      elapsed += milliseconds
    },
  }
  return { value, elapsed: () => elapsed, collections: () => collections, waits }
}

test("Windows closed-store cleanup retries collection and preserves exact removal arguments", async () => {
  let calls = 0
  const fixture = runtime("win32", async (directory, options) => {
    expect(directory).toBe("owned-test-directory")
    expect(options).toEqual({ recursive: true, force: true })
    if (++calls <= 15) throw Object.assign(new Error("busy"), { code: "EBUSY" })
  })
  await removeClosedStoreFixture("owned-test-directory", fixture.value)
  expect(calls).toBe(16)
  expect(fixture.collections()).toBe(16)
  expect(fixture.elapsed()).toBe(375)
})

test("Windows closed-store cleanup still rejects permanent busy handles within its bound", async () => {
  const busy = Object.assign(new Error("busy"), { code: "EBUSY" })
  let calls = 0
  const fixture = runtime("win32", async () => {
    calls++
    throw busy
  })
  await expect(removeClosedStoreFixture("owned-test-directory", fixture.value)).rejects.toBe(busy)
  expect(calls).toBe(80)
  expect(fixture.elapsed()).toBeLessThanOrEqual(2000)
  expect(fixture.collections()).toBe(80)
})

test("closed-store cleanup does not ignore unrelated filesystem errors", async () => {
  const denied = Object.assign(new Error("denied"), { code: "EACCES" })
  const fixture = runtime("win32", async () => {
    throw denied
  })
  await expect(removeClosedStoreFixture("owned-test-directory", fixture.value)).rejects.toBe(denied)
  expect(fixture.collections()).toBe(1)
  expect(fixture.waits).toEqual([])
})

test("non-Windows closed-store cleanup retains the original ten attempts and single collection", async () => {
  const busy = Object.assign(new Error("busy"), { code: "EBUSY" })
  let calls = 0
  const fixture = runtime("linux", async () => {
    calls++
    throw busy
  })
  await expect(removeClosedStoreFixture("owned-test-directory", fixture.value)).rejects.toBe(busy)
  expect(calls).toBe(10)
  expect(fixture.collections()).toBe(1)
  expect(fixture.waits).toEqual(Array(9).fill(25))
})

test("Windows cleanup observes elapsed time as well as the attempt bound", async () => {
  const busy = Object.assign(new Error("busy"), { code: "EBUSY" })
  let elapsed = 0
  let calls = 0
  const fixture = runtime("win32", async () => {
    calls++
    elapsed += 1100
    throw busy
  })
  await expect(removeClosedStoreFixture("owned-test-directory", { ...fixture.value, now: () => elapsed })).rejects.toBe(
    busy,
  )
  expect(calls).toBe(2)
  expect(fixture.waits).toEqual([25])
})
