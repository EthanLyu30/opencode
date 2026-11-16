import { test, expect } from "bun:test"
import { sha256Text } from "../../src/hash"
import type { HostManifest } from "../../src/sandbox/contracts"
import { composeAcceptArtifacts } from "../../src/sandbox/dependencies"
type Artifacts = HostManifest["artifacts"]
const artifact = (id: string, kind: "binary" | "browser" | "font" | "worker"): Artifacts[number] => ({
  id,
  kind,
  sha256: sha256Text(id),
})
const pending = (id: string): Artifacts[number] => ({ id, kind: "pending", recipeSha256: sha256Text(id) })
const image = (id: string): Artifacts[number] => ({
  id,
  kind: "image",
  sha256: "a".repeat(64),
  image: "example.invalid/runtime@sha256:" + "a".repeat(64),
})
const verified = {
  binaries: [artifact("modified", "binary"), artifact("upstream", "binary")],
  browser: [artifact("browser", "browser"), artifact("fonts", "font")],
  images: [image("linux-runtime")],
}
test("accept composition preserves prepared artifacts and replaces only pending declarations", () => {
  const composed = composeAcceptArtifacts({
    prepared: [
      artifact("controller-inventory", "worker"),
      pending("modified"),
      pending("upstream"),
      pending("browser"),
      pending("fonts"),
      pending("linux-runtime"),
    ],
    ...verified,
  })
  expect(composed.map((a) => a.id).sort()).toEqual(
    ["browser", "controller-inventory", "fonts", "linux-runtime", "modified", "upstream"].sort(),
  )
  expect(composed.some((a) => a.kind === "pending")).toBe(false)
  expect(composed.find((a) => a.id === "controller-inventory")?.sha256).toBe(sha256Text("controller-inventory"))
})
test("accept composition refuses to drop an unverified prepared declaration", () => {
  expect(() => composeAcceptArtifacts({ prepared: [pending("runtime-config")], ...verified })).toThrow(
    "TASK24_LINUX_ARTIFACT_PENDING",
  )
})
test("accept composition refuses duplicate supplied identities", () => {
  expect(() =>
    composeAcceptArtifacts({ prepared: [], ...verified, binaries: [artifact("modified", "binary"), artifact("modified", "binary")] }),
  ).toThrow("TASK24_LINUX_ARTIFACT_DUPLICATE")
})
test("accept composition refuses to replace an already-verified prepared artifact", () => {
  expect(() =>
    composeAcceptArtifacts({ prepared: [artifact("controller-inventory", "worker")], ...verified, browser: [...verified.browser, artifact("controller-inventory", "worker")] }),
  ).toThrow("TASK24_LINUX_ARTIFACT_DUPLICATE")
})
