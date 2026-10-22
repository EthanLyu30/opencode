import fs from "node:fs/promises"

export interface CleanupRuntime {
  readonly platform: NodeJS.Platform
  readonly remove: (directory: string, options: { recursive: true; force: true }) => Promise<void>
  readonly collect: () => void
  readonly now: () => number
  readonly sleep: (milliseconds: number) => Promise<void>
}

const runtime: CleanupRuntime = {
  platform: process.platform,
  remove: fs.rm,
  collect: () => {
    Bun.gc(true)
  },
  now: () => performance.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

/** Test-fixture cleanup only; no RunStore or recovery behavior is changed. */
export async function removeClosedStoreFixture(directory: string, io: CleanupRuntime = runtime) {
  const windows = io.platform === "win32"
  const deadline = io.now() + 2000
  io.collect()
  for (let attempt = 0; ; attempt++) {
    try {
      await io.remove(directory, { recursive: true, force: true })
      return
    } catch (cause) {
      if (!isBusy(cause) || attempt >= (windows ? 79 : 9)) throw cause
      if (!windows) {
        await io.sleep(25)
        continue
      }
      if (io.now() >= deadline) throw cause
      io.collect()
      const remaining = deadline - io.now()
      if (remaining <= 0) throw cause
      await io.sleep(Math.min(25, remaining))
    }
  }
}

function isBusy(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "EBUSY"
}
