import type { ArmReport, ReportModel } from "./model"

export function reportHtml(value: ReportModel): string {
  const primary = value.armSummaries.filter((arm) => arm.armID === "A" || arm.armID === "B" || arm.armID === "C")
  const gate = value.contrasts.find((contrast) => contrast.label === "A-best-control")!
  const summary = decisionSummary(value, gate)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Task24 workflow-effect benchmark</title>
<style>${styles}</style>
</head>
<body>
<main data-task24-evaluate="report">
<header><p class="eyebrow">Campaign ${html(value.campaignID)}</p><h1>Task24 workflow-effect benchmark</h1><p class="stamp">Frozen report · ${html(humanDate(value.generatedAt))}</p></header>
<section aria-labelledby="summary"><h2 id="summary">Technical summary</h2><p class="lead"><strong>${html(decisionLabel(value.decision))}.</strong> ${html(summary)}</p><div class="metrics">${metric("Decision", decisionLabel(value.decision))}${metric("A vs best control", pp(gate.estimate))}${metric("95% interval", `${pp(gate.lower95)} to ${pp(gate.upper95)}`)}${metric("Cost ratio", value.cost.costRatio === null ? "Unavailable" : `${format(value.cost.costRatio)}×`)}</div></section>
<section aria-labelledby="findings"><h2 id="findings">Key findings</h2><p>Treatment and direct-control rates use completed, valid runs as the denominator. The bars show qualified success, while the tables preserve the exact functional and diagnostic context needed to interpret the comparison.</p>${rateChart(primary)}${armTable(primary)}${contrastTable(value)}<h3>Cost and efficiency</h3><p>Native ledgers remain in provider currency; conversion uses only the sealed exchange-rate snapshot. The combined treatment cost is ${html(cny(value.cost.totalCnyMicros))}, or ${html(value.cost.costPerQualifiedSuccessCnyMicros === null ? "unavailable" : cny(value.cost.costPerQualifiedSuccessCnyMicros))} per qualified success. Kimi spend is ${html(cny(value.cost.kimiCnyMicros))}; DeepSeek spend is ${html(usd(value.cost.deepseekUsdMicros))}.</p>${paretoTable(value)}<h3>Run diagnostics</h3><p>These secondary metrics explain how outcomes were reached; they do not replace the binary qualified-success endpoint. Uncached input is total input less provider-reported cache hits.</p>${runTable(value)}</section>
<section aria-labelledby="scope"><h2 id="scope">Scope and metric definitions</h2><p><strong>Qualified success</strong> requires a clean build, all mandatory functions and artifacts, visual composite of at least 75 with every required viewport at least 65, no integrity incident or human repair, and all sealed ceilings respected. Diagnostic score is secondary: function 45, visual 30, requirements 10, quality 10, and accessibility/responsive behavior 5.</p><p>The causal comparison is A against fork controls B and C over the primary tasks. D and E are contextual upstream controls and are never pooled into that estimate.</p></section>
<section aria-labelledby="method"><h2 id="method">Methodology</h2><p>Task IDs are the resampling clusters, so all repeats and arms for a selected task move together. The report uses 10,000 seeded bootstrap samples and the preregistered A-versus-better-control gate. Model output never judges model output; scores come from sealed tests, browser measurements, static checks, policy records, and content-addressed evidence.</p>${familyTable(value)}</section>
<section aria-labelledby="robustness"><h2 id="robustness">Limitations and robustness</h2>${list(value.limitations, "No limitations recorded.")}<p>Provider-side caching cannot always be disabled. Cached input tokens are reported separately, and cache-normalized usage is diagnostic only. This report does not establish that results generalize beyond the frozen tasks, binaries, model revisions, prices, exchange rate, and Windows environment.</p>${statusList("Exclusions", value.exclusions)}${statusList("Harness failures", value.harnessFailures)}</section>
<section aria-labelledby="next"><h2 id="next">Recommended next steps</h2><ol><li>Audit any failed preregistered rule against its content-addressed evidence before interpreting diagnostic subscores.</li><li>If this is a pilot, approve a new provider-native ceiling only after readiness is recorded; never reuse pilot approval for the full campaign.</li><li>Repeat only through the durable scheduler so spend, retries, and recovery remain attributable.</li></ol></section>
<section aria-labelledby="questions"><h2 id="questions">Further questions</h2><ul><li>Does the treatment effect remain positive in every task family?</li><li>Does the gain persist after accounting for cost per qualified success and provider cache variability?</li><li>Are failures concentrated in visual fidelity, functionality, accessibility, or infrastructure?</li></ul></section>
<section aria-labelledby="audit"><h2 id="audit">Reproducibility record</h2><dl class="hashes">${Object.entries(
    value.metadata,
  )
    .map(([key, hash]) => `<dt>${html(label(key))}</dt><dd><code>${html(hash)}</code></dd>`)
    .join(
      "",
    )}</dl><p>${format(value.evidenceHashes.length)} evidence hashes indexed. Raw prompts, request and response bodies, grants, credentials, and full model output are intentionally excluded.</p></section>
</main>
</body>
</html>`
}

function rateChart(values: readonly ArmReport[]): string {
  const rows = values
    .map((arm, index) => {
      const y = 42 + index * 58
      const width = Math.round(arm.qualifiedRate * 500)
      return `<text x="0" y="${y + 19}" class="axis">Arm ${arm.armID}</text><rect x="78" y="${y}" width="500" height="28" rx="4" class="track"/><rect x="78" y="${y}" width="${width}" height="28" rx="4" class="bar arm-${arm.armID.toLowerCase()}"/><text x="${Math.min(650, 90 + width)}" y="${y + 19}" class="value">${percent(arm.qualifiedRate)}</text>`
    })
    .join("")
  return `<figure><figcaption><strong>Qualified-success rate by arm</strong><br><span>Completed valid runs; exact values appear in the following table.</span></figcaption><svg role="img" viewBox="0 0 720 230" xmlns="http://www.w3.org/2000/svg"><title>Qualified-success rate by arm</title><desc>Horizontal bars comparing qualified-success rates for treatment arm A and direct controls B and C.</desc>${rows}</svg></figure>`
}

function armTable(values: readonly ArmReport[]): string {
  return `<div class="table-wrap"><table><caption>Primary-arm outcomes</caption><thead><tr><th>Arm</th><th>Qualified</th><th>Rate</th><th>Functional</th><th>Mean diagnostic</th></tr></thead><tbody>${values.map((arm) => `<tr><th scope="row">${arm.armID}</th><td>${arm.qualifiedSuccesses}/${arm.runs}</td><td>${percent(arm.qualifiedRate)}</td><td>${percent(arm.functionalRate)}</td><td>${format(arm.meanDiagnosticScore)}</td></tr>`).join("")}</tbody></table></div>`
}

function contrastTable(value: ReportModel): string {
  return `<div class="table-wrap"><table><caption>Task-clustered qualified-success contrasts</caption><thead><tr><th>Contrast</th><th>Estimate</th><th>95% lower</th><th>95% upper</th></tr></thead><tbody>${value.contrasts.map((item) => `<tr><th scope="row">${html(item.label)}</th><td>${pp(item.estimate)}</td><td>${pp(item.lower95)}</td><td>${pp(item.upper95)}</td></tr>`).join("")}</tbody></table></div>`
}

function runTable(value: ReportModel): string {
  const rows = value.runs.slice(0, 500)
  const outcome = `<div class="table-wrap"><table class="dense"><caption>Per-run outcome</caption><thead><tr><th>Run</th><th>Arm</th><th>Qualified</th><th>First functional</th><th>First visual</th><th>Diagnostic</th><th>Visual</th><th>Failure</th></tr></thead><tbody>${rows.map((run) => `<tr><th scope="row">${html(run.runID)}</th><td>${run.armID}</td><td>${yes(run.qualifiedSuccess)}</td><td>${yes(run.firstPassFunctionalSuccess)}</td><td>${yes(run.firstPassVisualSuccess)}</td><td>${format(run.diagnosticScore)}</td><td>${format(run.visualComposite)}</td><td>${html(run.failureCategory ?? "-")}</td></tr>`).join("")}</tbody></table></div>`
  const usage = `<div class="table-wrap"><table class="dense"><caption>Per-run time and token use</caption><thead><tr><th>Run</th><th>Minutes</th><th>Input</th><th>Cached</th><th>Uncached</th><th>Output</th><th>Tools</th></tr></thead><tbody>${rows.map((run) => `<tr><th scope="row">${html(run.runID)}</th><td>${format(run.durationMs / 60_000)}</td><td>${run.inputTokens}</td><td>${run.cachedInputTokens}</td><td>${run.inputTokens - run.cachedInputTokens}</td><td>${run.outputTokens}</td><td>${run.toolCalls}</td></tr>`).join("")}</tbody></table></div>`
  const recovery = `<div class="table-wrap"><table class="dense"><caption>Per-run change and recovery</caption><thead><tr><th>Run</th><th>Changed files</th><th>Retries</th><th>Revisions</th><th>Recoveries</th><th>Cost</th></tr></thead><tbody>${rows.map((run) => `<tr><th scope="row">${html(run.runID)}</th><td>${run.changedFiles}</td><td>${run.retries}</td><td>${run.revisionLoops}</td><td>${run.recoveryCount}</td><td>${html(cny(run.costCnyMicros))}</td></tr>`).join("")}</tbody></table>${value.runs.length > rows.length ? `<p class="note">Showing ${rows.length} of ${value.runs.length} runs; the deterministic CSV contains all rows.</p>` : ""}</div>`
  return outcome + usage + recovery
}

function paretoTable(value: ReportModel): string {
  const frontier = value.runs.filter(
    (run) =>
      !value.runs.some(
        (other) =>
          other.runID !== run.runID &&
          other.diagnosticScore >= run.diagnosticScore &&
          other.durationMs <= run.durationMs &&
          BigInt(other.costCnyMicros) <= BigInt(run.costCnyMicros) &&
          (other.diagnosticScore > run.diagnosticScore ||
            other.durationMs < run.durationMs ||
            BigInt(other.costCnyMicros) < BigInt(run.costCnyMicros)),
      ),
  )
  return `<div class="table-wrap"><table><caption>Quality/cost/time Pareto frontier</caption><thead><tr><th>Run</th><th>Arm</th><th>Diagnostic</th><th>Minutes</th><th>Cost</th></tr></thead><tbody>${frontier.map((run) => `<tr><th scope="row">${html(run.runID)}</th><td>${run.armID}</td><td>${format(run.diagnosticScore)}</td><td>${format(run.durationMs / 60_000)}</td><td>${html(cny(run.costCnyMicros))}</td></tr>`).join("")}</tbody></table></div>`
}

function familyTable(value: ReportModel): string {
  return `<div class="table-wrap"><table><caption>Family regression check</caption><thead><tr><th>Task family</th><th>Treatment effect</th><th>Pass</th></tr></thead><tbody>${value.familyChecks.map((item) => `<tr><th scope="row">${html(item.family)}</th><td>${pp(item.effect)}</td><td>${item.effect >= 0 ? "Yes" : "No"}</td></tr>`).join("")}</tbody></table></div>`
}

function decisionSummary(value: ReportModel, gate: ReportModel["contrasts"][number]): string {
  return `The preregistered A-versus-better-control effect is ${pp(gate.estimate)}, with a 95% task-clustered interval from ${pp(gate.lower95)} to ${pp(gate.upper95)}. ${value.decisionReasons.length === 0 ? "No decision reasons were recorded." : `Recorded rules: ${value.decisionReasons.map(label).join(", ")}.`}`
}

function statusList(title: string, values: readonly string[]): string {
  return `<h3>${html(title)}</h3>${list(values, `No ${title.toLowerCase()} recorded.`)}`
}

function list(values: readonly string[], empty: string): string {
  return values.length === 0
    ? `<p>${html(empty)}</p>`
    : `<ul>${values.map((item) => `<li>${html(item)}</li>`).join("")}</ul>`
}

function metric(name: string, value: string): string {
  return `<div class="metric"><span>${html(name)}</span><strong>${html(value)}</strong></div>`
}

function yes(value: boolean): string {
  return value ? "Yes" : "No"
}

function cny(micros: string): string {
  return money(micros, "¥")
}

function usd(micros: string): string {
  return money(micros, "$")
}

function money(micros: string, symbol: string): string {
  const value = BigInt(micros)
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")
  return `${symbol}${whole}${fraction ? `.${fraction}` : ""}`
}

function decisionLabel(value: ReportModel["decision"]): string {
  return value.replace(/^./, (letter) => letter.toUpperCase())
}

function percent(value: number): string {
  return `${format(value * 100)}%`
}

function pp(value: number): string {
  const amount = format(value * 100)
  return `${value > 0 ? "+" : ""}${amount} pp`
}

function format(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
}

function humanDate(value: string): string {
  return value.slice(0, 10)
}

function label(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
}

function html(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

const styles = `
:root{color-scheme:light dark;--bg:#f4f6fa;--paper:#fff;--ink:#172033;--muted:#5f6b7d;--line:#d9dfE8;--blue:#3567d6;--gold:#c58b23;--slate:#738198;--open:#e8edf5}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,"Segoe UI",Arial,sans-serif;line-height:1.55}main{width:min(980px,calc(100% - 32px));margin:32px auto;background:var(--paper);padding:56px 64px;border:1px solid var(--line);border-radius:16px;box-shadow:0 20px 50px #17203314}header{border-bottom:3px solid var(--ink);padding-bottom:24px}.eyebrow{font-size:.76rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:700}h1{font-size:2.35rem;line-height:1.08;margin:.25rem 0}.stamp{color:var(--muted)}section{padding:32px 0;border-bottom:1px solid var(--line)}section:last-child{border:0}h2{font-size:1.45rem;margin:0 0 12px}h3{font-size:1rem;margin:24px 0 8px}.lead{font-size:1.13rem}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:24px 0}.metric{border:1px solid var(--line);border-radius:10px;padding:14px;background:color-mix(in srgb,var(--paper) 92%,var(--blue))}.metric span{display:block;color:var(--muted);font-size:.78rem}.metric strong{font-size:1.06rem}figure{margin:24px 0;padding:18px;border:1px solid var(--line);border-radius:12px}figcaption span,.note{color:var(--muted);font-size:.88rem}svg{width:100%;height:auto;margin-top:14px}.track{fill:var(--open)}.bar{stroke:var(--ink);stroke-width:1}.arm-a{fill:var(--blue)}.arm-b{fill:var(--gold)}.arm-c{fill:var(--slate)}.axis,.value{fill:var(--ink);font-size:15px;font-weight:650}.table-wrap{overflow-x:auto;margin:20px 0}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}caption{text-align:left;font-weight:700;padding:0 0 8px}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}thead th{font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.dense{font-size:.78rem}.dense th,.dense td{padding:7px 8px}code{font-family:"Cascadia Mono",Consolas,monospace;font-size:.78rem;word-break:break-all}.hashes{display:grid;grid-template-columns:minmax(160px,1fr) 2fr;gap:8px 16px}.hashes dt{font-weight:650}.hashes dd{margin:0}@media(prefers-color-scheme:dark){:root{--bg:#10141c;--paper:#171d27;--ink:#edf2fa;--muted:#a8b2c2;--line:#343e4d;--open:#293241;--blue:#6f9afa;--gold:#e2ae52;--slate:#9aa9bd}}@media(max-width:720px){main{width:100%;margin:0;padding:32px 20px;border:0;border-radius:0}.metrics{grid-template-columns:1fr 1fr}.hashes{grid-template-columns:1fr}.hashes dd{margin-bottom:8px}}@media print{:root{color-scheme:light;--bg:#fff;--paper:#fff;--ink:#111827;--muted:#4b5563;--line:#d1d5db;--open:#eef2f7;--blue:#4d6fb8;--gold:#ad7a21;--slate:#6b7280}body{background:#fff}main{width:auto;margin:0;padding:0;border:0;box-shadow:none}section{break-inside:avoid}figure,table{break-inside:avoid}.metrics{grid-template-columns:repeat(4,1fr)}}`
