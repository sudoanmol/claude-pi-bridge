# Agent experience improvements

Findings from a live Claude Code session on 2026-10-02 that used the bridge against the `cloud-swe` repository. Claude ran `codex_models`, three `codex_ask` turns meant as one conversation, and `codex_status`. It did not use `codex_task` or `codex_review`.

Each finding gives what happened, the cause in this repository, and the fix. They are ordered by severity.

## 1. Continuing a session silently starts a new thread

**Observed.** Each `codex_ask` that passed the previous `session_id` returned a different `session_id`. `codex_status` showed a different `thread_id` for each one. Six `codex app-server --listen stdio://` processes were alive after the session ended. Turn 3 only seemed to remember turn 2 because Claude's prompt repeated the earlier content.

**Cause.** The MCP handler passes the raw arguments to `bridge.session(args)` (`src/mcp-server.mjs:92`). `Bridge.session` destructures `sessionId` (`src/bridge.mjs:13`), but the tool schema sends `session_id`. The lookup misses, so `randomUUID()` creates a new session, a new app-server process, and a new thread. `codex_review` has the same bug (`src/mcp-server.mjs:100`). `codex_task` and `codex_models` call `bridge.get(args.session_id)` and are not affected.

**Fix.**

- Map `session_id` to `sessionId` in one place in `callTool`.
- Throw `Unknown bridge session` when a caller passes a `session_id` that does not exist, instead of creating a new session under that ID.
- Add a test that makes two `codex_ask` calls with the same `session_id` and asserts one `thread/start` and two `turn/start` requests on the same thread.

## 2. Model and effort can change in the middle of a thread

**Observed.** Claude switched from `gpt-6-astra`/`medium` to `gpt-6.1-sol`/`high` between turns that were meant to share a thread. Finding 1 hid the problem here, but `run()` sends `model` and `effort` with every `turn/start` (`src/bridge.mjs:93-98`). Once continuation works, a mid-thread switch will reach Codex.

**Why it matters.** A different model cannot reuse the provider's prompt cache for the thread. The next turn re-reads and rebills the whole conversation as uncached input, and that cost grows with every turn. A different reasoning effort can also change the cache key. The README's "Deliberate limits" section already says to use a separate session for a different model configuration, but the code does not enforce that.

**Fix.**

- Fix `model` and `effort` when the session is created. Store them on `CodexSession` and send those values on every `turn/start`.
- When `session_id` is present, reject `model` or `effort` values that differ from the session's own. The error should say to start a new session.
- Return the session's `model` and `effort` from every tool result and from `codex_status`, so the caller can see what it is paying for.
- Update the tool descriptions: "`model` and `effort` apply only when starting a session; see `codex_models` for valid values."

## 3. Codex asks clarifying questions as plain text

**Observed.** Claude asked Codex to clarify with its question mechanism before answering. Codex wrote the question as its final message. The turn completed with `questions: null`, and `codex_status` showed `pending_question: null`, so `codex_answer` could not be used.

**Cause, unverified.** The developer instructions name `request_user_input` (`src/bridge.mjs:60`). The `item/tool/requestUserInput` handler works in the fake app-server test (`test/mcp.test.mjs:49`), but a live turn never sent that request. Codex may not offer that tool to the model in this thread configuration, for example outside a planning collaboration mode or without a feature flag. Check this against the installed Codex app-server (0.160.0) before changing the instructions.

**Fix.**

- Confirm which thread or turn settings make `request_user_input` available, and set them in `thread/start`.
- Add a live smoke test in which the prompt forces a clarification and the test asserts `status: "question"`.
- Until that works, keep the README and tool descriptions accurate about what to expect.

**Status.** The bridge now uses Codex's `plan` collaboration mode for read-only ask and review sessions. A live `gpt-6-astra` test produced `item/tool/requestUserInput`; workspace-write tasks keep the normal collaboration mode.

**Resolved.** In a later retest with `gpt-6.1-sol`/`medium` on Codex 0.160.0, the turn completed with `status: "completed"` and the question in plain text. The rollout log (`~/.codex/sessions/2026/10/02/rollout-2026-10-02T17-10-48-01a0ff19-….jsonl`) shows that in plan mode Codex called `request_user_input_async`, not `request_user_input`:

1. Its first call failed with `unknown field 'question', expected 'title' or 'options'`.
2. Its second call returned `{"accepted":true}`.
3. Codex slept for 1 s and ended the turn.

The async variant sends no server request. The question arrives on the `agentMessage` thread item as `questions: AsyncUserInputQuestion[]` (`{ title, options? }`, per `codex app-server generate-json-schema`), and Codex expects the answer as the next user turn. The bridge now detects that item and sends the answer as the next turn on the same thread.

The synchronous handler remains in place because which question mechanism Codex uses depends on the model.

## 4. `codex_steer` cannot reach an active turn

**Observed.** Each `codex_ask` blocked for 25–56 seconds and returned only after the turn completed. An agent that calls tools one at a time never has an active turn to steer.

**Fix.** Let the caller start a turn and get control back right away, for example with `wait: false`. It can then check progress with `codex_status` and steer or answer while the turn runs. Return a short progress summary from `codex_status`, such as the current item and elapsed time.

## 5. The response is noisy and duplicated

**Observed.**

- `response` joins every `item/agentMessage/delta` from the turn (`src/bridge.mjs:181`). That includes Codex's commentary, such as "I'm applying the Ponytail and unslop skills…", and messages run together with no separator: "…model-call retries?Waiting for your choice."
- `turn.items` repeats the final message, so the payload carries the answer twice.

**Fix.**

- Return the `final_answer` agent message as `response` by default.
- Put commentary behind an option, separated by newlines.
- Drop `turn.items` from the default result, or reduce it to IDs and timings.

## 6. `codex_models` returns the full catalog

**Observed.** One call returned about 300 lines of JSON for 8 models, including promotional copy, upgrade migration text, and service tiers.

**Fix.** Return `id`, `displayName`, `isDefault`, `defaultReasoningEffort`, and the supported effort names. Put the raw catalog behind a `verbose` flag.

## 7. Each session leaks a process

**Observed.** Every session starts its own `codex app-server` process (`src/app-server-client.mjs:17`), and sessions are closed only on SIGINT or SIGTERM (`src/mcp-server.mjs:150`). Finding 1 turns every call into a new process.

**Fix.** After fixing finding 1, close idle sessions after a timeout or offer a `codex_close` tool. Also consider sharing one app-server process across sessions, because the protocol already keys turns by `threadId`.

## 8. Smaller items

- Codex loading the user's personal skills, such as ponytail and unslop, is intentional. It should match a normal terminal `codex` session.
- Results include `durationMs` but no token usage. This is acceptable for now; do not add a token-usage layer unless the app-server exposes a stable value that the agent experience needs.
- The `model` and `effort` schema fields have no descriptions. Agents only find the valid values if they already know about `codex_models`.

## 9. Claude steers blind: no live view of Codex's work

**Observed.** With `wait: false`, `codex_status` reports only `active`, `turn_id`, `elapsed_ms`, `pending_question`, and the final `result`. While a turn runs, Claude cannot see which commands Codex ran, their exit codes, which files it read or changed, or any partial message. In the finding 4 retest, Claude's steer worked only because Claude had written the scope correction beforehand. Claude had not seen anything go wrong. An agent that cannot observe the work can only interrupt on a schedule or on a hunch. That makes `codex_steer` close to useless, and a `codex_task` that edits files is effectively unsupervised until it finishes.

**Cause.** The app-server streams every step of the turn as notifications, but `handleNotification` (`src/bridge.mjs:236`) keeps only `item/agentMessage/delta` text and `turn/completed`. It drops everything else, including `item/started` and `item/completed` for command executions, file changes, and tool calls. The messages it does keep are not exposed through `codex_status` until the turn completes.

MCP adds a second limit. A tool call is one request and one response, so any progress notification the bridge sends never reaches Claude while Claude waits on the call. The only way for the caller to see progress is to poll.

**Fix.**

- Record a bounded activity log per turn from `item/started` and `item/completed`, for example the last 200 events. Keep each event short: commands with their working directory and exit code, changed file paths with a diff summary, tool or MCP calls, and agent message snippets. Leave out full output.
- Give each event a sequence number. Add `since` to `codex_status` so a poll returns only the events after that number, along with the latest number. Polling then costs only what is new, and Claude never has to re-read the log.
- Include the current in-progress item in `codex_status`, such as `running: "bun test apps/runner/src/foo.test.ts" (12s)`, so Claude can tell a slow step from a stuck one.
- Document the supervision loop in the tool descriptions and in `agents/codex-consult.md`: start with `wait: false`, poll `codex_status` with `since`, and call `codex_steer` when the activity goes off track. Then wait for completion.

This matches how Codex's own TUI and IDE clients show live progress: they render the same `item/*` notifications.

**Workaround until then.** Codex writes every step to its rollout log, `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl`. Claude can follow that file for function calls and their outputs. The log is an internal Codex format and not a supported interface, so do not build on it.

**Status.** The bridge now keeps the last 200 bounded activity events per turn. `codex_status` accepts `since` and returns only newer events, the current running item, its elapsed time, and the latest sequence number. Start background work with `wait: false`, poll with `since`, and steer from observed activity.

## Retest after fixes (2026-10-02, 17:10)

| Finding | Result |
| --- | --- |
| 1. Session continuation | Fixed. The `session_id` stayed the same across turns, and Codex quoted its earlier question without being given it. |
| 2. Model locked per session | Fixed. Passing `model: "gpt-6-astra"` on a `gpt-6.1-sol` session was rejected with "Start a new session to change model." Results report `model` and `effort`. |
| 3. Structured clarification | Fixed. Blocking requests and async questions from completed agent-message items now reach `codex_answer` on the active turn. |
| 4. Steer an active turn | Works, but blind. `wait: false` returned `status: "started"`. `codex_steer` then changed the scope of the same turn ID, and Codex followed the correction. Claude could not see the turn's progress before steering; see finding 9. |
| 5. Clean response | Fixed. `response` contains only the final answer, and `turn.item_ids` replaces the duplicated items. |
| 6. Trimmed model list | Fixed. |
| 7. Process cleanup | Fixed. `codex_close` returned `closed: true`, and no `codex app-server --listen stdio://` processes remained. |

`codex_models` without a `session_id` now closes its temporary session before returning.

## Retest at 17:26: async questions deadlock the turn

Setup: Codex 0.160.0, `gpt-6.1-sol`/`medium`, and a bridge server restarted after `857ac5a`. The prompt asked Codex for one clarification before answering.

**Observed.** Session `b28407ab…`, thread `01a0ff27-642f-…`.

1. At 00:26:13 Codex called `request_user_input_async` with a well-formed question, and it was accepted. The question appeared in the activity log as `agentMessage` item `call_Y8b6…` (seq 6–7).
2. Codex then called `sleep(60000)` twice to wait for the answer.
3. After 138 s it gave up and ended the turn with "I'll wait for your choice before reviewing the code."
4. The call returned `status: "completed"` with `pending_question: null`. Claude never received the question and could not answer it.

The `wait: true` call also ran past Claude Code's 120 s MCP limit and was moved to the background. That hid the `session_id` until the turn ended. During that time Claude could not call `codex_status`, `codex_answer`, or `codex_close` on the session.

**Cause.** The bridge looks for async `questions` only on `turn/completed` (`handleNotification`, `src/bridge.mjs`). Codex does not end the turn after an async question. It keeps the turn open and sleeps until the answer arrives, so the bridge and Codex each wait for the other. When the turn does end, the final `agentMessage` has no `questions`; the question was on the earlier `call_…` item.

**Implemented.**

- The bridge checks for questions when an `agentMessage` item with non-empty `questions` completes and resolves the waiter with `status: "question"` while the turn remains active.
- `codex_answer` sends all collected answers with `turn/steer` and the existing `expectedTurnId`, then waits for that same turn to complete.
- `wait: true` is capped at 100 seconds. If the turn is still running, the call returns `status: "running"` with the session and turn IDs so Claude can poll, steer, answer, or close it.
- A fake app-server test emits an async question item while leaving the turn open, then verifies that `codex_answer` resumes the same turn.

**Activity log cleanup.** The new `activity` field in `codex_status` made this diagnosis possible without reading Codex's rollout file. The bridge now:

- folds streamed message deltas into the completed agent-message entry;
- skips `userMessage` start and completion entries.

## Not yet exercised

`codex_task`, `codex_review`, and the `MAX_CLARIFICATIONS` fallback.
