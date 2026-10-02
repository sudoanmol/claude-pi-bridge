# Claude ↔ Codex Bridge

This Claude Code plugin gives Claude a local MCP channel to Codex CLI. It uses the Codex app-server, so each bridge session keeps a real Codex thread and supports feedback in both directions.

## Install the plugin

From Claude Code, load this directory as a local plugin:

```text
/Users/anmolhurkat/Developer/claude-codex-bridge
```

The plugin starts `src/mcp-server.mjs` over stdio. The bridge uses the `codex` executable on `PATH`. Set `CODEX_BIN` when Codex lives elsewhere.

Codex must be installed and authenticated before you use the tools:

```sh
codex --version
```

## Claude-facing tools

- `codex_ask` starts a read-only Codex conversation for repository questions.
- `codex_task` starts a workspace-write Codex conversation for an implementation task.
- `codex_review` starts a read-only review of uncommitted changes or a base revision.
- `codex_models` lists available models and each model's supported reasoning efforts.
- `codex_steer` sends feedback while a Codex turn is active.
- `codex_answer` answers a question that Codex sends back.
- `codex_status` shows the thread and any pending question.

Pass `model` and `effort` on `codex_ask`, `codex_task`, or `codex_review`. The bridge validates them against `model/list`; for example, use `model: "gpt-6-astra"` and an effort returned by `codex_models`.

## The conversation loop

1. Claude calls `codex_ask`, `codex_task`, or `codex_review` and keeps the returned `session_id`.
2. Codex can return `status: "question"` when it needs repository context.
3. Claude answers with `codex_answer` and the same `session_id` and `question_id`.
4. Claude can send corrections or review feedback with `codex_steer` while Codex is working.
5. Codex returns `status: "completed"` with its response and turn metadata.

The same loop applies to reviews. Review prompts run as normal persistent turns so they can be clarified and steered; the native one-shot review endpoint is not used.

## Claude Code shortcuts

- `/codex-ask <question>` delegates a repository question.
- `/codex-task <task>` delegates a workspace-write implementation task.
- `/codex-review [focus]` starts an interactive review.

## Development

```sh
npm test
```

The tests include a fake app-server round trip for a Codex clarification. A live smoke test requires an authenticated Codex CLI.

## Deliberate limits

The bridge keeps one active turn per session. It forwards Codex clarification requests and uses `approvalPolicy: "never"` for workspace-write tasks inside the selected working directory. Use a separate Codex session when a task needs a different sandbox or model configuration.
