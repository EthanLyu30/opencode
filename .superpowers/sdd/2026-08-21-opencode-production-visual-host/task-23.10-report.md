# Task 23.10 implementation report

## Result

Task 23.10 is implemented locally in commit
`13dcaeed1176fa4e7aea731066042a857f02dfe8`
(`feat(opencode): run production workflows`) from base
`aae9ea8a0f740a580c36d4fbfe87d6a0e8a89ade`.

The implementation adds `opencode workflow run <prompt>` and an explicit
`@opencode-ai/client` workspace dependency to `packages/opencode`. It uses the
generated Promise client against the real in-process
`Server.Default().app.fetch` composition, adding the existing
`ServerAuth.header()` value when configured. It does not reuse the legacy
Session `run.ts` loop.

The implementation commit changes 9 files with 1,605 insertions and 39
deletions. No Task 23.9 Protocol, Server, or generated-client file is modified.
This report records implementation and self-verification evidence only. It does
not claim that a separate independent review is clean or complete.

## Admission and local composition

- Argument validation precedes creation of one in-memory UUID per invocation.
- One logical `workflow.visualBuildCreate` admission is made with
  `delivery: "background"`. The bounded transport retry reuses that UUID as the
  generated client's `Idempotency-Key`; replay, history, terminal reads, and
  artifact reads never re-admit.
- The generated client receives encoded `process.cwd()` only through the
  trusted `x-opencode-directory` Location header. The exact admission body is
  limited to `prompt`, `budget`, `visual`, and `delivery`; placement,
  directory/workspace, model/provider, URL, command, and argv are absent.
- The explicit conservative defaults are one visual revision, a 20,000-token /
  20-turn / 40-tool-call / 3-attempt / 30-minute workflow budget, and a
  12,000-token / 12-turn / 24-tool-call visual budget.
- The deterministic process fixture rejects an unstable UUID, raw Location,
  an extra body field, duplicate accepted admission, or terminal fetches in the
  wrong order. The successful fixture deliberately throws once at transport so
  the same-key retry path is exercised without a provider.

## Durable observer and cancellation

The observer omits `after` on the first SSE replay. Later connections use the
exclusive `after: lastSeq` cursor, discard duplicate/old events, and repair a
gap with ascending `history({ after: lastSeq, limit: 100 })` pages through
`hasMore: false`. Each recovered cursor advances only after its event is
processed, and the pending live SSE event is then processed. Reconnection uses
bounded backoff and does not re-admit.

Durable event authority requires both `data.workflowID` and
`durable.aggregateID` to match the admitted Workflow. Domain/schema errors are
not misclassified as reconnects. Display labels come only from persisted
`workflow.created` Stage definitions and the frozen route matrix:

- Kimi K3: `design`, `decompose`, `visual_review`.
- DeepSeek V4 Pro: `implement`, `repair`, `deliver`.
- DeepSeek V4 Flash: `test`.

Prompt prose, event metadata, provider output, and artifact contents do not
influence those labels. Test evidence, visual evidence, and allowlisted budget
thresholds have compact safe progress messages. Approval returns exit 2 only
after a same-Workflow detail read confirms `waiting_approval`. Workflow detail,
the same linked Response, and artifact summaries are fetched in that order only
after a terminal durable Workflow event.

After admission, the first SIGINT aborts only observation, invokes exactly one
un-aborted durable cancel request, awaits its acknowledgement, emits the final
safe object, sets exit code 130, and returns without waiting for host teardown.
The normal first-signal path does not call `process.exit`; a second signal may
force exit 130. The signal listener is removed in `finally`, and settled-event
and cancel-once latches cover admission/signal/terminal races.

On Windows, Bun's parent-side `ChildProcess.kill("SIGINT")` terminates the child
without delivering the JavaScript listener. The deterministic preload fixture
therefore emits `SIGINT` from inside the real CLI child after the observer has
started. This exercises the production process listener, observer abort,
un-aborted delayed cancel acknowledgement, output, exit code, and prompt child
exit rather than mistaking an operating-system hard kill for cancellation.

## Output and exit contract

Human progress is written only to stderr. `--format json` writes exactly one
final stdout object with allowlisted Workflow, Response, and artifact summary
fields. Output shaping excludes request input, unrestricted output/error,
provider/model authority, credentials, preview environment, capability URI,
artifact metadata/hash, and image/base64 bytes. Known product artifact kinds
and MIME types are allowlisted; unknown values fail closed to
`workflow.artifact` and `application/octet-stream`.

The deterministic process matrix injects raw-output, raw-error, provider,
credential, preview-environment, metadata, base64, loopback-capability, and
`workflow://` sentinels and proves none reach stdout or stderr. Exact exit codes
are covered: success 0; failed/admission/transport/schema 1; confirmed waiting
approval (including budget exhaustion) 2; terminal cancellation and SIGINT 130.

## TDD evidence

Implementation followed focused RED/GREEN cycles:

- The first observer/CLI test run failed before production code existed with 0
  pass, 1 fail, and 1 module-resolution error.
- The first real process runs exposed that the existing harness assumed `bun`
  was on PATH and that preload options were ordered before `bun run`. The
  generalized harness now uses the running pinned Bun executable, one shared
  subprocess ownership path, live stderr readiness, and a provider-free
  fixture; the legacy TestLLM wrapper remains a thin compatible layer.
- A durable-authority RED expected `Workflow event authority is invalid` but
  received `Workflow event reconnect delay failed`; schema/authority errors now
  propagate immediately.
- Admission transport/schema process RED returned the fixture's fallback
  cancellation code 130; explicit offline failure scenarios now prove the
  required redacted exit 1 object.
- A real delivery MIME RED received `application/octet-stream`; the final safe
  allowlist contains the frozen Workflow artifact MIME contracts while still
  redacting unknown values.
- The final Task 23.10 file passes 9 tests with 57 assertions.

## Fresh verification

All commands used pinned Bun
`D:\OpenCode-Toolchain\bun-1.3.14\bun-windows-x64\bun.exe` from
`packages/opencode`, with `TEMP`, `TMP`, and Bun cache under the task-owned
`D:\OpenCode-Task23.10` root while tests were running.

- Combined Task 23.10/help and focused legacy process matrix: **32 pass, 0
  fail, 154 assertions, 36 snapshots** across 5 files.
- `packages/opencode` `tsgo --noEmit`: exit 0.
- Exact authored-file Prettier check: exit 0.
- Exact changed-TypeScript oxlint: **0 warnings, 0 errors**.
- `git diff --check`: exit 0.
- Final scope audit: 9 changed implementation files; 0 Task 23.9
  Protocol/Server/generated files; 0 sensitive filenames; 0 secret literal
  signatures; 0 legacy Session-loop reference.
- The only URL literals are the synthetic injected-fetch base
  `http://opencode.internal` and an intentionally redacted loopback test
  sentinel. No provider, external network, browser, Docker, paid, deployment,
  push, or secret-reading action was performed.

Task 23.11 system-level crash/security acceptance was not run or implemented in
Task 23.10.

## Cleanup

The exact task-owned root `D:\OpenCode-Task23.10` was verified as a normal
non-reparse directory. Its three Bun-cache junction entries and all three
targets were confined beneath that same root. The root was then moved as one
Shell item to the Windows Recycle Bin; the original path no longer exists.
Repository inputs and user-owned files were preserved.
