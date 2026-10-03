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

## Retest at 17:41: async questions answered inside the active turn

Setup: Codex 0.160.0, `gpt-6.1-sol`/`medium`, and a bridge server restarted after `ceac0ee`. The prompt was the same as in the 17:26 retest, started with `wait: false`.

**Observed.** Session `29a9c390…`, turn `01a0ff34-ead2-…`.

1. `codex_ask` returned `status: "started"` with the `session_id` right away.
2. Ten seconds later, `codex_status` showed `active: true`. `pending_question` held the async question with its four options, about 2 s after Codex asked it.
3. `codex_answer` with "Command reconciliation" went into the same turn ID. Codex answered with file:line citations, and the turn completed in 64 s total.
4. `codex_close` returned `closed: true`.

The activity log no longer has single-character delta entries or user-message echoes.

**Resolved.** When Codex omits a question ID, the bridge assigns a short stable ID such as `q1` (and exposes it in `codex_ask` and `codex_status`). Claude can pass that ID directly to `codex_answer` without copying the question title.

## Retest at 17:45: `codex_task` and `codex_review` on a scratch repository

Setup: a throwaway git repository holding `slug.py` with a broken `slugify` and assert-based checks, `gpt-6.1-sol`/`low`, and `wait: false` for both tools.

**`codex_task` works.** Session `90c06389…`.

1. Ten seconds in, `codex_status` showed Codex's plan, its first command with exit code 0, and its next step.
2. Claude steered with an extra requirement: `slugify("!!!") == ""` and no edge hyphens. The steer went into the same turn ID.
3. The final diff applied both the original fix and the steer. Claude ran `python3 slug.py` independently, and it printed `ok`. The turn took 98 s.

**`codex_review` works.** Session `2b253092…`.

1. Codex asked a blocking `request_user_input` question with a proper ID, `slug_contract`, a header, and labeled options.
2. Claude answered it with `codex_answer`.
3. Codex returned one finding with a reproducing input: `slugify("hello_world")` keeps the underscore. Claude confirmed it independently.

Both sessions closed cleanly.

## 10. No way to wait on a running turn

**Observed.** After `wait: false`, Claude has only two ways to learn that something changed:

- Poll `codex_status` repeatedly. Claude Code blocks standalone `sleep` between polls, so Claude polls back to back. During the review, four polls in about 20 s each returned almost the same payload.
- Call `codex_steer`, which waits for the next question or for completion. During the review, Claude sent a reminder through `codex_steer` partly so it could wait on the turn. That works, but it is a side effect, and a caller should not have to change Codex's instructions just to wait.

**Fix.** Add `codex_wait({ session_id, since, timeout_ms })`, or a `wait_ms` option on `codex_status`. It returns as soon as there is new activity after `since`, a pending question, or a completed turn. Otherwise it returns `status: "running"` at the timeout. Cap the timeout below the client's MCP tool limit, for example at 90 s, so the caller keeps control. The supervision loop then becomes: start with `wait: false`, call `codex_wait` repeatedly, and steer or answer when needed. The loop never busy-polls and never blocks past the client limit.

**Implemented.** `codex_wait` waits for new or updated activity, a pending question, or a completed turn. It returns `status: "running"` at timeout and caps `timeout_ms` at 90 seconds. The existing `since` cursor remains available on `codex_status`. Restart Claude Code after installing a new plugin version so it reloads the MCP tool list.

## 11. `codex_status` resends the whole activity log every time

**Observed.** Every poll returned the full log, about 5k tokens by seq 18. The cost grows with each event, multiplied by the number of polls.

The bridge source supports `since` (`src/mcp-server.mjs:103`, `src/bridge.mjs:416`). The bridge server started at 17:40, after `mcp-server.mjs` last changed at 17:35. Even so, Claude Code still offered the earlier `codex_status` definition, with only a `session_id` property, so Claude could not pass `since`. Claude Code appears to keep tool definitions from an earlier connection. Check whether `/mcp` reconnect refreshes `tools/list`. If it does not, document that a full Claude Code restart is required after changing a tool definition.

The log is also larger than it needs to be:

- Every item appears twice, once when it starts and once when it completes. Both entries repeat the full `command` and `cwd`.
- Each `command_output` entry is a separate line.

**Fix.**

- Make `since` the documented default way to poll.
- Keep one entry per item and update it in place when the item completes.
- Already-reported in-progress items can rely on `running`.
- Leave out `cwd` when it equals the session's `cwd`.
- Fold command output into its command entry as a short tail.

**Implemented.** Activity keeps one entry per item. A completion updates the item and receives a new sequence number, so a caller that already saw the start receives the completion on its next `since` poll. Command output is kept as a bounded tail, and the session working directory is omitted from command entries.

## 12. Smaller items from this retest

- Read-only sessions on macOS show `git: error: couldn't create cache file '/tmp/xcrun_db-…' (errno=Operation not permitted)`. One `git status` returned exit 1 even though it printed output. The read-only sandbox blocks `xcrun`'s cache write to `/tmp`, so Codex may misread git failures during reviews. Setting `TMPDIR` to a writable sandbox path might help; this has not been tested.
- Blocking questions carry their own ID, for example `slug_contract`. Async questions without an ID receive a generated short ID such as `q1`, so both paths give Claude a compact value for `codex_answer`.

## Retest at 18:00: `codex_wait` supervision loop

Setup: bridge at `ce3837b`, `gpt-6.1-sol`/`low`. The task was a `codex_task` in the scratch repository to turn underscores into hyphens in `slugify`, started with `wait: false`.

**Finding 10 is fixed.** Claude supervised the whole turn with `codex_wait(since=activity_latest_seq)` and never busy-polled or blocked.

- Each response held only new events, plus `running` and `status: "updated"` or `"completed"`.
- The last call returned `active: false` with the final `result`.
- Claude saw the file change on `slug.py` (seq 14), then `python3 slug.py && git diff` with exit 0 (seq 20).
- Claude checked the resulting diff independently, and `python3 slug.py` printed `ok`.

**New issue: `codex_wait` returns after every event.** The 41 s turn took 16 `codex_wait` calls. That is one round trip about every 2 s, and most carried a single reasoning start or completion that says nothing Claude can act on. Every call costs a full model turn on the Claude side. So event-driven waiting is now cheaper per call than polling `codex_status`, but it is still chatty.

**Fix.**

- Batch the response. After the first new event, keep collecting for a short window, for example 3 to 5 s, then return everything at once. Return immediately for a question or a completed turn.
- Skip reasoning start and completion events by default. `running` already shows that Codex is thinking.
- Wake the caller only for events it can act on: a completed command with its exit code, a file change, an agent message, a question, or completion.
- Optionally accept `min_interval_ms` so the caller can choose between watching closely and checking less often.

With these changes, this turn would have taken about 4 to 6 calls instead of 16.

**Finding 11 is partly open.** Claude Code picked up the new `codex_wait` tool after the reload. It still offered the old `codex_status` definition, without `since`. This supports the theory that Claude Code keeps definitions for tools it already knows and adds only new ones. `codex_wait` returns only new events, so it mostly avoids the size problem for supervision.

## Not yet exercised

The `MAX_CLARIFICATIONS` fallback, and `codex_review` with `base`.

## Fix at 18:20: batched `codex_wait` and plugin-only MCP config

**Batching.** `codex_wait` no longer returns on the first event. After the first new activity, it collects for `WAIT_BATCH_MS` (3 s) and then returns everything that arrived. A pending question, a completed turn, and an app-server failure still return immediately. When the timeout comes first, the response reports `updated` instead of `running` if activity arrived. Reasoning items and agent-message starts no longer create activity entries; they appear only in `running`. The new test in `test/wait.test.mjs` covers each of these behaviors.

**Live check.** A `gpt-6.1-sol`/`low` task in the scratch repository added a docstring and ran `python3 slug.py`. The `wait` loop driving it needed 6 calls for a 41 s turn, down from 16 for a comparable turn before batching:

```text
+10.2s call 1: updated   | message
+15.3s call 2: updated   | command(exit 0) ×3
+23.8s call 3: updated   | command(exit 0)
+31.5s call 4: updated   | command(exit 0)
+39.8s call 5: updated   | file_change[slug.py], command(exit 0)
+40.6s call 6: completed | message
```

**MCP config.** `.mcp.json` at the repository root also served as project-scope MCP config. When Claude Code opened this repository as a project, it started that server without `CLAUDE_PLUGIN_ROOT` set, and the server failed with `CONNECTION_CLOSED`. The server is now declared in `.claude-plugin/plugin.json`, and `.mcp.json` has been removed.
