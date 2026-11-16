export * as BenchmarkAclNative from "./benchmark-acl-native"

import { Worker } from "node:worker_threads"
import source from "./benchmark-acl-native-worker.js" with { type: "text" }

let completedScratch: SharedArrayBuffer | undefined

/** No subprocess, shell, generated code on disk, permission change or network access. */
export function collect(
  target: string,
  launch?: (data: { readonly target: string; readonly shared: SharedArrayBuffer }) => Worker,
  context?: { readonly profile: string },
) {
  const deadline = performance.now() + 5000
  const shared = completedScratch ?? new SharedArrayBuffer(16 + 1048576)
  completedScratch = undefined
  // This is scratch reuse, never an ACL result cache. A previous worker has
  // published completion only AFTER closing its native handles and libraries.
  new Uint8Array(shared).fill(0)
  const header = new Int32Array(shared, 0, 4)
  // Bun's text loader embeds this asset in compiled executables as well.
  const workerSource: unknown = source
  if (typeof workerSource !== "string") throw new TypeError("TASK24_NATIVE_ACL_ASSET")
  const data = { target, shared, ...(context ? { profile: context.profile } : {}) }
  const worker = launch ? launch(data) : new Worker(workerSource, { eval: true, workerData: data })
  // Errors before the worker's own guarded entry leave the header incomplete:
  // the same fixed deadline fails closed rather than accepting empty output.
  worker.on("error", () => {})
  worker.unref()
  let completed = false
  try {
    while (Atomics.load(header, 0) === 0) {
      const remaining = deadline - performance.now()
      if (remaining <= 0) break
      Atomics.wait(header, 0, 0, remaining)
    }
    const status = Atomics.load(header, 0)
    if (performance.now() >= deadline || status === 0 || status === 3)
      return { status: null, error: new Error("TASK24_NATIVE_ACL_INCOMPLETE") }
    if (status !== 1) return { status: 1, stdout: "", stderr: "Native ACL query failed" }
    const length = Atomics.load(header, 1)
    if (length < 1 || length > 1048576) return { status: 1, stdout: "", stderr: "Native ACL output limit" }
    const stdout = Buffer.from(shared, 16, length).toString("utf8")
    completed = true
    return { status: 0, stdout, stderr: "" }
  } finally {
    // Do not terminate a worker in a pending native call: Bun's termination can
    // itself block synchronously. It owns only read handles, publishes after
    // releasing them, then exits naturally. Unknown completion sticky-blocks
    // the caller and preserves its scope; it is never a cleanup success.
    Atomics.store(header, 2, 1)
    Atomics.notify(header, 2)
    // A timed-out or unconfirmed worker may still write: never recycle its
    // buffer or terminate that pending native call. Keep the same 5s deadline.
    if (completed && Atomics.load(header, 0) === 1) completedScratch = shared
  }
}
