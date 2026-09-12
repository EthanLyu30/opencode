import { describe, expect, test } from "bun:test"
import fixture from "../fixtures/report/campaign.json"
import { reportCsv } from "../../src/report/csv"
import { decodeReportModel } from "../../src/report/model"

describe("Task24 CSV report", () => {
  test("emits a stable, spreadsheet-safe run table", () => {
    const csv = reportCsv(decodeReportModel(fixture))
    expect(csv).toStartWith("run_id,task_id,family,arm_id,qualified_success")
    expect(csv).toContain("run-a,task-1,dashboard,A,true")
    expect(csv).not.toContain("prompt")
    expect(csv).not.toContain("request_body")
    expect(csv.endsWith("\r\n")).toBe(true)
  })

  test("neutralizes spreadsheet formulas", () => {
    const value = structuredClone(fixture)
    value.runs[0]!.failureCategory = '=WEBSERVICE("bad")'
    expect(reportCsv(decodeReportModel(value))).toContain("'=WEBSERVICE")
  })
})
