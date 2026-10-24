import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { BenchmarkAclProbe } from "../src/workflow/benchmark-acl-probe"
import { BenchmarkAclNative } from "../src/workflow/benchmark-acl-native"

async function nativeFixture(run: (root: string) => Promise<void>) {
  const parent = process.env.TMPDIR!
  const root = fs.mkdtempSync(path.join(parent, "native-acl-"))
  const id = fs.lstatSync(root, { bigint: true })
  let uncertain = false
  try {
    await run(root)
  } catch (error) {
    uncertain = !!error && typeof error === "object" && Reflect.get(error, "cleanupUncertain") === true
    throw error
  } finally {
    if (uncertain) console.warn("Retained unconfirmed native ACL fixture:", root)
    if (!uncertain) {
      const current = fs.lstatSync(root, { bigint: true })
      if (
        fs.realpathSync.native(root) !== root ||
        current.dev !== id.dev ||
        current.ino !== id.ino ||
        current.birthtimeNs !== id.birthtimeNs
      )
        throw Error("own native ACL fixture changed")
      fs.rmSync(root, { recursive: true })
    }
  }
}

test.skipIf(process.platform !== "win32")(
  "native benchmark ACL collection reads actual metadata without launching PowerShell and preserves the descriptor",
  async () =>
    nativeFixture(async (root) => {
      // Independent baseline in a fresh process: avoid the known Bun timed-spawn/HTTP interaction.
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--no-install",
          "-e",
          `import {HostRootPolicy} from ${JSON.stringify(path.join(import.meta.dir, "../src/workflow/host-root-policy.ts"))};console.log(JSON.stringify(HostRootPolicy.productionProbe({tempRoot:${JSON.stringify(root)}})(${JSON.stringify(root)})))`,
        ],
        { env: { ...process.env }, stdout: "pipe", stderr: "pipe", windowsHide: true },
      )
      const timer = setTimeout(() => child.kill(), 10000)
      const [exit, output, errors] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]).finally(() => clearTimeout(timer))
      expect({ exit, errors }).toEqual({ exit: 0, errors: "" })
      const original = JSON.parse(output)
      let guards = 0
      const probe = BenchmarkAclProbe.make({
        tempRoot: root,
        guard() {
          guards++
        },
      })
      const started = performance.now()
      const actual = probe(root)
      expect(actual).toEqual(original)
      expect(performance.now() - started).toBeLessThan(5000)
      expect(guards).toBe(2)
      expect(fs.readdirSync(root)).toEqual([])
      const repeated = probe(root)
      expect(repeated).toEqual(original)
      expect(fs.readdirSync(root)).toEqual([])
    }),
  20000,
)

test.skipIf(process.platform !== "win32")(
  "native ACL regression fixture preserves unknown-retirement evidence instead of recursively deleting it",
  async () => {
    let retained: string | undefined
    let identity: fs.BigIntStats | undefined
    try {
      await expect(
        nativeFixture(async (root) => {
          retained = root
          identity = fs.lstatSync(root, { bigint: true })
          BenchmarkAclProbe.make({
            tempRoot: root,
            guard() {},
            // No native worker or subprocess is launched by this precise fault seam.
            run: () => ({ status: null, error: Error("own unknown-retirement injection") }),
          })(root)
        }),
      ).rejects.toMatchObject({ cleanupUncertain: true })
      expect(fs.existsSync(retained!)).toBe(true)
      const scopes = fs.readdirSync(retained!)
      expect(scopes).toHaveLength(1)
      expect(scopes[0]).toStartWith("acl-query-")
      expect(fs.readdirSync(path.join(retained!, scopes[0]))).toEqual(["error.txt", "result.json"])
    } finally {
      // The injected run above created no live resource. Only this artificial
      // retained fixture may now be reclaimed, after rechecking its identity.
      if (retained && fs.existsSync(retained)) {
        const current = fs.lstatSync(retained, { bigint: true })
        if (
          fs.realpathSync.native(retained) !== retained ||
          current.dev !== identity!.dev ||
          current.ino !== identity!.ino ||
          current.birthtimeNs !== identity!.birthtimeNs
        )
          throw Error("own injected ACL fixture changed")
        fs.rmSync(retained, { recursive: true })
      }
    }
  },
)

test.skipIf(process.platform !== "win32")(
  "native ACL deadline refuses an unfinished worker within five seconds and never treats timeout as known cleanup",
  async () => {
    let worker: Worker | undefined
    const started = performance.now()
    const result = BenchmarkAclNative.collect(process.env.TMPDIR!, (data) => {
      worker = new Worker(
        "const {workerData}=require('node:worker_threads');Atomics.wait(new Int32Array(workerData.shared),2,0)",
        {
          eval: true,
          workerData: data,
        },
      )
      return worker
    })
    expect(result).toMatchObject({ status: null, error: expect.any(Error) })
    expect(performance.now() - started).toBeGreaterThanOrEqual(4900)
    expect(performance.now() - started).toBeLessThan(5500)
    await new Promise<void>((resolve) => worker!.once("exit", () => resolve()))
  },
  10000,
)

test.skipIf(process.platform !== "win32")(
  "native ACL framing rejects explicit native errors, unknown resource retirement and oversized replies",
  async () => {
    for (const [status, length, expected] of [
      [2, 4, 1],
      [3, 4, null],
      [1, 1048577, 1],
      [9, 4, 1],
    ] as const) {
      let worker: Worker | undefined
      const result = BenchmarkAclNative.collect(process.env.TMPDIR!, (data) => {
        worker = new Worker(
          `const {workerData}=require('node:worker_threads');const h=new Int32Array(workerData.shared,0,4);Atomics.store(h,1,${length});Atomics.store(h,0,${status});Atomics.notify(h,0)`,
          { eval: true, workerData: data },
        )
        return worker
      })
      expect(result.status).toBe(expected)
      if (expected !== null) expect(result.stderr).not.toBe("")
      await new Promise<void>((resolve) => worker!.once("exit", () => resolve()))
    }
  },
)
