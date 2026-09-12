import { describe, expect, test } from "bun:test"
import fixture from "../fixtures/report/campaign.json"
import { reportJson } from "../../src/report/json"
import { decodeReportModel } from "../../src/report/model"

describe("Task24 JSON report", () => {
  test("serializes the validated report byte-identically", () => {
    const model = decodeReportModel(fixture)
    expect(reportJson(model)).toBe(reportJson(model))
    expect(JSON.parse(reportJson(model))).toEqual(model)
  })

  test.each([
    [{ ...fixture, apiKey: "forbidden" }, "TASK24_REPORT_FIELD_FORBIDDEN"],
    [{ ...fixture, limitations: ["Authorization: Bearer forbidden"] }, "TASK24_REPORT_SECRET_FORBIDDEN"],
    [{ ...fixture, prompt: "full model prompt" }, "TASK24_REPORT_FIELD_FORBIDDEN"],
  ])("rejects keys, bodies, prompts, and credential-shaped durable text", (value, error) => {
    expect(() => decodeReportModel(value)).toThrow(error)
  })
})
