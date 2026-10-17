import { test, expect } from "bun:test"
import { decodeHostManifest, decodeHostRequest } from "../../src/sandbox/contracts"
import { hostFixture } from "./fixture"

test("strict host contracts reject remote endpoints, extra fields and unprepared acceptance", async () => {
  const f = await hostFixture()
  try {
    expect(decodeHostManifest(f.manifest).phase).toBe("prepare")
    for (const change of [
      { unexpected: true },
      { phase: "accept" },
      { cli: { ...f.cli, path: "C:\\docker.exe" } },
      { endpoint: "tcp://127.0.0.1:2375" },
    ])
      expect(() => decodeHostManifest({ ...f.manifest, ...change })).toThrow()
    expect(() =>
      decodeHostRequest({ ...f.request, roots: { ...f.request.roots, work: f.request.roots.temp } }),
    ).toThrow()
    expect(() => decodeHostRequest({ ...f.request, roots: { ...f.request.roots, work: "D:\\" } })).toThrow()
  } finally {
    await f.dispose()
  }
})
