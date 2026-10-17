# Task6 raw matrix failures, skips and todo

These names describe completed pre-fix and intermediate runs, not a passing final gate. No paid provider requests were enabled. No test was removed or newly skipped by this plan. Suite-specific conditional skips are retained; the single CLI todo is pre-existing. The final verification report separately records the final gate.

CLI full: 3309 pass / 58 skip / 1 todo / 21 fail; 3389 tests, 255 files, 8926 assertions, 1551.19s. All four failed files were rerun unchanged in isolated processes and remained red. The image case is blocked by the local offline guard treating a local data: URI as outbound; this is not evidence of a live provider attempt. The help snapshot exposes line-wrapping of the unusually long task temporary path. The other19HTTP failures are not classified as baseline without further evidence.

## Core

Intermediate review-fix full Core run:1779pass/7skip/5fail (191files,217.39s). All five were subsequently green in the full Core rerun:1784pass/7skip/0fail (219.71s,5707assertions), without changing the old visual test or production visual code.

- (fail, resolved) WebFetchTool registration > follows redirects while approving only the requested URL — offline guard now follows only independently revalidated local redirects.
- (fail, resolved) Workflow Location tools > coding delivery consumes its genuine stored admission context without treating the receipt as provider input — direct test route now uses admitted effective caps.
- (fail, resolved) Workflow Location tools > coding code-review uses the existing provider engine and only read-only tools — coding fixture now carries actual admission limits.
- (fail, resolved) Workflow Location tools > coding test checkpoints retain exact host checks and replay a settled provider turn without another call — same fixture correction.
- (fail, resolved) PreviewPlan.freeze > observes pinned Bun running lifecycle hooks around a no-env-file package script — runner selects the pinned native Bun before global wrappers, so the deliberately unsafe child in this owned characterization remains genuine; the test itself is unchanged.

The interrupted Core launch before the self-contained PATH correction has no final result and is not counted as a passing run.

## Intermediate Server acceptance

Latest Server full rerun:481pass/1fail,482tests/22files,1881assertions,357.88s. All10recorded coding cases pass. New blocker, not modified or suppressed:

- (fail) VisualHostClaim generation registry > serializes a real pending rollback ahead of its paused owner without leaving an orphan mirror — actual error `Visual host cleanup retirement pending identity changed`.
- (fail, separate whole-file diagnostic) VisualHostClaim generation registry > arbitrates the same claim key once across real processes while a different key stays nonblocking —58pass/1fail in59tests,71.76s; a separate strict-D existing-worker probe reproduced `database is locked` in one of three rounds.

Both legacy source/tests were unchanged when these failures occurred. The user subsequently approved the narrow safety fixes. Two new tests fail on the exact COMMIT-busy and already-published pending-inode states; no old assertion or timeout is relaxed. Complete regression verification remains required rather than repeating until a lucky green.

- (fail, resolved) recorded nonvisual coding acceptance > blocking code review drives a measured repair instead of bypassing the reviewer — new effective12-turn fixture cap correctly produced `workflow_budget_exhausted` after two real passing check rounds and two source-reading reviews. Full-success fixture now explicitly admits20turns; a separate retained12-turn case asserts the budget pause and no delivery. Both pass in the final487-test Server run. Production defaults, accounting and user limits are unchanged.

The first new Server typecheck also caught a plain String instead of branded `RelativePath` in the disposable-build test input. Corrected test-only; the subsequent Server typecheck passed.

## Core unchanged platform skips

- (skip) Watcher > symlinked .git > publishes .git/HEAD events through a symlinked .git directory
- (skip) pty > retains exited sessions until removed
- (skip) pty > replays buffered output and streams live output to attachments
- (skip) pty > stops delivering output after detach
- (skip) pty > isolates output between sessions
- (skip) pty > notifies attachments with the exit code and rejects attach after exit
- (skip) pty create defaults > defaults command, login args, and cwd from config and location

## CLI

Intermediate full rerun:3293pass/58skip/1todo/37fail,3389tests/255files,8848assertions,1214.88s. Multiple streamed HTTP bodies failed in the owned network guard because it reused `args[1].body` after constructing a Request. New real streamed POST and307local-redirect tests first failed; all7guard tests now pass. This helper correction does not change production HTTP code. The complete CLI final gate remains required. The37intermediate failure names follow:

- event HttpApi > hides a complete workflow Session batch without reordering ordinary public events
- experimental HttpApi > returns declared worktree errors
- experimental HttpApi > serves Console org switch through the default server app
- provider HttpApi > serves OAuth authorize response shapes
- provider HttpApi > returns declared provider auth validation errors
- provider HttpApi > returns declared provider auth callback errors
- schema-rejection wire shape > Payload schema rejection returns NamedError-shaped JSON, not empty
- schema-rejection wire shape > rejected request body never echoes back unbounded — message is capped
- session HttpApi > returns declared not found errors for read routes
- session HttpApi > uses the persisted session directory for prompt requests
- session HttpApi > returns v2 public not found errors for missing sessions
- session HttpApi > durably records one v2 prompt for exact message-ID retries
- session HttpApi > serves lifecycle mutation routes
- session HttpApi > persists selected workspace id when creating a session
- session HttpApi > validates archived timestamp values
- session HttpApi > lists sessions created through an equivalent directory hint
- session HttpApi > lists Windows sessions for equivalent directory spellings
- session HttpApi > lists Windows sessions created through the global worktree sentinel
- session HttpApi > serves message mutation routes
- session HttpApi > rejects part updates whose path and body ids disagree
- session HttpApi > serves remaining non-LLM session mutation routes
- sync HttpApi > serves sync routes
- sync HttpApi > validates seq values
- HttpApi workspace routing middleware > proxies remote workspace HTTP requests through the selected workspace target
- HttpApi workspace routing middleware > waits for sync fence headers from remote workspace HTTP responses
- workspace HttpApi > serves mutation endpoints
- workspace HttpApi > returns a declared not found error when warping into a missing workspace
- workspace HttpApi > creates workspace with the TUI payload shape
- workspace HttpApi > routes local workspace requests through the workspace target directory
- workspace HttpApi > proxies remote workspace HTTP requests with sanitized forwarding
- workspace HttpApi > proxies remote workspace requests selected from session ownership
- project directories and copies endpoints > lists directories and manages git worktree copies
- session action routes > session routes expose metadata on create, update, get, and fork
- tui.selectSession endpoint > should return200when called with valid session
- tui.selectSession endpoint > should return404when session does not exist
- tui.selectSession endpoint > should return400when session ID format is invalid
- HttpApi workspace proxy > proxies HTTP request and returns streamed response with status and headers

- (fail) opencode CLI help-text snapshots > every documented command emits stable help text
- (skip) direct footer recreates the frame across command panel transitions
- (skip) direct footer dispatches leader variant binding only when leader is registered
- (skip) direct footer skill picker inserts an editable bound skill command
- (skip) direct footer clears the synthetic skills draft when the panel closes
- (skip) direct custom answer submits through keymap return binding
- (skip) renders replayed user, reasoning, and assistant output after completion
- (skip) workspace CRUD > sessionWarp detaches to the source project when invoked from a workspace instance
- (skip) Worktree > makeWorktreeInfo > creates detached git worktree when info has no branch
- (skip) Worktree > createFromInfo > creates git worktree and boots asynchronously
- (skip) experimental HttpApi > serves worktree mutations through the default server app
- (skip) HttpApi Server.listen > serves HTTP routes and upgrades PTY websocket through Server.listen
- (skip) HttpApi Server.listen > stop(true) is safe when called concurrently and repeatedly
- (skip) HttpApi Server.listen > stop(true) can force a graceful stop already in progress
- (skip) HttpApi Server.listen > graceful stop waits for an overlapping forced stop
- (fail) HttpApi Server.listen > default in-process handler does not emit Effect HTTP response logs
- (skip) HttpApi Server.listen > rejects unsafe PTY ticket mint and connect requests
- (skip) HttpApi Server.listen > keeps PTY websocket tickets optional when server auth is disabled
- (skip) provider HttpApi > returns public v2 provider not found errors
- (skip) pty HttpApi bridge > serves PTY JSON routes through experimental Effect routes
- (skip) pty HttpApi bridge > hides exited sessions on the legacy surface
- (skip) pty HttpApi bridge > disposes PTY sessions with their legacy instance
- (skip) pty HttpApi bridge > serves PTY websocket output and input through Effect routes
- (fail) HttpApi SDK > uses the generated SDK for global and control routes
- (fail) HttpApi SDK > uses the generated SDK for safe instance routes
- (fail) HttpApi SDK > routes configured SDK directory and workspace for v2 location GETs
- (fail) HttpApi SDK > matches generated SDK global and control behavior
- (fail) HttpApi SDK > matches generated SDK global event stream
- (fail) HttpApi SDK > matches generated SDK instance event stream
- (fail) HttpApi SDK > matches generated SDK missing session errors
- (fail) HttpApi SDK > formats missing session validation errors for -s
- (fail) HttpApi SDK > uses generated SDK basic auth behavior
- (fail) HttpApi SDK > matches generated SDK instance read routes
- (fail) HttpApi SDK > matches generated SDK session lifecycle routes
- (fail) HttpApi SDK > matches generated SDK session message and part routes
- (fail) HttpApi SDK > streams sync-backed part updates to /event subscribers
- (fail) HttpApi SDK > matches generated SDK prompt no-reply routes
- (fail) HttpApi SDK > matches generated SDK prompt streaming through fake LLM
- (fail) HttpApi SDK > includes project skills in REST API prompt context
- (fail) HttpApi SDK > matches generated SDK TUI validation and command routes
- (fail) HttpApi SDK > matches generated SDK project git initialization
- (skip) sync HttpApi > returns structured validation errors
- (skip) v2 pty HttpApi > serves location-wrapped PTY routes and retains exited sessions
- (skip) v2 pty HttpApi > rejects connect tokens without the CSRF header and connects with a valid ticket
- (skip) v2 pty HttpApi > serves PTY websocket output and input through the canonical route
- (skip) v2 pty HttpApi > applies plugin shell environment before forced PTY values
- (skip) worktree endpoint reproduction > direct HttpApi worktree create returns without waiting for boot
- (skip) worktree endpoint reproduction > direct HttpApi worktree create accepts missing body
- (skip) worktree endpoint reproduction > direct HttpApi worktree create accepts missing content type and body
- (skip) worktree endpoint reproduction > direct HttpApi worktree create rejects explicit null payload
- (skip) worktree endpoint reproduction > workspace worktree create does not hang
- (skip) worktree endpoint reproduction > workspace worktree create returns without waiting for project start command
- (skip) session.compaction.create > projects a compaction message to v2 (v2 projector disabled)
- (todo) Instruction.resolve > fetches remote instructions from config URLs via HttpClient
- (skip) session.llm native recorded > OpenAI API key: drives a tool loop to a final text answer
- (fail) session.llm.stream > accepts user image attachments as data URLs for OpenAI models
- (skip) prompt emits v2 prompted and synthetic events (v2 projector disabled)
- (skip) shell captures stdout and stderr in completed tool output
- (skip) shell completes a fast command on the preferred shell
- (skip) shell uses configured shell over env shell
- (skip) shell commands can change directory after startup
- (skip) shell lists files from the project directory
- (skip) shell captures stderr from a failing command
- (skip) shell updates running metadata before process exit
- (skip) command ! expansion uses configured shell over env shell
- (skip) cancel interrupts shell and resolves cleanly
- (skip) cancel persists aborted shell result when shell ignores TERM
- (skip) cancel finalizes interrupted bash tool output through normal truncation
- (skip) cancel interrupts loop queued behind shell
- (skip) shell rejects when another shell is already running
- (skip) StructuredOutput Integration > produces structured output with simple schema
- (skip) StructuredOutput Integration > produces structured output with nested objects
- (skip) StructuredOutput Integration > works with text outputFormat (default)
- (skip) StructuredOutput Integration > stores outputFormat on user message
- (skip) unicode filenames modification and restore
- (skip) subdirectory snapshots treat wildcard characters literally
- (skip) subdirectory snapshots treat leading colons literally
- (skip) step snapshots carry over to assistant messages
- (skip) text ended populates assistant text content
- (skip) tool completion stores completed timestamp

## Benchmark

- (skip) Task24 offline security and leakage acceptance > verifies real binary terminal/network rejection and records empty logs without invalid references
- (skip) Task24 offline crash and recovery matrix > converges eight crash points without duplicate dispatch or conflicting results
- (skip) Task24 browser integration > rejects inert controls and static empty labels; every keyboard control needs an observable effect
- (skip) Task24 browser integration > captures identical pixels, DOM/styles, Axe, and accessibility summaries three times at every viewport
- (skip) Task24 browser integration > denies evaluator-triggered popup, download, and navigation escape
- (skip) Task24 browser integration > returns a typed uncertain failure when the deterministic wait condition times out
- (skip) Task24 browser integration > blocks external subresources before any network hit and records the denial
- (skip) candidate import cannot recover hidden vector input from process environment, argv, stdin or mounted files
- (skip) timeout removes the daemon-owned container, not just docker.exe
- (skip) prints byte-identical PDFs twice through the authenticated Node/Chromium helper

## LLM

- (skip) Anthropic Messages sad-path recorded > rejects malformed assistant tool order
- (skip) Bedrock Converse cache recorded > writes then reads cachePoint on identical second call
- (skip) OpenAI Chat gpt-4o-mini recorded > streams text
- (skip) OpenAI Chat gpt-4o-mini recorded > streams tool call
- (skip) OpenAI Chat gpt-4o-mini recorded > drives a tool loop
- (skip) OpenAI Chat gpt-4o-mini recorded > reads image returned from tool result
- (skip) OpenAI Responses gpt-5.5 recorded > streams text
- (skip) OpenAI Responses gpt-5.5 recorded > streams tool call
- (skip) OpenAI Responses gpt-5.5 recorded > drives a tool loop
- (skip) OpenAI Responses WebSocket gpt-4.1-mini recorded > drives a tool loop
- (skip) Anthropic Haiku 4.5 recorded > streams text
- (skip) Anthropic Haiku 4.5 recorded > streams tool call
- (skip) Anthropic Opus 4.7 recorded > drives a tool loop
- (skip) Gemini 2.5 Flash recorded > streams text
- (skip) Gemini 2.5 Flash recorded > streams tool call
- (skip) Gemini 2.5 Flash recorded > reads image returned from tool result
- (skip) xAI Grok 3 Mini recorded > streams text
- (skip) xAI Grok 3 Mini recorded > streams tool call
- (skip) xAI Grok 4.3 recorded > drives a tool loop
- (skip) DeepSeek Chat recorded > streams text
- (skip) TogetherAI Llama 3.3 70B recorded > streams text
- (skip) TogetherAI Llama 3.3 70B recorded > streams tool call
- (skip) Groq Llama 3.3 70B recorded > streams text
- (skip) Groq Llama 3.3 70B recorded > streams tool call
- (skip) Groq Llama 3.3 70B recorded > drives a tool loop
- (skip) OpenRouter gpt-4o-mini recorded > streams text
- (skip) OpenRouter gpt-4o-mini recorded > streams tool call
- (skip) OpenRouter gpt-4o-mini recorded > drives a tool loop
- (skip) OpenRouter gpt-5.5 recorded > drives a tool loop
- (skip) OpenRouter Claude Opus 4.7 recorded > drives a tool loop
