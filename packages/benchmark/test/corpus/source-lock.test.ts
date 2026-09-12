import { describe, expect, test } from "bun:test"
import {
  assertImmutableRevision,
  lockDatasetSource,
  parseStableRelease,
  resolveOfficialUpstream,
  sealSourceLock,
  verifySourceLock,
} from "../../src/corpus/source-lock"

const sha = (digit: string) => digit.repeat(64)

describe("Task24 source locks", () => {
  test.each(["main", "master", "dev", "latest", "HEAD", "refs/heads/release", "https://example.test/repo#main"])(
    "rejects mutable revision %s",
    (revision) => expect(() => assertImmutableRevision(revision)).toThrow(/immutable/i),
  )

  test("accepts only a stable release and its exact resolved commit", () => {
    expect(parseStableRelease({ tag_name: "v1.18.30", draft: false, prerelease: false })).toBe("v1.18.30")
    expect(() => parseStableRelease({ tag_name: "v1.18.31-beta.1", draft: false, prerelease: true })).toThrow(/stable/i)
    expect(() => parseStableRelease({ tag_name: "latest", draft: false, prerelease: false })).toThrow(/stable/i)
  })

  test("resolves the latest stable release through injected fetch and tag authority", async () => {
    const archive = Uint8Array.from([31, 139, 8, 0, 1, 2, 3, 4])
    const calls: string[] = []
    const source = await resolveOfficialUpstream({
      fetch: (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        calls.push(url)
        if (url.endsWith("/releases/latest")) {
          return Response.json({ tag_name: "v1.18.30", draft: false, prerelease: false })
        }
        return new Response(archive)
      }) as typeof fetch,
      resolveTag: async (repositoryUrl, tag) => {
        expect(repositoryUrl).toBe("https://github.com/anomalyco/opencode")
        expect(tag).toBe("v1.18.30")
        return "a".repeat(40)
      },
      now: () => new Date("2026-09-12T12:00:00.000Z"),
    })

    expect(source).toMatchObject({
      tag: "v1.18.30",
      revision: "a".repeat(40),
      lockedAt: "2026-09-12T12:00:00.000Z",
      license: "MIT",
    })
    expect(source.archiveSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(calls).toHaveLength(2)
  })

  test("falls back to the official latest-release redirect when anonymous GitHub API quota is exhausted", async () => {
    const archive = Uint8Array.from([31, 139, 8, 0, 1, 2, 3, 4])
    const calls: string[] = []
    const source = await resolveOfficialUpstream({
      fetch: (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        calls.push(url)
        if (url.includes("api.github.com")) return new Response("rate limit", { status: 403 })
        if (url.endsWith("/releases/latest")) {
          return new Response(null, { status: 302, headers: { location: "/anomalyco/opencode/releases/tag/v1.18.30" } })
        }
        return new Response(archive)
      }) as typeof fetch,
      resolveTag: async (_repositoryUrl, tag) => {
        expect(tag).toBe("v1.18.30")
        return "a".repeat(40)
      },
      now: () => new Date("2026-09-12T12:00:00.000Z"),
    })

    expect(source.tag).toBe("v1.18.30")
    expect(calls).toEqual([
      "https://api.github.com/repos/anomalyco/opencode/releases/latest",
      "https://github.com/anomalyco/opencode/releases/latest",
      `https://github.com/anomalyco/opencode/archive/${"a".repeat(40)}.tar.gz`,
    ])
  })

  test("seals exact upstream and dataset metadata and rejects tampering", () => {
    const upstream = {
      id: "opencode-upstream",
      kind: "git" as const,
      repositoryUrl: "https://github.com/anomalyco/opencode",
      tag: "v1.18.30",
      revision: "a".repeat(40),
      archiveSha256: sha("b"),
      lockedAt: "2026-09-12T12:00:00.000Z",
      license: "MIT",
    }
    const dataset = lockDatasetSource({
      id: "design2code-hard",
      repositoryUrl: "https://github.com/NoviScl/Design2Code",
      revision: "c".repeat(40),
      subset: "Design2Code-Hard/renderable-windows-chromium",
      itemIDs: ["case-1", "case-2"],
      assets: [
        { path: "case-1/reference.png", sha256: sha("d"), size: 12 },
        { path: "case-2/reference.png", sha256: sha("e"), size: 13 },
      ],
      normalizationVersion: "task24-normalization-v1",
      license: "Apache-2.0",
    })
    const sealed = sealSourceLock({ schemaVersion: 1, upstream, datasets: [dataset] })

    expect(verifySourceLock(sealed)).toEqual({ ok: true, lock: sealed })
    expect(verifySourceLock({ ...sealed, upstream: { ...sealed.upstream, revision: "f".repeat(40) } })).toEqual({
      ok: false,
      reason: "SOURCE_LOCK_HASH_MISMATCH",
    })
    expect(Object.isFrozen(dataset.itemIDs)).toBe(true)
    expect(Object.isFrozen(dataset.assets)).toBe(true)
  })

  test("rejects duplicate dataset items, paths, and mutable dataset revisions", () => {
    const base = {
      id: "swebench-multimodal-js",
      repositoryUrl: "https://github.com/SWE-bench/SWE-bench",
      revision: "a".repeat(40),
      subset: "multimodal/javascript-visual",
      itemIDs: ["case-1"],
      assets: [{ path: "case-1/issue.png", sha256: sha("1"), size: 10 }],
      normalizationVersion: "task24-normalization-v1",
      license: "MIT",
    }
    expect(() => lockDatasetSource({ ...base, revision: "main" })).toThrow(/immutable/i)
    expect(() => lockDatasetSource({ ...base, itemIDs: ["case-1", "case-1"] })).toThrow(/duplicate/i)
    expect(() => lockDatasetSource({ ...base, assets: [...base.assets, base.assets[0]] })).toThrow(/duplicate/i)
  })
})
