import { describe, expect, test } from "bun:test"
import fixture from "../fixtures/report/campaign.json"
import { reportHtml } from "../../src/report/html"
import { decodeReportModel } from "../../src/report/model"

describe("Task24 self-contained technical report", () => {
  test("renders the answer first, accessible evidence, definitions, methods, limits, and next steps", () => {
    const html = reportHtml(decodeReportModel(fixture))
    expect(html).toContain("<h1>Task24 workflow-effect benchmark</h1>")
    expect(html.indexOf("Technical summary")).toBeLessThan(html.indexOf("Key findings"))
    expect(html).toContain('<svg role="img"')
    expect(html).toContain("<title>Qualified-success rate by arm</title>")
    expect(html).toContain("Scope and metric definitions")
    expect(html).toContain("Methodology")
    expect(html).toContain("Limitations and robustness")
    expect(html).toContain("Recommended next steps")
    expect(html).toContain("Further questions")
    expect(html).toContain("@media print")
    expect(html).toContain("@media(max-width:720px)")
    expect(html).toContain('data-task24-evaluate="report"')
    expect(html).toContain("Per-run time and token use")
    expect(html).toContain("Per-run change and recovery")
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/)
    expect(html).not.toContain("<script")
    expect(contrast("#172033", "#ffffff")).toBeGreaterThanOrEqual(4.5)
    expect(contrast("#5f6b7d", "#ffffff")).toBeGreaterThanOrEqual(4.5)
  })

  test("escapes all report-controlled text", () => {
    const value = structuredClone(fixture)
    value.limitations = ["<script>alert(1)</script>"]
    const html = reportHtml(decodeReportModel(value))
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;")
  })
})

function contrast(foreground: string, background: string): number {
  const luminance = (value: string) => {
    const channels = value
      .slice(1)
      .match(/.{2}/g)!
      .map((channel) => Number.parseInt(channel, 16) / 255)
      .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
    return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
  }
  const left = luminance(foreground)
  const right = luminance(background)
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)
}
