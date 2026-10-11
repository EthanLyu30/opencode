import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { Cause, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowModelCatalogService } from "../src/workflow/model-catalog/service"
import { WorkflowModelCatalogStore } from "../src/workflow/model-catalog/store"
import { WorkflowCredentialScope } from "../src/workflow/model-catalog/credential-scope"
import { WorkflowModelDiscovery } from "../src/workflow/model-catalog/discovery"
import { fixtureCatalogue, fixtureEntry, fixturePolicy } from "./fixtures/workflow-model-catalog"
import { tmpdir } from "./fixture/tmpdir"
import { Flock } from "../src/util/flock"

const families = ["kimi-flagship", "deepseek-pro", "deepseek-flash"] as const
const successors = [
  fixtureEntry("kimi-flagship", {
    modelID: "kimi-successor-fixture",
    predecessor: "kimi-k3",
    priceSha256: "d".repeat(64),
  }),
  fixtureEntry("deepseek-pro", {
    modelID: "deepseek-pro-successor-fixture",
    predecessor: "deepseek-v4-pro",
    priceSha256: "d".repeat(64),
  }),
  fixtureEntry("deepseek-flash", {
    modelID: "deepseek-flash-successor-fixture",
    predecessor: "deepseek-v4-flash",
    priceSha256: "d".repeat(64),
  }),
]
const origins = { kimi: "https://api.moonshot.cn", deepseek: "https://api.deepseek.com" } as const

async function fixture(root: string, extra: readonly WorkflowModelCatalog.ModelEntry[] = successors, volatile = false) {
  const state = {
    now: 1000,
    revision: "offline-1",
    volatile,
    failed: false,
    observed: [...fixtureCatalogue().models, ...extra],
    requests: 0,
    resolves: 0,
    pauseOnResolve: 0,
    onResolve: undefined as (() => void) | undefined,
  }
  const identity = (providerID: WorkflowModelCatalog.ProviderID) => ({
    referenceID: `offline-${providerID}`,
    revision: state.volatile ? `ephemeral:${state.revision}` : state.revision,
    origin: origins[providerID],
  })
  const scopeSha256 = WorkflowCredentialScope.hash([identity("kimi"), identity("deepseek")])
  const catalogue = fixtureCatalogue({ scopeSha256, models: [...state.observed] })
  const policy = fixturePolicy(catalogue)
  const store = await WorkflowModelCatalogStore.open(root, scopeSha256)
  const head = await store.publish({ expectedHeadSha256: null, catalogue, policy })
  const serviceLayer = () =>
    WorkflowModelCatalogService.layer({ root, automatic: false, now: () => state.now }).pipe(
      Layer.provide(
        Layer.succeed(WorkflowCredentialScope.Service, {
          resolve: (providerID) =>
            Effect.suspend(() => {
              const reference = identity(providerID)
              state.resolves++
              state.onResolve?.()
              return state.resolves === state.pauseOnResolve ? Effect.never : Effect.succeed(reference)
            }),
          credential: () => Effect.die("offline activation must not obtain a generation credential"),
        }),
      ),
      Layer.provide(
        Layer.succeed(WorkflowModelDiscovery.Service, {
          refresh: (providerID, scopeSha256) =>
            Effect.suspend(() => {
              state.requests++
              return state.failed
                ? Effect.fail(new WorkflowModelCatalog.CatalogError({ code: "discovery_failed" }))
                : Effect.succeed(
                    fixtureCatalogue({
                      scopeSha256,
                      observedAt: state.now,
                      models: state.observed.filter((entry) => entry.providerID === providerID),
                    }),
                  )
            }),
        }),
      ),
    )
  const run = <A, E>(
    fn: (service: WorkflowModelCatalogService.Service["Service"]) => Effect.Effect<A, E, Scope.Scope>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkflowModelCatalogService.Service
        return yield* fn(service)
      }).pipe(Effect.scoped, Effect.provide(serviceLayer())),
    )
  const activation = (
    familiesToReplace: readonly WorkflowModelCatalog.SelectedFamily[] = families,
  ): WorkflowModelCatalog.ActivationInput =>
    Schema.decodeUnknownSync(WorkflowModelCatalog.ActivationInput)({
      expectedHeadSha256: head.sha256,
      replacements: familiesToReplace.map((family) => {
        const entry = extra.find((entry) => entry.family === family)!
        return { family, providerID: entry.providerID, modelID: entry.modelID }
      }),
    })
  return { state, scopeSha256, catalogue, policy, store, head, run, activation }
}

function code(exit: Exit.Exit<unknown, WorkflowModelCatalog.CatalogError>): string {
  if (Exit.isSuccess(exit)) throw new Error("expected typed catalogue failure")
  const errors = Cause.prettyErrors(exit.cause)
  expect(errors).toHaveLength(1)
  expect(errors[0]?.message).toMatch(/^Workflow model catalogue: /)
  return errors[0]!.message.replace("Workflow model catalogue: ", "")
}

describe("workflow catalogue explicit activation", () => {
  test("discovery publishes candidates without activating them", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    await setup.run((service) =>
      Effect.gen(function* () {
        setup.state.now++
        const view = yield* service.refresh(true)
        expect(view.policy?.choices).toEqual({
          "kimi-flagship": { providerID: "kimi", modelID: "kimi-k3" },
          "deepseek-pro": { providerID: "deepseek", modelID: "deepseek-v4-pro" },
          "deepseek-flash": { providerID: "deepseek", modelID: "deepseek-v4-flash" },
        })
        expect(view.policy?.sha256).toBe(setup.policy.sha256)
        expect((yield* service.snapshot()).routes.deliver.modelID).toBe("deepseek-v4-pro")
      }),
    )
  })

  test("explicit replacement publishes one coherent pair and keeps old catalogue/policy history", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    const oldCatalogueFile = path.join(
      tmp.path,
      "scopes",
      setup.scopeSha256,
      "catalogues",
      `${setup.catalogue.sha256}.json`,
    )
    const oldPolicyFile = path.join(tmp.path, "scopes", setup.scopeSha256, "policies", `${setup.policy.sha256}.json`)
    const oldBytes = [await fs.readFile(oldCatalogueFile, "utf8"), await fs.readFile(oldPolicyFile, "utf8")]
    await setup.run((service) =>
      Effect.gen(function* () {
        const pinned = yield* service.snapshot()
        const view = yield* service.activate(setup.activation())
        expect(view.head?.generation).toBe(2)
        expect(view.policy?.choices).toEqual({
          "kimi-flagship": { providerID: "kimi", modelID: "kimi-successor-fixture" },
          "deepseek-pro": { providerID: "deepseek", modelID: "deepseek-pro-successor-fixture" },
          "deepseek-flash": { providerID: "deepseek", modelID: "deepseek-flash-successor-fixture" },
        })
        expect(
          view.catalogue?.models
            .filter((entry) => entry.lifecycle === "superseded")
            .map((entry) => entry.modelID)
            .sort(),
        ).toEqual(["deepseek-v4-flash", "deepseek-v4-pro", "kimi-k3"])
        expect(view.head?.catalogueSha256).toBe(view.catalogue?.sha256)
        expect(view.head?.policySha256).toBe(view.policy?.sha256)
        expect(pinned.routes.deliver.modelID).toBe("deepseek-v4-pro")
        expect(pinned.routes.design.modelID).toBe("kimi-k3")
        expect((yield* service.snapshot()).routes.deliver.modelID).toBe("deepseek-pro-successor-fixture")
      }),
    )
    expect([await fs.readFile(oldCatalogueFile, "utf8"), await fs.readFile(oldPolicyFile, "utf8")]).toEqual(oldBytes)
    expect(setup.state.requests).toBe(0)
    expect((await setup.store.read()).head?.generation).toBe(2)
  })

  test("independent Flash replacement never retires or changes Pro/Kimi", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    const view = await setup.run((service) => service.activate(setup.activation(["deepseek-flash"])))
    expect(view.policy?.choices["deepseek-pro"].modelID).toBe("deepseek-v4-pro")
    expect(view.policy?.choices["kimi-flagship"].modelID).toBe("kimi-k3")
    expect(view.catalogue?.models.find((entry) => entry.modelID === "deepseek-v4-pro")?.lifecycle).toBe("current")
    expect(view.catalogue?.models.find((entry) => entry.modelID === "deepseek-v4-flash")?.lifecycle).toBe("superseded")
  })

  test.each([
    { priceSha256: "e".repeat(64) },
    {
      compatibility: "unverified" as const,
      adapterProfileID: "future-unverified-profile-fixture",
      adapterProfileSha256: "e".repeat(64),
    },
  ])("changed price/profile for the same candidate needs a new confirmation (%#)", async (change) => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    const revised = fixtureCatalogue({
      scopeSha256: setup.scopeSha256,
      models: setup.catalogue.models.map((entry) =>
        entry.modelID === "kimi-successor-fixture" ? { ...entry, ...change } : entry,
      ),
    })
    const current = await setup.store.publish({
      expectedHeadSha256: setup.head.sha256,
      catalogue: revised,
      policy: setup.policy,
    })
    const result = await setup.run((service) => service.activate(setup.activation(["kimi-flagship"])).pipe(Effect.exit))
    expect(code(result)).toBe("selection_conflict")
    expect((await setup.store.read()).head).toEqual(current)
  })

  test("mixed valid/invalid replacements do not partially activate a family", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    const request = setup.activation(["kimi-flagship", "deepseek-pro"])
    const result = await setup.run((service) =>
      service
        .activate({
          ...request,
          replacements: [
            request.replacements[0]!,
            { family: "deepseek-pro", providerID: "deepseek", modelID: "deepseek-flash-successor-fixture" },
          ],
        })
        .pipe(Effect.exit),
    )
    expect(code(result)).toBe("unverified_contract")
    expect((await setup.store.read()).head).toEqual(setup.head)
  })

  test.each([
    { modelID: "kimi-k2.7" },
    { modelID: "kimi-k2.6" },
    { predecessor: null },
    { family: "unknown" as const, predecessor: null },
    { priceSha256: null },
    { compatibility: "unverified" as const },
    { availability: "missing" as const },
    { capabilities: ["chat"] },
    { effortLevels: ["high"] },
  ])("ineligible replacement is rejected without fallback or mutation (%#)", async (change) => {
    await using tmp = await tmpdir()
    const entry = { ...successors[0]!, ...change }
    const setup = await fixture(tmp.path, [entry])
    const result = await setup.run((service) =>
      service
        .activate({
          expectedHeadSha256: setup.head.sha256,
          replacements: [{ family: "kimi-flagship", providerID: "kimi", modelID: entry.modelID }],
        })
        .pipe(Effect.exit),
    )
    expect(code(result)).toBe("unverified_contract")
    expect((await setup.store.read()).head).toEqual(setup.head)
    expect(setup.state.requests).toBe(0)
  })

  test("reverse-generation replacement cannot restore a retired predecessor", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    await setup.run((service) =>
      Effect.gen(function* () {
        const selected = yield* service.activate(setup.activation(["kimi-flagship"]))
        expect(
          code(
            yield* service
              .activate({
                expectedHeadSha256: selected.head!.sha256,
                replacements: [{ family: "kimi-flagship", providerID: "kimi", modelID: "kimi-k3" }],
              })
              .pipe(Effect.exit),
          ),
        ).toBe("unverified_contract")
      }),
    )
    expect((await setup.store.read()).policy?.choices["kimi-flagship"].modelID).toBe("kimi-successor-fixture")
  })

  test("independent service instances race the same confirmation; only one commits", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    const outcomes = await Promise.all([
      setup.run((service) => service.activate(setup.activation(["kimi-flagship"])).pipe(Effect.exit)),
      setup.run((service) => service.activate(setup.activation(["deepseek-pro"])).pipe(Effect.exit)),
    ])
    expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1)
    expect(code(outcomes.find(Exit.isFailure)!)).toBe("selection_conflict")
    const view = await setup.store.read()
    expect(view.head?.generation).toBe(2)
    expect(view.catalogue?.models.filter((entry) => entry.lifecycle === "superseded")).toHaveLength(1)
  })

  test("activation rejects caller-supplied authority fields before publication", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    const request = {
      ...setup.activation(["kimi-flagship"]),
      origin: "https://untrusted.invalid",
      priceSha256: "e".repeat(64),
    }
    expect(code(await setup.run((service) => service.activate(request).pipe(Effect.exit)))).toBe("invalid_metadata")
    expect((await setup.store.read()).head).toEqual(setup.head)
  })

  test("fresh confirmation adopts the changed price but does not create spend approval", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    const revised = fixtureCatalogue({
      scopeSha256: setup.scopeSha256,
      models: setup.catalogue.models.map((entry) =>
        entry.modelID === "kimi-successor-fixture" ? { ...entry, priceSha256: "e".repeat(64) } : entry,
      ),
    })
    const current = await setup.store.publish({
      expectedHeadSha256: setup.head.sha256,
      catalogue: revised,
      policy: setup.policy,
    })
    await setup.run((service) =>
      Effect.gen(function* () {
        yield* service.activate({ ...setup.activation(["kimi-flagship"]), expectedHeadSha256: current.sha256 })
        const snapshot = yield* service.snapshot()
        expect(snapshot.routes.design.priceSha256).toBe("e".repeat(64))
        expect(snapshot.routes.design.modelID).toBe("kimi-successor-fixture")
        expect(Object.keys(snapshot).sort()).toEqual([
          "catalogueSha256",
          "policySha256",
          "routes",
          "schemaVersion",
          "scopeSha256",
          "sha256",
        ])
      }),
    )
    expect(setup.state.requests).toBe(0)
  })

  test("expired confirmation requires explicit refresh and does not silently change the frame", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    setup.state.now = 3_600_000
    expect(code(await setup.run((service) => service.activate(setup.activation()).pipe(Effect.exit)))).toBe(
      "selection_required",
    )
    expect((await setup.store.read()).head).toEqual(setup.head)
    expect(setup.state.requests).toBe(0)
  })

  test("credential drift before atomic head publication fences the old scope", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    const lock = await Flock.acquire(`workflow-model-catalog:${setup.scopeSha256}`, {
      dir: path.join(tmp.path, "scopes", setup.scopeSha256, "locks"),
    })
    let released = false
    let ready!: () => void
    const resolved = new Promise<void>((resolve) => {
      ready = resolve
    })
    setup.state.onResolve = () => {
      if (setup.state.resolves === 2) ready()
    }
    try {
      const attempt = setup.run((service) => service.activate(setup.activation(["kimi-flagship"])).pipe(Effect.exit))
      await resolved
      setup.state.revision = "offline-rotated-while-publishing"
      await lock.release()
      released = true
      expect(code(await attempt)).toBe("scope_mismatch")
      expect((await setup.store.read()).head).toEqual(setup.head)
    } finally {
      if (!released) await lock.release()
    }
  })

  test("volatile credentials require fresh discovery and changed binding requires reconfirmation", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path, successors, true)
    setup.state.observed = setup.state.observed.map((entry) =>
      entry.modelID === "kimi-successor-fixture" ? { ...entry, priceSha256: "e".repeat(64) } : entry,
    )
    expect(
      code(await setup.run((service) => service.activate(setup.activation(["kimi-flagship"])).pipe(Effect.exit))),
    ).toBe("selection_conflict")
    expect(setup.state.requests).toBe(2)
    expect((await setup.store.read()).head).toEqual(setup.head)
  })

  test("volatile credentials with unchanged fresh bindings can confirm without a synthetic conflict", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path, successors, true)
    const selected = await setup.run((service) => service.activate(setup.activation(["kimi-flagship"])))
    expect(selected.policy?.choices["kimi-flagship"].modelID).toBe("kimi-successor-fixture")
    expect(selected.head?.generation).toBe(2)
    expect(setup.state.requests).toBe(2)
  })

  test("cancellation during the final identity fence releases Flock without publishing", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    let ready!: () => void
    const fenced = new Promise<void>((resolve) => {
      ready = resolve
    })
    setup.state.pauseOnResolve = 3
    setup.state.onResolve = () => {
      if (setup.state.resolves === 3) ready()
    }
    await setup.run((service) =>
      Effect.gen(function* () {
        const fiber = yield* service.activate(setup.activation(["kimi-flagship"])).pipe(Effect.forkScoped)
        yield* Effect.promise(() => fenced)
        yield* Fiber.interrupt(fiber)
        const nextOwner = yield* Effect.promise(() =>
          Flock.acquire(`workflow-model-catalog:${setup.scopeSha256}`, {
            dir: path.join(tmp.path, "scopes", setup.scopeSha256, "locks"),
            timeoutMs: 200,
          }),
        )
        yield* Effect.promise(() => nextOwner.release())
        setup.state.pauseOnResolve = 0
        expect((yield* service.snapshot()).routes.design.modelID).toBe("kimi-k3")
      }),
    )
    expect((await setup.store.read()).head).toEqual(setup.head)
  })
})

test("volatile confirmation can retire an absent predecessor when every new selection is freshly available", async () => {
  await using tmp = await tmpdir()
  const setup = await fixture(tmp.path, successors, true)
  setup.state.observed = setup.state.observed.filter((entry) => entry.modelID !== "kimi-k3")
  const view = await setup.run((service) => service.activate(setup.activation(["kimi-flagship"])))
  expect(view.policy?.choices["kimi-flagship"].modelID).toBe("kimi-successor-fixture")
  expect(view.catalogue?.models.find((entry) => entry.modelID === "kimi-k3")?.lifecycle).toBe("superseded")
  expect(setup.state.requests).toBe(2)
})

describe("workflow catalogue route snapshot", () => {
  test("all seven routes contain exact role effort, protocol, price and profile identities", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    const snapshot = await setup.run((service) => service.snapshot())
    expect(Schema.is(WorkflowModelCatalog.AdmissionSnapshot)(snapshot)).toBe(true)
    expect(
      Object.fromEntries(
        Object.entries(snapshot.routes).map(([role, route]) => [
          role,
          [route.providerID, route.modelID, route.protocol, route.reasoningEffort],
        ]),
      ),
    ).toEqual({
      design: ["kimi", "kimi-k3", "openai-chat", "max"],
      decompose: ["kimi", "kimi-k3", "openai-chat", "high"],
      visual_review: ["kimi", "kimi-k3", "openai-chat", "max"],
      implement: ["deepseek", "deepseek-v4-pro", "openai-responses", "max"],
      repair: ["deepseek", "deepseek-v4-pro", "openai-responses", "max"],
      deliver: ["deepseek", "deepseek-v4-pro", "openai-responses", "high"],
      test: ["deepseek", "deepseek-v4-flash", "openai-responses", "high"],
    })
    expect(snapshot.routes.visual_review.requiredCapabilities).toContain("vision_input")
    expect(snapshot.routes.design.requiredCapabilities).toEqual([
      "chat",
      "reasoning_replay",
      "structured_output",
      "required_tool_choice",
    ])
    expect(snapshot.routes.deliver.requiredCapabilities).toEqual([
      "responses",
      "structured_output",
      "required_tool_choice",
    ])
    expect(snapshot.routes.design.adapterProfileSha256).toBe(
      "1dbb4bbeb17dfd793e1ab73617bf1410b5268ab9c70c9b54561b4b5de4560f18",
    )
    expect(snapshot.routes.deliver.adapterProfileSha256).toBe(
      "c688edea870c60178af66153baf00d9e6b6159b33caa3a1f75b092d2230314a7",
    )
    expect(snapshot.routes.deliver.priceSha256).toBe("b".repeat(64))
    expect(snapshot.routes.deliver.advertisedRevision).toBe("offline-fixture-v1")
    expect(snapshot.catalogueSha256).toBe(setup.catalogue.sha256)
    expect(snapshot.policySha256).toBe(setup.policy.sha256)
    expect(snapshot.scopeSha256).toBe(setup.scopeSha256)
    expect(setup.state.requests).toBe(0)
    const { sha256, ...content } = snapshot
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, child]) => [key, canonical(child)]),
            )
          : value
    expect(sha256).toBe(
      createHash("sha256")
        .update(JSON.stringify(canonical(content)))
        .digest("hex"),
    )
  })

  test.each([
    { priceSha256: null, want: "unverified_contract" },
    { availability: "missing" as const, want: "model_unavailable" },
    { lifecycle: "superseded" as const, want: "selection_required" },
    { capabilities: ["chat"], want: "unverified_contract" },
  ])("invalid selected binding cannot create a route snapshot (%#)", async ({ want, ...change }) => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    const catalogue = fixtureCatalogue({
      scopeSha256: setup.scopeSha256,
      models: setup.catalogue.models.map((entry) => (entry.modelID === "kimi-k3" ? { ...entry, ...change } : entry)),
    })
    await setup.store.publish({ expectedHeadSha256: setup.head.sha256, catalogue, policy: setup.policy })
    expect(code(await setup.run((service) => service.snapshot().pipe(Effect.exit)))).toBe(want)
  })

  test("credential revision change cannot activate or snapshot old account availability", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    setup.state.revision = "offline-new-account"
    expect(code(await setup.run((service) => service.snapshot().pipe(Effect.exit)))).toBe("selection_required")
    expect(code(await setup.run((service) => service.activate(setup.activation()).pipe(Effect.exit)))).toBe(
      "selection_required",
    )
    expect((await setup.store.read()).head).toEqual(setup.head)
  })

  test("expired snapshots refresh metadata before expanding roles; failed refresh cannot reuse old data", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path)
    setup.state.now = 3_600_000
    const snapshot = await setup.run((service) => service.snapshot())
    expect(snapshot.routes.deliver.modelID).toBe("deepseek-v4-pro")
    expect(setup.state.requests).toBe(2)
    const head = (await setup.store.read()).head
    setup.state.now += 3_600_000
    setup.state.failed = true
    expect(code(await setup.run((service) => service.snapshot().pipe(Effect.exit)))).toBe("discovery_failed")
    expect((await setup.store.read()).head).toEqual(head)
  })

  test("volatile snapshots freshly observe account availability on every call", async () => {
    await using tmp = await tmpdir()
    const setup = await fixture(tmp.path, successors, true)
    expect((await setup.run((service) => service.snapshot())).routes.deliver.modelID).toBe("deepseek-v4-pro")
    expect(setup.state.requests).toBe(2)
    setup.state.observed = setup.state.observed.filter((entry) => entry.modelID !== "deepseek-v4-pro")
    expect(code(await setup.run((service) => service.snapshot().pipe(Effect.exit)))).toBe("model_unavailable")
    expect(setup.state.requests).toBe(4)
  })

  test("trusted legacy-policy bootstrap does not fabricate model prices or compatibility", async () => {
    await using tmp = await tmpdir()
    const references = ["kimi", "deepseek"].map((providerID) => ({
      referenceID: `offline-${providerID}`,
      revision: "offline-bootstrap",
      origin: origins[providerID as WorkflowModelCatalog.ProviderID],
    }))
    const serviceLayer = WorkflowModelCatalogService.layer({
      root: tmp.path,
      automatic: false,
      now: () => 1000,
      initialPolicy: (scopeSha256) => fixturePolicy(fixtureCatalogue({ scopeSha256 })),
    }).pipe(
      Layer.provide(
        Layer.succeed(WorkflowCredentialScope.Service, {
          resolve: (providerID) =>
            Effect.succeed(references.find((item) => item.referenceID === `offline-${providerID}`)!),
          credential: () => Effect.die("no key"),
        }),
      ),
      Layer.provide(
        Layer.succeed(WorkflowModelDiscovery.Service, {
          refresh: (providerID, scopeSha256) =>
            Effect.succeed(
              fixtureCatalogue({
                scopeSha256,
                observedAt: 1000,
                models: fixtureCatalogue()
                  .models.filter((entry) => entry.providerID === providerID)
                  .map((entry) => ({
                    ...entry,
                    family: "unknown",
                    compatibility: "unverified",
                    priceSha256: null,
                    protocol: null,
                    adapterProfileID: null,
                    adapterProfileSha256: null,
                  })),
              }),
            ),
        }),
      ),
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkflowModelCatalogService.Service
        const bootstrapped = yield* service.refresh(true)
        expect(bootstrapped.policy?.choices["kimi-flagship"].modelID).toBe("kimi-k3")
        expect(
          bootstrapped.catalogue?.models.every(
            (entry) => entry.priceSha256 === null && entry.compatibility === "unverified",
          ),
        ).toBe(true)
        expect(code(yield* service.snapshot().pipe(Effect.exit))).toBe("unverified_contract")
      }).pipe(Effect.scoped, Effect.provide(serviceLayer)),
    )
  })
})
