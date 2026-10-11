import { expect, test } from "bun:test"
import { Schema } from "effect"
import { WorkflowModelCatalog } from "@opencode-ai/schema/workflow-model-catalog"
import { WorkflowModelCatalogPolicy } from "../src/workflow/model-catalog/policy"
import { fixtureCatalogue, fixtureEntry, fixturePolicy, fixtureScope } from "./fixtures/workflow-model-catalog"

const { eligible, normalizeCatalogue, mergeObservation, replacePolicy } = WorkflowModelCatalogPolicy

test("a verified same-family successor satisfies all three Kimi roles", () => {
  const entry = fixtureEntry("kimi-flagship", { modelID: "kimi-successor-fixture", predecessor: "kimi-k3" })
  expect(
    ["design", "decompose", "visual_review"].map((role) =>
      eligible(entry, role as "design" | "decompose" | "visual_review"),
    ),
  ).toEqual([true, true, true])
  expect(eligible({ ...entry, compatibility: "unverified" }, "design")).toBe(false)
  expect(eligible({ ...entry, evidence: [] }, "design")).toBe(false)
  expect(eligible(entry, "implement")).toBe(false)
})

test("rejects Kimi 2.x despite claimed flagship lineage", () => {
  const current = fixtureCatalogue().models.find((entry) => entry.providerID === "kimi")!
  for (const modelID of ["kimi-k2.7", "kimi-k2.6", "kimi-2.7", "KIMI-K2", "kimi-k2-thinking"])
    expect(eligible({ ...current, modelID, family: "kimi-flagship" }, "visual_review")).toBe(false)
})

test("unknown or specialized lineage cannot supply a flagship role", () => {
  expect(eligible(fixtureEntry("kimi-flagship", { family: "unknown" }), "visual_review")).toBe(false)
  expect(eligible(fixtureEntry("kimi-flagship", { lifecycle: "superseded" }), "design")).toBe(false)
  expect(eligible(fixtureEntry("kimi-flagship", { lifecycle: "deprecated" }), "design")).toBe(false)
})

test("missing role capabilities and exact high or max effort fail closed", () => {
  const kimi = fixtureEntry("kimi-flagship")
  expect(
    eligible({ ...kimi, capabilities: kimi.capabilities.filter((cap) => cap !== "vision_input") }, "visual_review"),
  ).toBe(false)
  expect(eligible({ ...kimi, effortLevels: ["high"] }, "design")).toBe(false)
  expect(eligible({ ...kimi, effortLevels: ["max"] }, "decompose")).toBe(false)
  expect(eligible({ ...kimi, protocol: "openai-responses" }, "design")).toBe(false)
  expect(eligible({ ...kimi, adapterProfileSha256: "d".repeat(64) }, "design")).toBe(false)
  expect(eligible({ ...kimi, priceSha256: null }, "design")).toBe(false)
  expect(eligible({ ...kimi, availability: "unknown" }, "design")).toBe(false)
  expect(eligible(fixtureEntry("deepseek-pro", { capabilities: ["responses"] }), "implement")).toBe(false)
})

test("normalization is order independent and rejects provider-list created fields", () => {
  const catalogue = fixtureCatalogue()
  expect(normalizeCatalogue({ ...catalogue, models: [...catalogue.models].reverse() }, fixtureScope).sha256).toBe(
    catalogue.sha256,
  )
  expect(() =>
    normalizeCatalogue(
      { ...catalogue, models: catalogue.models.map((entry) => ({ ...entry, created: 9999999999 })) },
      fixtureScope,
    ),
  ).toThrow()
  expect(fixturePolicy(catalogue).choices).toEqual({
    "kimi-flagship": { providerID: "kimi", modelID: "kimi-k3" },
    "deepseek-pro": { providerID: "deepseek", modelID: "deepseek-v4-pro" },
    "deepseek-flash": { providerID: "deepseek", modelID: "deepseek-v4-flash" },
  })
})

test("only two complete missing observations an hour apart mark unavailable", () => {
  const previous = fixtureCatalogue()
  const observed = fixtureCatalogue({ models: previous.models.filter((entry) => entry.providerID !== "kimi") })
  const first = mergeObservation(previous, observed, 0)
  expect(first.models.find((entry) => entry.providerID === "kimi")?.availability).toBe("available")
  const early = mergeObservation(first, observed, 3599999)
  expect(early.models.find((entry) => entry.providerID === "kimi")?.availability).toBe("available")
  const missing = mergeObservation(early, observed, 3600000)
  expect(missing.models.find((entry) => entry.providerID === "kimi")?.availability).toBe("missing")
  expect(
    mergeObservation(missing, fixtureCatalogue({ observedAt: 3600001 }), 3600001).models.find(
      (entry) => entry.providerID === "kimi",
    )?.missingObservation,
  ).toBeNull()
})

test("observation rejects backwards time and cross-account scope", () => {
  const previous = fixtureCatalogue({ observedAt: 100 })
  expect(() => mergeObservation(previous, fixtureCatalogue(), 99)).toThrow()
  expect(() => mergeObservation(previous, fixtureCatalogue({ scopeSha256: "e".repeat(64) }), 101)).toThrow()
})

test("duplicate IDs, conflicting profiles, unknown fields and secrets are rejected", () => {
  const catalogue = fixtureCatalogue()
  expect(() =>
    normalizeCatalogue({ ...catalogue, models: [...catalogue.models, catalogue.models[0]] }, fixtureScope),
  ).toThrow()
  expect(() =>
    normalizeCatalogue(
      { ...catalogue, models: [...catalogue.models, { ...catalogue.models[0], adapterProfileSha256: "d".repeat(64) }] },
      fixtureScope,
    ),
  ).toThrow()
  expect(() => normalizeCatalogue({ ...catalogue, unexpected: true }, fixtureScope)).toThrow()
  expect(() =>
    normalizeCatalogue(
      { ...catalogue, models: [{ ...catalogue.models[0], displayName: "Bearer offlinecanary12345" }] },
      fixtureScope,
    ),
  ).toThrow()
  expect(() =>
    normalizeCatalogue(
      {
        ...catalogue,
        models: [
          {
            ...catalogue.models[0],
            evidence: [{ ...catalogue.models[0].evidence[0], url: "https://untrusted.invalid/docs" }],
          },
        ],
      },
      fixtureScope,
    ),
  ).toThrow()
})

test("a Flash successor only retires Flash after explicit replacement", () => {
  const previous = fixtureCatalogue()
  const successor = fixtureEntry("deepseek-flash", {
    modelID: "deepseek-flash-successor-fixture",
    predecessor: "deepseek-v4-flash",
  })
  const catalogue = fixtureCatalogue({ models: [...previous.models, successor] })
  const policy = fixturePolicy(catalogue)
  const result = replacePolicy({
    catalogue,
    policy,
    replacements: [{ family: "deepseek-flash", providerID: "deepseek", modelID: successor.modelID }],
  })
  expect(result.policy.choices["deepseek-flash"].modelID).toBe("deepseek-flash-successor-fixture")
  expect(result.policy.choices["deepseek-pro"].modelID).toBe("deepseek-v4-pro")
  expect(result.catalogue.models.find((entry) => entry.modelID === "deepseek-v4-flash")?.lifecycle).toBe("superseded")
  expect(catalogue.models.find((entry) => entry.modelID === "deepseek-v4-flash")?.lifecycle).toBe("current")
  expect(() =>
    replacePolicy({
      catalogue,
      policy,
      replacements: [{ family: "deepseek-pro", providerID: "deepseek", modelID: successor.modelID }],
    }),
  ).toThrow()
})

test("a descendant cannot be replaced by its predecessor or unknown lineage", () => {
  const previous = fixtureCatalogue()
  const successor = fixtureEntry("kimi-flagship", { modelID: "kimi-successor-fixture", predecessor: "kimi-k3" })
  const catalogue = fixtureCatalogue({
    models: [
      ...previous.models,
      successor,
      fixtureEntry("kimi-flagship", { modelID: "kimi-unrelated-fixture", predecessor: null }),
    ],
  })
  const result = replacePolicy({
    catalogue,
    policy: fixturePolicy(catalogue),
    replacements: [{ family: "kimi-flagship", providerID: "kimi", modelID: successor.modelID }],
  })
  expect(() =>
    replacePolicy({ ...result, replacements: [{ family: "kimi-flagship", providerID: "kimi", modelID: "kimi-k3" }] }),
  ).toThrow()
  expect(() =>
    replacePolicy({
      catalogue,
      policy: fixturePolicy(catalogue),
      replacements: [{ family: "kimi-flagship", providerID: "kimi", modelID: "kimi-unrelated-fixture" }],
    }),
  ).toThrow()
})

test("activation and refresh schemas reject injected trust fields and duplicate families", () => {
  expect(() =>
    Schema.decodeUnknownSync(WorkflowModelCatalog.RefreshInput)({ force: true, origin: "https://untrusted.invalid" }),
  ).toThrow()
  const replacement = { family: "deepseek-pro", providerID: "deepseek", modelID: "deepseek-v4-pro" }
  expect(() =>
    Schema.decodeUnknownSync(WorkflowModelCatalog.ActivationInput)({
      expectedHeadSha256: fixtureScope,
      replacements: [replacement, replacement],
    }),
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(WorkflowModelCatalog.ActivationInput)({
      expectedHeadSha256: fixtureScope,
      replacements: [{ ...replacement, capabilities: ["responses"] }],
    }),
  ).toThrow()
})

test("compiled profile descriptors cannot be mutated by callers", () => {
  const profile = WorkflowModelCatalog.adapterProfile("kimi-chat-k3-v1")!
  expect(() => (profile.capabilities as string[]).push("responses")).toThrow()
  expect(WorkflowModelCatalog.adapterProfile("arbitrary-profile")).toBeUndefined()
  expect(WorkflowModelCatalog.adapterProfile("kimi-chat-k3-v1")?.capabilities.includes("responses")).toBe(false)
})

test("a provider cannot borrow the other provider's contract evidence", () => {
  const entry = fixtureEntry("deepseek-pro", { evidence: fixtureEntry("kimi-flagship").evidence })
  expect(eligible(entry, "implement")).toBe(false)
  expect(() => fixtureCatalogue({ models: [entry] })).toThrow()
})

test("normalization rejects cyclic or cross-family predecessor claims", () => {
  const base = fixtureEntry("deepseek-pro", { predecessor: "deepseek-pro-successor-fixture" })
  const successor = fixtureEntry("deepseek-pro", {
    modelID: "deepseek-pro-successor-fixture",
    predecessor: base.modelID,
  })
  expect(() => fixtureCatalogue({ models: [base, successor] })).toThrow()
  expect(() =>
    fixtureCatalogue({
      models: [fixtureEntry("deepseek-flash"), fixtureEntry("deepseek-pro", { predecessor: "deepseek-v4-flash" })],
    }),
  ).toThrow()
})
