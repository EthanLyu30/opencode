import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

const tracked = resolve(import.meta.dir, "../../../benchmarks/task24")

async function json(name: string) {
  return Bun.file(resolve(tracked, name)).json()
}

describe("tracked Task24 configuration", () => {
  test("ships parseable campaign and task JSON schemas", async () => {
    const campaign = await json("schemas/campaign.schema.json")
    const task = await json("schemas/task.schema.json")
    expect(campaign.$schema).toBe("https://json-schema.org/draft/2020-12/schema")
    expect(campaign.required).toContain("schemaVersion")
    expect(campaign.required).toContain("sha256")
    expect(task.required).toEqual(["id", "kind", "stratum", "family", "bundleSha256", "goldSha256"])
  })

  test("pins the five intended treatment arms in the template", async () => {
    const template = await json("campaign.template.json")
    expect(template.$schema).toBeUndefined()
    expect(template.arms.map((arm: { id: string }) => arm.id)).toEqual(["A", "B", "C", "D", "E"])
    expect(JSON.stringify(template)).not.toContain("kimi-k2")
    expect(JSON.stringify(template)).toContain("deepseek-v4-pro")
    expect(JSON.stringify(template)).toContain("deepseek-v4-flash")
  })

  test("ignores secrets and local benchmark outputs", async () => {
    const ignore = await Bun.file(resolve(tracked, ".gitignore")).text()
    expect(ignore).toContain(".env*")
    expect(ignore).toContain("campaign.sealed.json")
    expect(ignore).toContain("gold")
    expect(ignore).toContain("runs")
  })
})
