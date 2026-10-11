# Workflow Model Catalogue and Upgrade Policy Design

**Date:** 2026-10-11

**Status:** Approved for implementation planning on 2026-10-11. The user adopted the production-host extension route and explicitly confirmed “自动发现、确认启用” after the written-spec handoff, then approved its implementation plan. MC1 contracts/pure rules are committed as `22fc28b70`; MC2 trusted discovery/storage is committed and pushed as `c9d89a014`. The user-approved Windows-only Snapshot test deadline correction is `6b196530c`; the corrected full Core suite passes. MC3–MC7 and deployment remain pending. See the implementation plan's execution checkpoints for proof and implementation decisions.

## Intent and place in the readiness work

The user's product is a role-based local workflow: Kimi supplies design, decomposition and review; DeepSeek supplies implementation, testing, repair and delivery. The product must offer newly released models without keeping model identifiers permanently compiled into every layer. Old generations must leave the new-task choices after their validated replacements are activated. Kimi 2.6/2.7 must not return as a fallback.

The adopted production-host extension is split into independently reviewable deliverables:

1. This catalogue/route-snapshot subsystem: discover choices, validate adapter compatibility, select replacements, retire old choices and freeze admitted routes.
2. A separate nonvisual production-entry design: reuse Location, permissions, durable Workflow/Responses and bounded repair; no forced screenshots for code-only tasks.
3. A separate library preview/evaluation design: reproducible public reproductions and sealed independent evaluators shared across A–E.
4. A separate live benchmark-execution design: actual brokered dispatch, cancellation, recovery and reports, not row planning alone.

Deliverable 1 precedes the other interface changes so they do not copy the current fixed-ID policy. It does not implement the other three deliverables. After all readiness changes, rebuild/redeploy as necessary, freeze a new campaign and repeat Task24A before requesting a paid pilot. The existing sealed offline campaign and historical records are never edited or relabeled.

## Current-code evidence

- `packages/core/src/workflow/routing.ts` fixes role policies and the `Route.modelID` type to three identifiers.
- `packages/llm/src/capabilities.ts` recognizes only the three manually registered model profiles.
- `packages/llm/src/providers/kimi.ts` rejects any identifier other than `kimi-k3`.
- `packages/core/src/workflow/admission.ts` already constructs an admission route matrix; make its selected catalogue/policy identity durable rather than resolving a changing global default again on recovery.
- `packages/core/src/models-dev.ts` already refreshes generic metadata while the process runs. Reuse existing model-list surfaces, but generic metadata is not authority to enable an unsupported workflow protocol.
- Benchmark arm definitions, capability fixtures, protocol proofs, price revisions and seals also contain fixed IDs. A new benchmark must carry a selected model snapshot; broadening production choice must not silently broaden an old seal's allowlist.

## Discovery is not activation

The baseline upgrade policy is **automatic discovery and choice publication; explicit activation of a replacement**. The user asked for new choices, not permission to silently change paid model use or prices.

When a compatible successor is discovered, show it with its applicable roles, changed capabilities, limits and pricing status. Confirming that choice atomically updates the role policy for future tasks and retires the predecessor from normal new-task choices. No provider, role family or protocol is substituted after an error.

If the user wants automatic activation instead, that is an explicit policy change to this specification. It still cannot cross a spend approval, change an admitted workflow, bypass compatibility validation or mutate a campaign seal.

## Sources and trust boundary

Use the configured provider's first-party, authenticated model-discovery endpoint through the runtime credential boundary. Discovery performs metadata GET requests only; it never sends a completion or Responses request to probe a new model without separately approved spend.

DeepSeek documents `GET /models` and model metadata such as display name, context/output limits, modalities and supported effort levels. Its published metadata is useful but does not prove every required Responses feature. Cross-check the protocol contract rather than deriving Responses compatibility from an identifier. [DeepSeek model-list reference](https://api-docs.deepseek.com/api/list-models/), [Responses reference](https://api-docs.deepseek.com/api/create-response/).

For Kimi, verify the current first-party model-list endpoint and its actual schema before enabling its discovery adapter. The intended existing CN endpoint is `https://api.moonshot.cn/v1/models`, not a third-party gateway. The Kimi documentation pages attempted during this design were not reliably readable through the documentation reader; no new live catalogue, exact response fields or account access has been verified. Missing discovery metadata remains an explicit unsupported/configuration state, not a fabricated catalogue. [Kimi official documentation entry](https://platform.kimi.com/docs/api/overview).

MC2 follow-up on 2026-10-11: the [first-party model-list reference](https://platform.kimi.com/docs/api/list-models) is now readable and its endpoint/schema projection was reviewed and hashed before parser implementation. Offline tests validate its identity/context/capability fields; no authenticated account access or generation was verified. This documentation evidence does not prove successor lineage, price or an alternate wire contract, and does not change the existing Kimi Chat adapter. Exact source descriptors and hashes are recorded in the implementation plan.

Official release/compatibility metadata establishes model lineage and adapter contracts. Do not rank model IDs lexicographically, infer chronology from list order, treat an arbitrary `created` timestamp as release order, or use a third-party alias as proof of the underlying model.

Provider responses are untrusted data. Allow only configured first-party HTTPS origins, deny redirects, and enforce a 10-second deadline, 2 MiB response ceiling and 256-model ceiling per refresh. Model metadata may not install code, alter endpoints, supply tool commands, weaken secret scanning, or grant permissions. Operational logs contain counts, status and hashes only; store only validated, sanitized catalogue fields.

## Catalogue contract

A catalogue is an immutable, canonically hashed snapshot. It contains schema version, provider origin identity, successful observation time, metadata/contract revision hashes and sanitized model entries. Each model entry binds:

- exact provider/model identifier and display name;
- documented family and successor relationship, or an explicit unknown lineage;
- release/revision identity where the provider exposes one;
- context/output limits, modalities, reasoning effort values and per-protocol capability evidence;
- an adapter contract profile and profile revision;
- pricing revision/status, without claiming discovery metadata supplies a billing quote;
- separate availability, compatibility and lifecycle statuses.

Availability is `available`, `missing` or `unknown`. Compatibility is `unverified`, `supported` or `incompatible`. Lifecycle is `current`, `superseded` or `deprecated`. Role selection belongs to a separate versioned policy, not to a globally mutable `selected` flag on an entry.

New entries are visible as candidates while compatibility is unverified. They cannot dispatch provider work. An eligible route requires available status, a supported adapter contract, every role-required capability/effort, permitted family/generation, and an applicable price revision before metered execution. Unknown lineage cannot automatically supersede any existing family.

## Role and protocol policy

Keep provider responsibilities, not version strings, as the stable policy:

| Responsibility                       | Permitted family                                       | Required protocol / capabilities                                                                                                         |
| ------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Design, decomposition, visual review | Kimi flagship, K3 or a validated same-family successor | Chat adapter contract; structured output, required tool choice and reasoning replay; image input additionally required for visual review |
| Implementation, repair, delivery     | DeepSeek coding/Pro family or its validated successor  | Native Responses adapter contract, structured output and required tool choice                                                            |
| Testing                              | DeepSeek Flash family or its validated successor       | Native Responses adapter contract, structured output and required tool choice                                                            |

The existing high/max role effort policy remains exact. Unsupported effort is not silently normalized into a weaker level. A new Flash model never retires Pro; a specialized Kimi model does not replace the flagship visual role merely because it was published later. Provider/model/protocol failures use existing bounded retry/approval semantics, never another model.

Do not remove provider validation just to accept arbitrary names. Make it profile-driven: identifier selection is separate from the wire contract. A new model sharing a verified contract may use the existing adapter without a rebuild; a new protocol or changed wire semantics requires a tested adapter update and redeployment. Automatic discovery cannot guarantee compatibility with every future API redesign.

## Refresh, selection and retirement

Refresh on application/service startup when the last successful snapshot is older than 60 minutes; while that service runs, check for a due refresh hourly. Provide explicit manual refresh. No recurring desktop-thread automation is created. When OpenCode is closed, discovery is not running; the next launch refreshes it.

Use the existing process-scoped service/resource conventions and a cross-process lock for snapshot publication. Invalid, truncated, unauthorized or failed refreshes never replace a valid snapshot and never retire models. Retain the last verified snapshot with a visible stale/discovery-error status. This is catalogue caching, not model fallback.

An identifier missing from two successful, complete refreshes at least 60 minutes apart becomes unavailable for new admissions. A single missing entry is not proof of retirement. Explicit first-party deprecation may mark a model deprecated immediately. An operator-selected compatible successor marks its documented predecessor superseded for new-task choices; preserve both records for audit.

Expose the active role selections and replacement candidates through the shared CLI/API model-selection boundary. Changing a role selection validates all affected roles, records the exact model/profile/pricing changes and atomically publishes one new policy revision. Updating some roles and leaving an incompatible partial policy is forbidden.

Activation does not send a billable probe. It cannot create a spend approval. If the selected model/pricing differs from an existing approved envelope, admission pauses before dispatch until a matching envelope is approved. No conversion or borrowing between Kimi CNY and DeepSeek USD is permitted.

## Admission, recovery and reproducibility

At admission, persist the exact selected route matrix, catalogue hash, policy hash, adapter revisions, capability evidence and applicable price identities. Link the delivery Response to that exact model. Recovery restores this snapshot, not today's catalogue defaults.

Retiring a model from new choices does not delete old Sessions, Responses, workflow artifacts, usage ledgers, approvals, or configuration history. An already admitted task can continue on its exact model while the provider still supports it. If that model becomes unavailable, enter an explicit model/configuration approval state; never redispatch settled calls or replace the model silently.

If only a rolling model alias exists, persist the available advertised revision and acknowledge that provider weights cannot be pinned beyond what the provider exposes. Metadata/advertised-revision drift invalidates a scored campaign before further dispatch. Do not claim an unchanged ID proves unchanged weights or silently combine cross-revision results.

Old seals retain their exact model/protocol/price allowlists. Selecting a new model for benchmarking creates a new campaign with newly validated contracts/prices; it does not rewrite old outcomes, make old hashes current, or make fake-provider scores live-model evidence.

## D-drive placement and credential ownership

Deploy catalogue snapshots and role-policy history under `D:\OpenCode-Local\data\workflow-model-catalog`; place catalogue-owned transient/cache data under the existing D-drive deployment roots. Reusable libraries receive roots through runtime composition rather than hard-code D paths.

The runtime credential boundary obtains configured credentials without printing or duplicating them. No agent, UI, child workflow, catalogue file, event or report receives plaintext provider keys. Do not read or copy `.env.local` during ordinary development or offline validation. Benchmark discovery must remain in the trusted credential/metering boundary and outside measured arm tools.

All development tests use deterministic local transports and fake metadata. A credentialed model-list check and any billable compatibility probe are distinct opt-in verification gates, not required to claim the offline subsystem passes.

## Error and rollback contract

- Failed refresh: retain the last verified snapshot and report a body-free discovery error; do not empty choices or infer deprecation.
- Unknown capabilities/lineage: display the candidate with its limitation; do not dispatch or guess a replacement.
- Unsupported API semantics: require an adapter update, without Chat/Responses fallback.
- Retired selection for a new task: require an eligible choice before creating executable work.
- Missing pinned model during recovery: explicit configuration/approval state, preserving completed results.
- Price/approval mismatch: stop before dispatch; no silent cap increase.
- Corrupt snapshot/hash or policy conflict: fail closed and preserve evidence; no partial activation.

Rollback can reactivate a prior policy only when its models are currently available, compatible and allowed by the user's generation policy. It cannot reintroduce Kimi 2.x or override provider retirement. Deployment rollback binaries and historical records remain recoverable.

## Offline acceptance

Tests must prove:

1. A new compatible fake Kimi flagship and DeepSeek Pro/Flash appear as candidates without recompiling fixed model identifiers; Kimi 2.x remains excluded.
2. An unknown model, unsupported protocol, missing visual capability or weaker effort cannot dispatch and cannot retire a supported family.
3. One Flash successor does not retire Pro; unknown/specialized lineage does not replace Kimi visual review.
4. Explicit activation publishes a coherent policy and removes superseded models from new-task choices, without deleting history.
5. Refresh timeout, 401/429/5xx, invalid JSON, duplicate/conflicting IDs, malicious fields, oversized replies and redirects preserve the last good snapshot and do not expose keys.
6. One missing response does not retire a model; the two-observation policy and explicit deprecation are deterministic under an injected clock.
7. Two concurrent processes cannot publish conflicting or partially written snapshots; restart reproduces the committed hash.
8. Existing admitted work and delivery Responses stay on their pinned model after catalogue/policy updates; settlement replay never repeats calls.
9. A genuinely unavailable pinned model stops for explicit configuration resolution rather than changing routes.
10. New model/pricing selections cannot reuse incompatible approvals or alter sealed benchmark manifests.
11. Rolling-alias drift is explicit and cannot be misreported as an immutable model lock.
12. CLI/API choices agree, discovery is metadata-only, ordinary unrelated providers are unchanged, and all owned runtime data/cache/temp paths remain on D in the deployment.

After written-spec approval, write a focused implementation plan with covering red/green tests, generated-client steps if public Protocol changes, clean-source build/deploy gates for runtime changes, scoped commits/pushes and a no-paid-call verification gate. Do not implement the other readiness subsystems inside this task.
