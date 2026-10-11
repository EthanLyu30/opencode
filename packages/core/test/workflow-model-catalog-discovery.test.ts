import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Cause, Clock, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/unstable/http"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { Credential } from "../src/credential"
import { Database } from "../src/database/database"
import { Integration } from "../src/integration"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { WorkflowCredentialScope } from "../src/workflow/model-catalog/credential-scope"
import { WorkflowModelDiscovery } from "../src/workflow/model-catalog/discovery"
import { WorkflowModelSources } from "../src/workflow/model-catalog/sources"
import { WorkflowModelCatalogService } from "../src/workflow/model-catalog/service"
import { WorkflowModelCatalogStore } from "../src/workflow/model-catalog/store"
import {
  fixtureCatalogue,
  fixtureDiscovery,
  fixtureEntry,
  fixturePolicy,
  fixtureScope,
} from "./fixtures/workflow-model-catalog"
import { tmpdir } from "./fixture/tmpdir"

const canary = "sk-offline-canary-never-persist-123456"
const origins = { kimi: "https://api.moonshot.cn", deepseek: "https://api.deepseek.com" } as const
const scopeLayer = Layer.succeed(WorkflowCredentialScope.Service, {
  resolve: (providerID) =>
    Effect.succeed({ referenceID: "offline-runtime", revision: "1", origin: origins[providerID] }),
  credential: () => Effect.succeed(canary),
})

type Transport = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>
function discoveryLayer(transport: Transport, scope = scopeLayer) {
  return WorkflowModelDiscovery.layer.pipe(
    Layer.provide(scope),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, Object.assign(transport, { preconnect: fetch.preconnect }))),
  )
}

async function discover(transport: Transport, providerID: WorkflowModelCatalog.ProviderID = "kimi") {
  return Effect.runPromise(
    Effect.gen(function* () {
      const discovery = yield* WorkflowModelDiscovery.Service
      return yield* discovery.refresh(providerID, fixtureScope)
    }).pipe(Effect.provide(discoveryLayer(transport))),
  )
}

function failureCode(exit: Exit.Exit<unknown, WorkflowModelCatalog.CatalogError>) {
  if (Exit.isSuccess(exit)) throw new Error("expected catalogue failure")
  const errors = Cause.prettyErrors(exit.cause)
  expect(JSON.stringify(errors)).not.toContain(canary)
  return errors[0]?.message
}

describe("workflow catalogue discovery", () => {
  test("GET-only first-party requests use a private local transport, never generation", async () => {
    const requests: Array<{ method: string; url: string }> = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        requests.push({ method: request.method, url: new URL(request.url).pathname })
        expect(request.headers.get("authorization")).toBe(`Bearer ${canary}`)
        return Response.json(fixtureDiscovery("kimi", [fixtureEntry("kimi-flagship")]))
      },
    })
    try {
      const catalogue = await discover(async (url, init) => {
        expect(String(url)).toBe("https://api.moonshot.cn/v1/models")
        expect(init?.redirect).toBe("manual")
        return fetch(new URL(new URL(String(url)).pathname, server.url), init)
      })
      expect(requests).toEqual([{ method: "GET", url: "/v1/models" }])
      expect(catalogue.models[0]?.compatibility).toBe("unverified")
      expect(catalogue.models[0]?.priceSha256).toBeNull()
      expect(catalogue.models[0]?.family).toBe("unknown")
      expect(JSON.stringify(catalogue)).not.toContain(canary)
    } finally {
      await server.stop(true)
    }
  })

  test("DeepSeek fields are projected, not a Responses/lineage/price proof", async () => {
    const catalogue = await discover(
      async () =>
        Response.json({
          object: "list",
          data: [
            {
              id: "deepseek-next-fixture",
              object: "model",
              owned_by: "deepseek",
              name: "Offline candidate",
              context_window: 65536,
              max_output_tokens: 4096,
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
              effort: { supported_levels: ["high", "max"], default_level: "high" },
              api_capabilities: { anthropic_messages: { system_prompt_update: "in-history" } },
              family: "deepseek-pro",
              predecessor: "deepseek-v4-pro",
              priceSha256: "b".repeat(64),
              adapterProfileID: "deepseek-responses-v4-v1",
            },
          ],
        }),
      "deepseek",
    )
    expect(catalogue.models[0]).toMatchObject({
      contextWindow: 65536,
      maxOutputTokens: 4096,
      capabilities: ["vision_input"],
      effortLevels: ["high", "max"],
      family: "unknown",
      predecessor: null,
      protocol: null,
      priceSha256: null,
      adapterProfileID: null,
      compatibility: "unverified",
    })
  })

  test.each([301, 302, 307, 401, 429, 500, 503])("status %s is typed and body-free", async (status) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const discovery = yield* WorkflowModelDiscovery.Service
        return yield* discovery.refresh("kimi", fixtureScope).pipe(Effect.exit)
      }).pipe(
        Effect.provide(
          discoveryLayer(async () => new Response(canary, { status, headers: { location: "https://evil.invalid" } })),
        ),
      ),
    )
    expect(failureCode(result)).toBe("Workflow model catalogue: discovery_failed")
  })

  test.each([
    "{",
    "null",
    '{"object":"list","data":[',
    JSON.stringify({ object: "list", data: [{ id: "x", object: "model" }] }),
    JSON.stringify({
      object: "list",
      data: Array.from({ length: 257 }, (_, index) => ({ id: `m-${index}`, object: "model", owned_by: "deepseek" })),
    }),
    JSON.stringify({ object: "list", data: [{ id: canary, object: "model", owned_by: "deepseek" }] }),
  ])("invalid metadata fails without retaining the body (%#)", async (body) => {
    await expect(discover(async () => new Response(body), "deepseek")).rejects.toThrow("invalid_metadata")
  })

  test("streaming body ceiling applies without content-length; cancellation closes the reader", async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(discover(async () => new Response(body))).rejects.toThrow("invalid_metadata")
    expect(cancelled).toBe(true)
  })

  test("duplicate identifiers and incomplete Kimi fields reject the entire observation", async () => {
    const reply = fixtureDiscovery("kimi", [fixtureEntry("kimi-flagship"), fixtureEntry("kimi-flagship")])
    await expect(discover(async () => Response.json(reply))).rejects.toThrow("invalid_metadata")
    await expect(
      discover(async () =>
        Response.json({ object: "list", data: [{ id: "kimi-k3", object: "model", owned_by: "moonshot" }] }),
      ),
    ).rejects.toThrow("invalid_metadata")
  })

  test("the exact ten-second deadline interrupts an outstanding transport", async () => {
    let ready!: () => void
    let aborted = false
    const started = new Promise<void>((resolve) => {
      ready = resolve
    })
    const transport: Transport = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true
            reject(new Error(canary))
          },
          { once: true },
        )
        ready()
      })
    await Effect.runPromise(
      Effect.gen(function* () {
        const discovery = yield* WorkflowModelDiscovery.Service
        const fiber = yield* discovery.refresh("kimi", fixtureScope).pipe(Effect.exit, Effect.forkScoped)
        yield* Effect.promise(() => started)
        yield* TestClock.adjust("10 seconds")
        expect(failureCode(yield* Fiber.join(fiber))).toBe("Workflow model catalogue: discovery_failed")
      }).pipe(Effect.scoped, Effect.provide(discoveryLayer(transport)), Effect.provide(TestClock.layer())),
    )
    expect(aborted).toBe(true)
  })

  test("source URLs and forged bindings cannot self-certify a contract", () => {
    const entry = fixtureEntry("kimi-flagship")
    expect(WorkflowModelSources.verify(entry, entry.evidence)).toMatchObject({
      family: "unknown",
      compatibility: "unverified",
      adapterProfileID: null,
      priceSha256: null,
      predecessor: null,
    })
    const authority = WorkflowModelSources.reviewed([entry])
    expect(authority.verify(entry, entry.evidence).compatibility).toBe("supported")
    const weaker = authority.verify(
      {
        ...entry,
        capabilities: entry.capabilities.filter((capability) => capability !== "vision_input"),
        effortLevels: ["high"],
      },
      entry.evidence,
    )
    expect(weaker.capabilities).not.toContain("vision_input")
    expect(weaker.effortLevels).not.toContain("max")
    expect(authority.verify(entry, [{ ...entry.evidence[0]!, sha256: "d".repeat(64) }]).compatibility).toBe(
      "unverified",
    )
    expect(() => authority.verify(entry, [{ ...entry.evidence[0]!, url: "https://evil.invalid/contract" }])).toThrow(
      "invalid_metadata",
    )
    expect(() => WorkflowModelSources.reviewed([{ ...entry, adapterProfileSha256: "d".repeat(64) }])).toThrow(
      "unverified_contract",
    )
  })

  test("production origins reject HTTP, gateways, paths, userinfo and documentation hosts before GET", async () => {
    for (const origin of [
      "http://127.0.0.1",
      "https://evil.invalid",
      "https://api.moonshot.cn/v1",
      "https://u:p@api.moonshot.cn",
      "https://platform.kimi.com",
    ]) {
      let calls = 0
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const discovery = yield* WorkflowModelDiscovery.Service
          return yield* discovery.refresh("kimi", fixtureScope).pipe(Effect.exit)
        }).pipe(
          Effect.provide(
            discoveryLayer(
              async () => {
                calls++
                return Response.json({})
              },
              Layer.succeed(WorkflowCredentialScope.Service, {
                resolve: () => Effect.succeed({ referenceID: "offline", revision: "1", origin }),
                credential: () => Effect.succeed(canary),
              }),
            ),
          ),
        ),
      )
      expect(failureCode(result)).toContain("scope_mismatch")
      expect(calls).toBe(0)
    }
  })

  test("redirects are not followed by the actual HTTP client", async () => {
    let calls = 0
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        calls++
        return new Response(canary, { status: 302, headers: { location: "/stolen" } })
      },
    })
    try {
      await expect(
        discover((url, init) => fetch(new URL(new URL(String(url)).pathname, server.url), init)),
      ).rejects.toThrow("discovery_failed")
      expect(calls).toBe(1)
    } finally {
      await server.stop(true)
    }
  })

  test("credential revision drift during a GET discards the observation", async () => {
    let revision = "1"
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const discovery = yield* WorkflowModelDiscovery.Service
          return yield* discovery.refresh("kimi", fixtureScope)
        }).pipe(
          Effect.provide(
            discoveryLayer(
              async () => {
                revision = "2"
                return Response.json(fixtureDiscovery("kimi", [fixtureEntry("kimi-flagship")]))
              },
              Layer.succeed(WorkflowCredentialScope.Service, {
                resolve: () => Effect.succeed({ referenceID: "offline", revision, origin: origins.kimi }),
                credential: () => Effect.succeed(canary),
              }),
            ),
          ),
        ),
      ),
    ).rejects.toThrow("scope_mismatch")
  })
})

describe("catalogue credential scope and service", () => {
  test("database metadata rotation changes scope without reading credential values", async () => {
    const database = Database.layerFromPath(":memory:")
    const credentialLayer = AppNodeBuilder.build(Credential.node, [[Database.node, database]])
    await Effect.runPromise(
      Effect.gen(function* () {
        const credentials = yield* Credential.Service
        const scope = yield* WorkflowCredentialScope.Service
        const credential = yield* credentials.create({
          integrationID: Integration.ID.make("kimi"),
          value: Credential.Key.make({ type: "key", key: canary }),
        })
        const first = yield* scope.resolve("kimi")
        expect(first.referenceID).toContain(credential.id)
        expect(JSON.stringify(first)).not.toContain(canary)
        yield* credentials.update(credential.id, {
          value: Credential.Key.make({ type: "key", key: "offline-replacement" }),
        })
        const second = yield* scope.resolve("kimi")
        expect(second.revision).not.toBe(first.revision)
        expect(WorkflowCredentialScope.hash([first])).not.toBe(WorkflowCredentialScope.hash([second]))
      }).pipe(
        Effect.provide(WorkflowCredentialScope.layer),
        Effect.provide(
          Layer.succeed(WorkflowCredentialScope.Runtime, {
            providers: {
              kimi: { origin: origins.kimi, integrationID: Integration.ID.make("kimi"), configurationRevision: "1" },
            },
          }),
        ),
        Effect.provide(credentialLayer),
        Effect.provide(database),
      ),
    )
  })

  test("environment file scope uses only file/reload metadata, and missing config does not GET", async () => {
    await using tmp = await tmpdir()
    const envFile = path.join(tmp.path, "offline.env")
    await fs.writeFile(envFile, "body deliberately not parsed")
    const runtime = {
      providers: {
        kimi: {
          origin: origins.kimi,
          configurationRevision: "r1",
          environment: {
            referenceID: "opaque-runtime-ref",
            file: envFile,
            reloadRevision: "1",
            read: () => Effect.succeed(canary),
          },
        },
      },
    }
    const run = (providerID: WorkflowModelCatalog.ProviderID) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const scope = yield* WorkflowCredentialScope.Service
          return yield* scope.resolve(providerID)
        }).pipe(
          Effect.provide(WorkflowCredentialScope.layer),
          Effect.provide(Layer.succeed(WorkflowCredentialScope.Runtime, runtime)),
          Effect.provide(Database.layerFromPath(":memory:")),
          Effect.provide(
            Layer.succeed(Credential.Service, {
              all: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
              get: () => Effect.die("body read"),
              create: () => Effect.die("unused"),
              update: () => Effect.die("unused"),
              remove: () => Effect.die("unused"),
            }),
          ),
        ),
      )
    const first = await run("kimi")
    await fs.writeFile(envFile, "changed metadata, not a credential")
    const second = await run("kimi")
    expect(WorkflowCredentialScope.hash([first])).not.toBe(WorkflowCredentialScope.hash([second]))
    expect(first.referenceID).toBe("opaque-runtime-ref")
    expect(JSON.stringify(first)).not.toContain("deliberately")
    await expect(run("deepseek")).rejects.toThrow("selection_required")
  })

  test("failed refresh preserves the head; successful combined observations do not omit the other provider", async () => {
    await using tmp = await tmpdir()
    const identities = ["kimi", "deepseek"].map((providerID) => ({
      referenceID: providerID,
      revision: "1",
      origin: origins[providerID as WorkflowModelCatalog.ProviderID],
    }))
    const scope = WorkflowCredentialScope.hash(identities)
    const catalogue = fixtureCatalogue({ scopeSha256: scope })
    const store = await WorkflowModelCatalogStore.open(tmp.path, scope)
    const head = await store.publish({ expectedHeadSha256: null, catalogue, policy: fixturePolicy(catalogue) })
    let failed = true
    let now = 3_600_000
    const layer = WorkflowModelCatalogService.layer({ root: tmp.path, automatic: false, now: () => now }).pipe(
      Layer.provide(
        Layer.succeed(WorkflowCredentialScope.Service, {
          resolve: (providerID) => Effect.succeed(identities.find((item) => item.referenceID === providerID)!),
          credential: () => Effect.succeed(canary),
        }),
      ),
      Layer.provide(
        Layer.succeed(WorkflowModelDiscovery.Service, {
          refresh: (providerID, scopeSha256) =>
            failed
              ? Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "discovery_failed" }))
              : Effect.succeed(
                  fixtureCatalogue({
                    scopeSha256,
                    observedAt: now,
                    models: catalogue.models.filter((entry) => entry.providerID === providerID),
                  }),
                ),
        }),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkflowModelCatalogService.Service
        expect((yield* service.refresh(true)).head).toEqual(head)
        expect((yield* service.view()).refreshStatus).toBe("failed")
        failed = false
        const refreshed = yield* service.refresh(true)
        expect(refreshed.policy?.sha256).toBe(fixturePolicy(catalogue).sha256)
        expect(refreshed.catalogue?.models.every((entry) => entry.missingObservation === null)).toBe(true)
        const refreshedHead = refreshed.head
        expect((yield* service.refresh()).head).toEqual(refreshedHead)
        now++
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
    expect((await store.read()).head?.generation).toBe(2)
  })

  test("startup/hourly scheduling is scoped and a new credential scope cannot see old availability", async () => {
    await using tmp = await tmpdir()
    let revision = "1"
    let calls = 0
    const catalogue = fixtureCatalogue()
    const serviceLayer = WorkflowModelCatalogService.layer({
      root: tmp.path,
      initialPolicy: (scopeSha256) => fixturePolicy(fixtureCatalogue({ scopeSha256 })),
    }).pipe(
      Layer.provide(
        Layer.succeed(WorkflowCredentialScope.Service, {
          resolve: (providerID) => Effect.succeed({ referenceID: providerID, revision, origin: origins[providerID] }),
          credential: () => Effect.succeed(canary),
        }),
      ),
      Layer.provide(
        Layer.succeed(WorkflowModelDiscovery.Service, {
          refresh: (providerID, scopeSha256) =>
            Effect.gen(function* () {
              calls++
              return fixtureCatalogue({
                scopeSha256,
                observedAt: yield* Clock.currentTimeMillis,
                models: catalogue.models.filter((entry) => entry.providerID === providerID),
              })
            }),
        }),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkflowModelCatalogService.Service
        yield* Effect.yieldNow
        yield* service.refresh()
        expect(calls).toBe(2)
        expect((yield* service.view()).head?.generation).toBe(1)
        yield* TestClock.adjust("60 minutes")
        // A barrier refresh joins automatic work rather than racing it.
        yield* service.refresh()
        expect((yield* service.view()).catalogue?.models).toHaveLength(3)
        expect(calls).toBe(4)
        expect((yield* service.view()).head?.generation).toBe(2)
        revision = "2"
        expect((yield* service.view()).head).toBeNull()
        expect((yield* service.view()).catalogue).toBeNull()
      }).pipe(Effect.scoped, Effect.provide(serviceLayer), Effect.provide(TestClock.layer())),
    )
    const stoppedAt = calls
    await Effect.runPromise(TestClock.adjust("60 minutes").pipe(Effect.provide(TestClock.layer())))
    expect(calls).toBe(stoppedAt)
  })

  test("refresh validates the combined ceiling and cancellation releases its refresh permit", async () => {
    await using tmp = await tmpdir()
    const identities = ["kimi", "deepseek"].map((providerID) => ({
      referenceID: providerID,
      revision: "1",
      origin: origins[providerID as WorkflowModelCatalog.ProviderID],
    }))
    const scopeSha256 = WorkflowCredentialScope.hash(identities)
    const catalogue = fixtureCatalogue({ scopeSha256 })
    const store = await WorkflowModelCatalogStore.open(tmp.path, scopeSha256)
    const head = await store.publish({ expectedHeadSha256: null, catalogue, policy: fixturePolicy(catalogue) })
    let mode = "overflow"
    const serviceLayer = WorkflowModelCatalogService.layer({
      root: tmp.path,
      automatic: false,
      now: () => 3_600_000,
    }).pipe(
      Layer.provide(
        Layer.succeed(WorkflowCredentialScope.Service, {
          resolve: (providerID) => Effect.succeed(identities.find((item) => item.referenceID === providerID)!),
          credential: () => Effect.succeed(canary),
        }),
      ),
      Layer.provide(
        Layer.succeed(WorkflowModelDiscovery.Service, {
          refresh: (providerID) =>
            mode === "pending"
              ? Effect.never
              : Effect.succeed(
                  fixtureCatalogue({
                    scopeSha256,
                    observedAt: 3_600_000,
                    models: Array.from({ length: 129 }, (_, index) =>
                      fixtureEntry(providerID === "kimi" ? "kimi-flagship" : "deepseek-pro", {
                        modelID: `${providerID}-fixture-${index}`,
                      }),
                    ),
                  }),
                ),
        }),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkflowModelCatalogService.Service
        const failed = yield* service.refresh(true)
        expect(failed.head).toEqual(head)
        expect(failed.failureCode).toBe("invalid_metadata")
        mode = "pending"
        const fiber = yield* service.refresh(true).pipe(Effect.forkScoped)
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        expect((yield* service.view()).refreshStatus).not.toBe("refreshing")
        mode = "overflow"
        expect((yield* service.refresh(true)).head).toEqual(head)
      }).pipe(Effect.scoped, Effect.provide(serviceLayer)),
    )
  })

  test("unstable environment-only revisions do not advertise cached freshness", async () => {
    await using tmp = await tmpdir()
    let calls = 0
    const catalogue = fixtureCatalogue()
    const serviceLayer = WorkflowModelCatalogService.layer({
      root: tmp.path,
      automatic: false,
      now: () => 0,
      initialPolicy: (scopeSha256) => fixturePolicy(fixtureCatalogue({ scopeSha256 })),
    }).pipe(
      Layer.provide(
        Layer.succeed(WorkflowCredentialScope.Service, {
          resolve: (providerID) =>
            Effect.succeed({ referenceID: providerID, revision: "ephemeral:session", origin: origins[providerID] }),
          credential: () => Effect.succeed(canary),
        }),
      ),
      Layer.provide(
        Layer.succeed(WorkflowModelDiscovery.Service, {
          refresh: (providerID, scopeSha256) =>
            Effect.sync(() => {
              calls++
              return fixtureCatalogue({
                scopeSha256,
                models: catalogue.models.filter((entry) => entry.providerID === providerID),
              })
            }),
        }),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkflowModelCatalogService.Service
        yield* service.refresh()
        expect((yield* service.view()).stale).toBe(true)
        yield* service.refresh()
        expect(calls).toBe(4)
      }).pipe(Effect.scoped, Effect.provide(serviceLayer)),
    )
  })
})
