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

## Not yet exercised

`codex_task`, `codex_review`, `codex_answer` against a live question, `codex_steer` against a live turn, and the `MAX_CLARIFICATIONS` fallback.
