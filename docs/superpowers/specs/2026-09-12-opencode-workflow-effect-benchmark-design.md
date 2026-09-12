# OpenCode Workflow Effect Benchmark Design

**Status:** Approved in chat on 2026-09-12

**Scope:** Task24

## Purpose

Task24 determines whether the production workflow built in Tasks 1–23 improves real task outcomes. It does not re-test whether the Workflow, Responses, recovery, sandbox, or visual-host infrastructure merely runs. The decision is whether the fixed Kimi K3 and DeepSeek V4 role workflow should be preferred over direct single-model OpenCode use for visual web engineering.

The primary decision compares the complete workflow with direct-model controls on the same modified OpenCode runtime. Official upstream OpenCode controls provide external context but do not determine causality because upstream and the fork differ in more than orchestration.

## Decision hypotheses

The pre-registered hypotheses are:

1. The complete workflow increases qualified task success by at least 10 percentage points over the better direct-model control on the same fork.
2. The gain is present in both greenfield visual construction and existing-project visual repair, rather than coming from one task family alone.
3. Functional correctness and security do not regress materially.
4. The workflow keeps combined-currency cost per qualified success within 2.0 times the best direct control, using the sealed benchmark-start exchange rate.

If the data does not satisfy these conditions, the report must say `not demonstrated` or `inconclusive`. Infrastructure reliability, additional model calls, or a higher unqualified aesthetic score cannot substitute for qualified task success.

## Fixed treatment route

The treatment is the deployed production `visual-build` workflow:

| Role | Provider/model | Protocol | Effort |
|---|---|---|---|
| design | Kimi `kimi-k3` | Chat Completions | max |
| decompose | Kimi `kimi-k3` | Chat Completions | high |
| implement | DeepSeek `deepseek-v4-pro` | Responses | max |
| test | DeepSeek `deepseek-v4-flash` | Responses | high |
| visual_review | Kimi `kimi-k3` | Chat Completions | max |
| repair | DeepSeek `deepseek-v4-pro` | Responses | max |
| deliver | DeepSeek `deepseek-v4-pro` | Responses | high |

No model substitution, Kimi K2 fallback, DeepSeek protocol fallback, or silent effort downgrade is allowed. A route mismatch invalidates that run as harness failure rather than model failure.

## Experimental arms

Every selected primary task is evaluated through these five arms:

| Arm | Runtime | Agent/model behavior | Analytical purpose |
|---|---|---|---|
| A | modified OpenCode | complete fixed workflow | treatment |
| B | modified OpenCode | direct DeepSeek V4 Pro agent | isolates workflow gain against the main coding model |
| C | modified OpenCode | direct Kimi K3 agent | isolates multi-model specialization against the design/reasoning model |
| D | official upstream OpenCode | direct DeepSeek V4 Pro agent | external upstream control |
| E | official upstream OpenCode | direct Kimi K3 agent | external upstream control |

The primary contrasts are `A − B` and `A − C`. Contrasts involving D or E describe fork/upstream context only and must not be described as the causal workflow effect.

At campaign preflight, the runner resolves the latest immutable official OpenCode release, records its tag, commit, binary hash, and source URL, and freezes it for the full campaign. The currently observed release is `v1.18.30`; a newer release may replace it only before the pre-registration manifest is sealed. The treatment runtime is likewise frozen by source commit, deployed binary version, and SHA-256. No runtime changes are permitted between arms.

## Benchmark corpus

The primary corpus contains 12 visual web-engineering tasks, stratified before any paid run:

- four private product tasks covering text-to-interface construction, screenshot-guided construction, responsive behavior, accessibility, state, and a functional backend boundary;
- four Design2Code-Hard tasks selected by a deterministic seed from cases that can be rendered in the pinned Windows Chromium environment;
- four SWE-bench Multimodal JavaScript tasks selected by a deterministic seed from cases with a runnable user-interface reproduction and deterministic tests.

The private tasks are authored from clean seed repositories and are not derived from examples used to develop Tasks 1–23. Their hidden tests, reference screenshots, evaluator rules, and expected patches remain outside every admitted Location. The agent sees only the task prompt, public repository state, and explicitly supplied reference media.

Four non-visual coding tasks form a secondary guardrail corpus. Arms A/B/C run each guardrail task once to show where the visual workflow adds overhead or should not be selected. D/E do not run this corpus, and these cells do not contribute to the primary visual-workflow ranking.

Public benchmark use follows the official sources:

- Design2Code: <https://github.com/NoviScl/Design2Code>
- SWE-bench and SWE-bench Multimodal: <https://github.com/SWE-bench/SWE-bench>

Public benchmark contamination is a known limitation. The private stratum prevents a public-only result from controlling the decision.

## Unit of evaluation and repetitions

One run is one arm applied to one immutable task snapshot under one declared budget. Each primary A/B/C cell runs twice. D/E run once on the full primary corpus because they are contextual controls; if either upstream control falls within five percentage points of the best fork control after the first pass, that upstream arm receives a second pass so uncertainty is comparable.

Run order uses a deterministic balanced randomization across task, arm, and repetition. Runs execute serially by default so account throttling and host contention do not privilege one arm. The randomization seed is sealed into the pre-registration manifest.

## Fairness controls

All arms receive:

- the same task text and reference media;
- the same content-addressed seed repository;
- the same tool permission policy and allowed dependency set;
- the same aggregate input-token, output-token, tool-call, wall-time, and retry ceilings;
- a fresh D-drive workspace, data root, cache namespace, and process namespace;
- the same pinned compiler, package-manager, Docker, browser, viewport, font, locale, timezone, and operating-system settings;
- no network access except through the benchmark credential broker to the exact provider API hosts.

The direct controls receive no hidden stage prompts, design artifact, Kimi review, or workflow-generated decomposition. The treatment receives only the production behavior that a normal visual-build request creates. This preserves the product-level comparison instead of manually granting the controls treatment artifacts.

Provider-side cache hits cannot always be disabled. The runner records cached and uncached input tokens separately, randomizes arm order, and reports both actual billed cost and cache-normalized token consumption. A cache difference may explain cost but never changes task-quality scoring.

## Independent evaluator

The evaluator is outside the agent Location and has read-only access to the sealed gold bundle plus read access to the finished candidate workspace. No evaluated agent can call, edit, or inspect it.

Kimi visual review is part of Arm A and cannot score Arm A. No treatment model is used as the primary judge. Evaluation combines deterministic hidden tests, a pinned browser, automatic visual comparison, and a blinded human qualitative-audit protocol.

Each primary task defines:

- build and startup commands;
- hidden functional assertions;
- three fixed responsive viewports;
- reference screenshots and mask regions for nondeterministic content;
- DOM geometry, overflow, interaction, and accessibility assertions;
- forbidden file, dependency, network, test-mutation, and security changes;
- task-specific requirement assertions;
- allowed visual tolerances established before the pre-registration seal.

The automatic visual evaluator uses the same pinned Chromium build for every arm. The 100-point visual composite is fixed as 35 points for aligned structural similarity, 20 for normalized pixel/color similarity, 25 for DOM geometry agreement, 10 for typography/style-token agreement, and 10 for responsive layout and interaction-state agreement. It also reports official Design2Code metrics where applicable and every component separately. A missing component is a harness failure; weights are never redistributed.

Human review is used only to audit cases whose automatic visual composite is from 70 through 79 inclusive and to provide final qualitative examples. Reviewers see anonymized pairs in randomized order, with model/runtime identifiers removed. Human preference never changes automatic scores or qualified-success status.

## Metrics

### Primary KPI: qualified success rate

For a run, `qualified_success = 1` only when all conditions hold:

1. the clean build and launch succeed;
2. every hard functional assertion passes;
3. the task's visual composite reaches at least 75/100 and no viewport falls below 65/100;
4. every mandatory requirement assertion passes;
5. no security, hidden-test mutation, evaluator access, forbidden network, or out-of-scope workspace violation occurs;
6. no unplanned human intervention is required;
7. the run finishes within its sealed budget.

Qualified success rate is the mean of `qualified_success` across task/repetition cells. Task-family rates are always reported beside the overall rate.

### Diagnostic quality score

The 100-point diagnostic score is:

| Dimension | Weight | Source |
|---|---:|---|
| functional correctness | 45 | hidden tests and interaction assertions |
| visual fidelity | 30 | screenshot and geometry evaluators |
| explicit requirement compliance | 10 | task manifest assertions |
| code/build quality | 10 | typecheck, lint, dependency and change-scope checks |
| accessibility and responsive behavior | 5 | automated accessibility and viewport assertions |

Security violations, hidden-test mutation, evaluator access, or fabricated evidence force the diagnostic score to zero. The diagnostic score explains results; it does not replace the primary KPI.

### Driver metrics

- first-pass functional success;
- first-pass visual success;
- number and type of repair loops;
- tool calls and changed-file count;
- input, cached-input, reasoning, and output tokens by provider/model/role;
- stage and total wall time;
- terminal API errors, rate limits, retries, timeouts, and recovery events.

### Guardrails

- zero security or evaluator-isolation violations;
- treatment functional success may not trail the best fork direct control by more than five percentage points;
- no arm may receive more aggregate token, tool, time, or retry budget than another arm for the same task budget class;
- unplanned human intervention is zero; a required intervention makes the run unqualified and is reported;
- no credential, authorization header, raw secret, or unredacted provider payload appears in artifacts.

### Efficiency metrics

- native-currency cost per run;
- native-currency and sealed-exchange-rate combined cost per qualified success;
- qualified successes per million aggregate tokens;
- median and P95 time per qualified success;
- quality/cost and quality/time Pareto frontiers.

Provider costs are computed from returned usage fields and a sealed price table captured from the official pricing pages at campaign start. Kimi and DeepSeek charges remain in their native billing currencies in raw results. A presentation-only combined currency uses one dated, cited exchange-rate snapshot and never alters budget enforcement.

## Statistical decision rule

Analysis is paired by task. The report includes task-level outcomes, stratified family outcomes, paired differences, and a 10,000-resample cluster bootstrap confidence interval over tasks. Repetitions stay within their task cluster.

The workflow is declared demonstrated only if:

- Arm A exceeds the better of B/C by at least 10 percentage points in qualified success;
- the lower bound of the paired 95% bootstrap interval is above zero;
- Arm A is non-negative in every primary task family;
- the functional and security guardrails pass; and
- Arm A's combined-currency cost per qualified success is no more than 2.0 times that of the better qualified-success direct fork control.

If the point estimate exceeds 10 points but the interval crosses zero, the conclusion is `promising but inconclusive`. If the quality condition passes only by exceeding the 2.0 cost ratio, the conclusion is `quality gain at disproportionate cost`, not demonstrated effectiveness.

Weights, thresholds, selected task IDs, masks, random seed, budgets, comparison rules, and retry policy are hashed and sealed before the first scored provider call. Any post-seal change creates a new campaign ID and invalidates combination with the earlier campaign.

## Paid-usage safety

Task24 has four release gates:

1. **Task24A — offline harness:** implement and verify corpus materialization, adapters, metering, evaluators, scoring, reporting, and synthetic-provider tests with zero paid calls.
2. **Task24B — calibration pilot:** run one task from each primary family across all five arms, once, only after the user approves explicit Kimi CNY and DeepSeek USD caps.
3. **Task24C — scored campaign:** derive provider-specific caps from pilot P95 usage multiplied by planned cells and a 20% reserve; display the exact caps and require new user approval before dispatch.
4. **Task24D — report:** freeze results and generate the leaderboard, uncertainty analysis, failure taxonomy, case studies, HTML dashboard, CSV/JSON exports, and PDF report.

The credential broker runs on loopback, receives secrets only from the existing D-drive provider environment at process start, and gives workers short-lived benchmark tokens plus local base URLs. It forwards only the exact Kimi Chat and DeepSeek Responses paths and model IDs required by the manifest. It records status, model, timing, and usage but never request/response bodies or authorization headers.

Before each provider dispatch, the broker proves that the maximum possible charge under the request token ceiling fits within the remaining provider-specific cap. A cap breach durably pauses the campaign before dispatch. It never rounds past a cap, automatically increases a cap, or resumes without an explicit user action.

Rate-limit and transient transport failures receive the sealed infrastructure retry policy and keep the same cell identity. A provider/model terminal failure is an observed run failure. Harness failures are separated from model failures and must be fixed before the campaign resumes; completed valid cells are not rerun.

## D-drive layout

All Task24 state is rooted at `D:\OpenCode-Benchmark\Task24`:

```text
D:\OpenCode-Benchmark\Task24
├── assets       # content-addressed public/private seed bundles and gold data
├── cache        # benchmark-only dependency and dataset cache
├── toolchain    # pinned upstream binary and evaluator runtimes
├── workspaces   # isolated candidate Locations
├── runs         # sealed manifests, sanitized events, patches and evaluator outputs
├── reports      # HTML, PDF, CSV and JSON deliverables
└── tmp          # disposable same-volume staging
```

No Task24 cache, dataset, browser profile, temporary directory, workspace, result, or report may be placed on C. The Windows account home may remain on C, but all benchmark-owned paths must be explicitly redirected and verified. Test cleanup can delete only an authenticated descendant of `workspaces` or `tmp`; assets, runs, reports, source repositories, production deployment, and user directories are never cleanup roots.

## Benchmark architecture

Task24 consists of seven isolated units:

1. **Manifest and pre-registration:** validates corpus identity, arms, budgets, evaluator rules, price snapshot, runtime hashes, randomization, and campaign seal.
2. **Workspace materializer:** restores one content-addressed task seed into a fresh D-drive Location and proves isolation before and after execution.
3. **Arm adapters:** invoke production workflow, fork-direct DeepSeek, fork-direct Kimi, upstream-direct DeepSeek, and upstream-direct Kimi through one run contract.
4. **Credential and metering broker:** restricts provider/model/protocol access, enforces spend caps, and emits body-free usage records.
5. **Run scheduler:** balances order, enforces budgets, resumes by cell identity, and distinguishes model, infrastructure, evaluator, and harness failures.
6. **Evaluator:** runs hidden functional/security checks, deterministic browser captures, visual/DOM/accessibility scoring, and blinded-review packaging.
7. **Reporter:** computes paired metrics and uncertainty from immutable run records and renders machine-readable plus human-readable artifacts.

Each unit exposes a versioned schema. Raw provider streams, chain-of-thought, API keys, and authorization headers are never benchmark artifacts. Sanitized final text may be retained only when required to audit task delivery.

## Reporting contract

The final report leads with the decision, not the composite score. It includes:

- a five-arm leaderboard with qualified success and confidence intervals;
- the primary A−B and A−C paired effects;
- task-family breakdowns;
- functional, visual, accessibility, quality, reliability, time, token, and cost diagnostics;
- cost/quality and time/quality frontiers;
- every exclusion and harness failure;
- anonymized visual comparisons and representative successful/failed patches;
- a limitations section covering public-data contamination, sample size, provider variability, cache effects, and Windows-only execution;
- immutable campaign, runtime, task, evaluator, and report hashes.

Outputs are `summary.json`, `cells.csv`, `leaderboard.html`, `report.pdf`, sanitized per-cell records, patches, screenshots, and evaluator logs under the D-drive report root. The HTML and PDF must be reproducible from the machine-readable records without contacting a provider.

## Source references

- OpenCode immutable releases: <https://github.com/anomalyco/opencode/releases>
- Kimi API and current K3 pricing: <https://platform.kimi.com/>
- DeepSeek model and pricing table: <https://api-docs.deepseek.com/quick_start/pricing>
- Design2Code official benchmark: <https://github.com/NoviScl/Design2Code>
- SWE-bench official repository and Multimodal data: <https://github.com/SWE-bench/SWE-bench>

## Non-goals

Task24 does not:

- tune prompts, role routing, thresholds, or models after observing scored outcomes;
- train or fine-tune a model;
- claim that Kimi or DeepSeek is generally superior outside the tested tasks;
- use a model-as-judge as primary evidence;
- reimplement or re-grade the Task23 infrastructure acceptance suite;
- publish a public leaderboard submission automatically;
- spend any API balance before a provider-specific cap is explicitly approved.

## Definition of done

Task24 is complete when the offline harness is independently verified, the user-approved pilot and scored campaign finish or are explicitly stopped by a budget gate, every valid cell is reproducible from its hashes, and the final D-drive report states one of the pre-registered conclusions without changing tasks, thresholds, weights, or exclusions after results are known.
