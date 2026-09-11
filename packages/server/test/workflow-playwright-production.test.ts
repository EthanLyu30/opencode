import { afterAll, describe, expect, test } from "bun:test"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { PlaywrightCapture } from "../src/workflow/playwright"

const suiteRoot = "D:\\OpenCode-Task23-Final\\playwright-production-policy"

afterAll(async () => {
  await fs.rm(suiteRoot, { recursive: true, force: true })
})

describe("PlaywrightCapture production root policy", () => {
  test("rejects a lexical browser-runtime junction before accepting production roots", async () => {
    await using fixture = await rootsFixture("constructor-alias")
    const outside = path.join(fixture.root, "outside-runtime")
    const alias = path.join(fixture.root, "runtime-alias")
    await fs.mkdir(outside)
    await fs.symlink(outside, alias, process.platform === "win32" ? "junction" : "dir")

    expect(() =>
      PlaywrightCapture.productionRuntime({
        browserRoot: alias,
        tempRoot: fixture.cache,
        browserExecutablePath: fixture.executable,
        browserRuntimePolicy: () => undefined,
        browserCachePolicy: () => undefined,
      }),
    ).toThrow(/aliases|canonical/i)
  })

  test("rejects a Chromium executable outside the protected browser-runtime root before launch", async () => {
    await using fixture = await rootsFixture("external-executable")
    const outsideExecutable = path.join(fixture.root, "outside-chrome.exe")
    await fs.writeFile(outsideExecutable, "outside")
    let launchCalls = 0

    expect(() =>
      PlaywrightCapture.productionRuntime({
        browserRoot: fixture.runtime,
        tempRoot: fixture.cache,
        browserExecutablePath: outsideExecutable,
        browserRuntimePolicy: () => undefined,
        browserCachePolicy: () => undefined,
        browserType: {
          launch: async () => {
            launchCalls++
            return successfulBrowser()
          },
        },
      }),
    ).toThrow(/executable.*runtime root/i)
    expect(launchCalls).toBe(0)
  })

  test("passes the exact verified Chromium executable to the launch boundary", async () => {
    await using fixture = await rootsFixture("pinned-executable")
    let launchOptions: PlaywrightCapture.LaunchOptions | undefined
    const runtime = PlaywrightCapture.productionRuntime({
      browserRoot: fixture.runtime,
      tempRoot: fixture.cache,
      browserExecutablePath: fixture.executable,
      browserRuntimePolicy: () => undefined,
      browserCachePolicy: () => undefined,
      browserType: {
        launch: async (options) => {
          launchOptions = options
          return successfulBrowser()
        },
      },
    })

    await runtime.capture(captureInput())
    expect(launchOptions).toMatchObject({
      executablePath: fixture.executable,
      downloadsPath: fixture.cache,
    })
    await runtime.close()
  })

  test("revalidates the exact Chromium executable identity before launch", async () => {
    await using fixture = await rootsFixture("replaced-executable")
    let launchCalls = 0
    const runtime = PlaywrightCapture.productionRuntime({
      browserRoot: fixture.runtime,
      tempRoot: fixture.cache,
      browserExecutablePath: fixture.executable,
      browserRuntimePolicy: () => undefined,
      browserCachePolicy: () => undefined,
      browserType: {
        launch: async () => {
          launchCalls++
          throw new Error("browser launch must not run")
        },
      },
    })
    const parked = `${fixture.executable}.parked`
    await fs.rename(fixture.executable, parked)
    await fs.writeFile(fixture.executable, "replacement chromium")

    await expect(runtime.capture(captureInput())).rejects.toThrow(/executable identity changed/)
    expect(launchCalls).toBe(0)

    await fs.rm(fixture.executable)
    await fs.rename(parked, fixture.executable)
    await runtime.close()
  })

  test("revalidates a replaced browser runtime before launch and writes no cache bytes", async () => {
    await using fixture = await rootsFixture("runtime-replacement")
    const runtimePolicy = identityPolicy(fixture.runtime)
    let launchCalls = 0
    const runtime = PlaywrightCapture.productionRuntime({
      browserRoot: fixture.runtime,
      tempRoot: fixture.cache,
      browserExecutablePath: fixture.executable,
      browserRuntimePolicy: runtimePolicy,
      browserCachePolicy: identityPolicy(fixture.cache),
      browserType: {
        launch: async () => {
          launchCalls++
          throw new Error("browser launch must not run")
        },
      },
    })
    const parked = `${fixture.runtime}-parked`
    await fs.rename(fixture.runtime, parked)
    await fs.mkdir(fixture.runtime)

    await expect(runtime.capture(captureInput())).rejects.toThrow(/identity changed/)
    expect(launchCalls).toBe(0)
    expect(await fs.readdir(fixture.cache)).toEqual([])

    await fs.rmdir(fixture.runtime)
    await fs.rename(parked, fixture.runtime)
    await runtime.close()
  })

  test("revalidates browser ACL policy before launch and invokes no browser boundary", async () => {
    await using fixture = await rootsFixture("acl-change")
    let valid = true
    let launchCalls = 0
    const runtime = PlaywrightCapture.productionRuntime({
      browserRoot: fixture.runtime,
      tempRoot: fixture.cache,
      browserExecutablePath: fixture.executable,
      browserRuntimePolicy: () => {
        if (!valid) throw new TypeError("browser runtime ACL changed")
      },
      browserCachePolicy: () => undefined,
      browserType: {
        launch: async () => {
          launchCalls++
          throw new Error("browser launch must not run")
        },
      },
    })
    valid = false

    await expect(runtime.capture(captureInput())).rejects.toThrow("browser runtime ACL changed")
    expect(launchCalls).toBe(0)
    expect(await fs.readdir(fixture.cache)).toEqual([])

    valid = true
    await runtime.close()
  })

  test("revalidates browser-cache ACL policy before launch and invokes no browser boundary", async () => {
    await using fixture = await rootsFixture("cache-acl-change")
    let valid = true
    let launchCalls = 0
    const runtime = PlaywrightCapture.productionRuntime({
      browserRoot: fixture.runtime,
      tempRoot: fixture.cache,
      browserExecutablePath: fixture.executable,
      browserRuntimePolicy: () => undefined,
      browserCachePolicy: () => {
        if (!valid) throw new TypeError("browser cache ACL changed")
      },
      browserType: {
        launch: async () => {
          launchCalls++
          throw new Error("browser launch must not run")
        },
      },
    })
    valid = false

    await expect(runtime.capture(captureInput())).rejects.toThrow("browser cache ACL changed")
    expect(launchCalls).toBe(0)
    expect(await fs.readdir(fixture.cache)).toEqual([])

    valid = true
    await runtime.close()
  })

  test("revalidates an ancestor junction before launch and writes no cache bytes", async () => {
    await using fixture = await rootsFixture("ancestor-junction")
    let launchCalls = 0
    const runtime = PlaywrightCapture.productionRuntime({
      browserRoot: fixture.runtime,
      tempRoot: fixture.cache,
      browserExecutablePath: fixture.executable,
      browserRuntimePolicy: () => undefined,
      browserCachePolicy: () => undefined,
      browserType: {
        launch: async () => {
          launchCalls++
          throw new Error("browser launch must not run")
        },
      },
    })
    const parked = `${fixture.deployment}-parked`
    await fs.rename(fixture.deployment, parked)
    await fs.symlink(parked, fixture.deployment, process.platform === "win32" ? "junction" : "dir")

    await expect(runtime.capture(captureInput())).rejects.toThrow(/aliases|canonical/i)
    expect(launchCalls).toBe(0)
    expect(await fs.readdir(fixture.cache)).toEqual([])

    await fs.unlink(fixture.deployment)
    await fs.rename(parked, fixture.deployment)
    await runtime.close()
  })

  test("revalidates both roots after browser launch before creating a context", async () => {
    await using fixture = await rootsFixture("post-launch")
    let valid = true
    let contextCalls = 0
    const runtime = PlaywrightCapture.productionRuntime({
      browserRoot: fixture.runtime,
      tempRoot: fixture.cache,
      browserExecutablePath: fixture.executable,
      browserRuntimePolicy: () => {
        if (!valid) throw new TypeError("browser runtime changed during launch")
      },
      browserCachePolicy: () => undefined,
      browserType: {
        launch: async () => {
          valid = false
          return {
            newContext: async () => {
              contextCalls++
              throw new Error("context must not be created")
            },
            close: async () => undefined,
          }
        },
      },
    })

    await expect(runtime.capture(captureInput())).rejects.toThrow("browser runtime changed during launch")
    expect(contextCalls).toBe(0)

    valid = true
    await runtime.close()
  })

  test("revalidates both roots before closing a used context", async () => {
    await using fixture = await rootsFixture("capture-end")
    let cacheValid = true
    let contextCloseCalls = 0
    let browserCloseCalls = 0
    const runtime = PlaywrightCapture.productionRuntime({
      browserRoot: fixture.runtime,
      tempRoot: fixture.cache,
      browserExecutablePath: fixture.executable,
      browserRuntimePolicy: () => undefined,
      browserCachePolicy: () => {
        if (!cacheValid) throw new TypeError("browser cache changed before context close")
      },
      browserType: {
        launch: async () => ({
          newContext: async () => ({
            route: async () => undefined,
            routeWebSocket: async () => undefined,
            newPage: async () => ({
              goto: async () => undefined,
              waitForSelector: async () => undefined,
              evaluate: async () => undefined,
              screenshot: async () => {
                cacheValid = false
                return Uint8Array.of(137, 80, 78, 71)
              },
            }),
            close: async () => {
              contextCloseCalls++
            },
          }),
          close: async () => {
            browserCloseCalls++
          },
        }),
      },
    })

    await expect(runtime.capture(captureInput())).rejects.toThrow("browser cache changed before context close")
    expect(contextCloseCalls).toBe(1)

    await expect(runtime.close()).rejects.toThrow("browser cache changed before context close")
    expect(browserCloseCalls).toBe(1)
  })

  test("closes an owned browser once when a changed root rejects shutdown", async () => {
    await using fixture = await rootsFixture("runtime-close")
    let valid = true
    let browserCloseCalls = 0
    const runtime = PlaywrightCapture.productionRuntime({
      browserRoot: fixture.runtime,
      tempRoot: fixture.cache,
      browserExecutablePath: fixture.executable,
      browserRuntimePolicy: () => {
        if (!valid) throw new TypeError("browser root changed before shutdown")
      },
      browserCachePolicy: () => undefined,
      browserType: {
        launch: async () => ({
          newContext: async () => ({
            route: async () => undefined,
            routeWebSocket: async () => undefined,
            newPage: async () => ({
              goto: async () => undefined,
              waitForSelector: async () => undefined,
              evaluate: async () => undefined,
              screenshot: async () => Uint8Array.of(137, 80, 78, 71),
            }),
            close: async () => undefined,
          }),
          close: async () => {
            browserCloseCalls++
          },
        }),
      },
    })
    await runtime.capture(captureInput())
    valid = false

    await expect(runtime.close()).rejects.toThrow("browser root changed before shutdown")
    expect(browserCloseCalls).toBe(1)
    valid = true
    await runtime.close()
    expect(browserCloseCalls).toBe(1)
  })

  test("revalidates roots after context shutdown completes", async () => {
    await using fixture = await rootsFixture("post-context-close")
    let cacheValid = true
    const runtime = PlaywrightCapture.productionRuntime({
      browserRoot: fixture.runtime,
      tempRoot: fixture.cache,
      browserExecutablePath: fixture.executable,
      browserRuntimePolicy: () => undefined,
      browserCachePolicy: () => {
        if (!cacheValid) throw new TypeError("browser cache changed during context close")
      },
      browserType: {
        launch: async () => ({
          newContext: async () => ({
            route: async () => undefined,
            routeWebSocket: async () => undefined,
            newPage: async () => ({
              goto: async () => undefined,
              waitForSelector: async () => undefined,
              evaluate: async () => undefined,
              screenshot: async () => Uint8Array.of(137, 80, 78, 71),
            }),
            close: async () => {
              cacheValid = false
            },
          }),
          close: async () => undefined,
        }),
      },
    })

    await expect(runtime.capture(captureInput())).rejects.toThrow("browser cache changed during context close")

    cacheValid = true
    await runtime.close()
  })

  test("aggregates a capture failure with a bounded cleanup failure", async () => {
    await using fixture = await rootsFixture("capture-cleanup-failure")
    let contextCloseCalls = 0
    const runtime = PlaywrightCapture.productionRuntime({
      browserRoot: fixture.runtime,
      tempRoot: fixture.cache,
      browserExecutablePath: fixture.executable,
      browserRuntimePolicy: () => undefined,
      browserCachePolicy: () => undefined,
      browserType: {
        launch: async () => ({
          newContext: async () => ({
            route: async () => undefined,
            routeWebSocket: async () => undefined,
            newPage: async () => ({
              goto: async () => {
                throw new Error("navigation failed")
              },
              waitForSelector: async () => undefined,
              evaluate: async () => undefined,
              screenshot: async () => Uint8Array.of(137, 80, 78, 71),
            }),
            close: async () => {
              contextCloseCalls++
              throw new Error("context close failed")
            },
          }),
          close: async () => undefined,
        }),
      },
    })

    const cause = await runtime.capture(captureInput()).then(
      () => undefined,
      (failure) => failure,
    )
    expect(cause).toBeInstanceOf(AggregateError)
    expect((cause as AggregateError).errors.map(failureMessage)).toEqual(["navigation failed", "context close failed"])
    expect(contextCloseCalls).toBe(1)
    await runtime.close()
  })
})

function captureInput(): PlaywrightCapture.CaptureInput {
  return {
    url: "http://127.0.0.1:3210/",
    viewport: { width: 390, height: 844 },
    readySelector: "#ready",
    allowedOrigins: [],
    signal: new AbortController().signal,
  }
}

function successfulBrowser(): PlaywrightCapture.Browser {
  return {
    newContext: async () => ({
      route: async () => undefined,
      routeWebSocket: async () => undefined,
      newPage: async () => ({
        goto: async () => undefined,
        waitForSelector: async () => undefined,
        evaluate: async () => undefined,
        screenshot: async () => Uint8Array.of(137, 80, 78, 71),
      }),
      close: async () => undefined,
    }),
    close: async () => undefined,
  }
}

function failureMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

function identityPolicy(root: string) {
  const expected = identity(root)
  return (candidate: string) => {
    if (candidate !== root || identity(candidate) !== expected) throw new TypeError("browser root identity changed")
  }
}

function identity(root: string) {
  const stat = fsSync.lstatSync(root, { bigint: true })
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
}

async function rootsFixture(name: string) {
  await fs.mkdir(suiteRoot, { recursive: true })
  const root = await fs.realpath(await fs.mkdtemp(path.join(suiteRoot, `${name}-`)))
  const deployment = path.join(root, "deployment")
  const runtime = path.join(deployment, "runtime", "playwright")
  const cache = path.join(deployment, "cache", "browser")
  await fs.mkdir(runtime, { recursive: true })
  await fs.mkdir(cache, { recursive: true })
  const executable = path.join(runtime, "chromium-1217", "chrome.exe")
  await fs.mkdir(path.dirname(executable), { recursive: true })
  await fs.writeFile(executable, "test chromium")
  return {
    root,
    deployment,
    runtime,
    cache,
    executable,
    async [Symbol.asyncDispose]() {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}
