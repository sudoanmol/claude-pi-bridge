# Claude ↔ pi Bridge

This Claude Code plugin gives Claude a local MCP channel to [pi](https://github.com/earendil-works/pi). Each bridge session runs one `pi --mode rpc` process and keeps one pi conversation, so Claude and pi can talk in both directions: pi asks Claude questions, and Claude steers pi while it works.

It is built for three jobs:

- **Second opinions.** `pi_ask` puts a question, plan, or bug to pi in a read-only session.
- **Reviews of Claude's work.** `pi_review` runs pi with the `review` and `deslop` skills on a scope Claude gives it, and returns findings for Claude to act on.
- **Parallel workers.** `pi_task` with `worktree: true` starts each worker in its own git worktree; one `pi_wait` supervises them all.

## Install

pi must be installed and signed in to at least one provider:

```sh
pi --version
pi --list-models deepseek
```

The bridge runs the `pi` executable on `PATH`. Set `PI_BIN` when pi lives elsewhere. `pi_review` also needs `~/.agents/skills/review/SKILL.md` and `~/.agents/skills/deslop/SKILL.md`; it fails with the missing path when either is absent.

Install the plugin through the local marketplace from inside Claude Code:

```text
/plugin marketplace add /Users/anmolhurkat/Developer/claude-codex-bridge
/plugin install pi-bridge@local
```

Restart Claude Code after installing or updating, and start a new conversation: a resumed conversation keeps the MCP tool definitions it already loaded.

## Tools

| Tool | Purpose |
| --- | --- |
| `pi_ask` | Second opinion or repository question. Read-only. |
| `pi_review` | Review Claude's work with the `review` and `deslop` skills. Read-only. Takes a `scope`. |
| `pi_task` | Workspace-write task. Add `worktree: true` and `wait: false` for parallel workers. |
| `pi_answer` | Answer a question pi asked (`question_id` such as `q1`). |
| `pi_steer` | Send a correction to a working session. pi reads it after its current tool calls. |
| `pi_wait` | Wait on one or more sessions; returns when any has a question, a result, a failure, or new activity. |
| `pi_status` | Snapshot of one session, or of all sessions when `session_id` is omitted. |
| `pi_kill` | Abort the running turn, stop the pi process so it spends no more tokens, and remove a clean worktree. |
| `pi_limits` | ChatGPT plan, 5-hour and weekly Codex usage with reset times, unavailable models, and what the plan allows. |
| `pi_models` | Search model names; returns pi's default model and the thinking levels. |

`model` (`provider/id`, for example `deepseek/deepseek-flash`), `thinking`, `cwd`, and `name` apply when a session starts and stay fixed for it. pi maps a thinking level the model does not support to a nearby one, so every result reports the level in use. Results also report the session's cumulative `cost_usd` and pi's `session_file`, which `pi --session <path>` reopens.

## Choosing a model

The MCP server's `instructions`, which Claude Code loads with the tools, tell Claude which model to pick:

| Model | Use | Thinking |
| --- | --- | --- |
| `deepseek/deepseek-flash` | Fastest and cheapest; default for parallel workers and routine work | low, high, max |
| `openai-codex/gpt-6.1-terra` | Most cost-efficient Codex model | low through max |
| `openai-codex/gpt-6.1-sol` | Cost-efficient and highly capable; pi's default | Plus: low, medium, high |
| `openai-codex/gpt-6-astra` | Most capable, very costly; hardest problems only | Never on Plus |

The bridge enforces the Plus rules. After pi starts a Codex session, the bridge reads the plan from pi's Codex sign-in (`pi auth print-bearer-token`) and kills the session if the model or the thinking level pi settled on is not allowed. Other plans have no restrictions. `pi_limits` reads the same sign-in and calls ChatGPT's usage endpoint, so Claude can switch to DeepSeek before a Codex limit fails a turn. The token never leaves the bridge process except to `chatgpt.com`. The plan is read once per bridge process, so restart Claude Code after changing plans.

## The conversation loop

1. Claude calls `pi_ask`, `pi_review`, or `pi_task` and keeps the returned `session_id` (`p1`, `p2`, …).
2. pi can call its `ask_claude` tool. The result then has `status: "question"` and `pending_questions`; Claude answers with `pi_answer`.
3. With `wait: true` (the default) a call returns at a question or the result, or with `status: "running"` after 100 seconds.
4. With `wait: false` the call returns once pi accepts the prompt. Claude then calls `pi_wait`, passing each session's last `activity_latest_seq` as `since`, and steers, answers, or kills from what the activity shows.
5. Passing `session_id` to `pi_ask`, `pi_review`, or `pi_task` sends a follow-up into the same conversation. A read-only session cannot take a `pi_task`.

`pi_wait` batches activity for 3 seconds after the first new event, so one call returns several steps. Questions, results, and failures return immediately. A session whose result Claude has already seen does not wake the wait again; when every listed session has finished, the wait returns at once. The wait is capped at 90 seconds.

Errors reach Claude as data. A model or provider error ends the turn with `status: "failed"` and `result.error`. A pi process that exits reports `status: "failed"` with pi's stderr. Retries, failed compaction, and extension errors appear in the activity log.

## Parallel workers

Start each worker with `pi_task`, `worktree: true`, `wait: false`, and a `name`, then pass all of them to one `pi_wait`. For each worker the bridge:

1. Creates `<repo>/.pi-bridge/worktrees/<name>-<random>` on a new branch `pi-bridge/<name>-<random>` from `HEAD`. Uncommitted changes in the main tree are not included, so commit first if the workers need them.
2. Adds `.pi-bridge/` to `.git/info/exclude`, so the main tree never shows the worktrees and `.gitignore` stays untouched.
3. Copies the root `.env*` files that the worktree lacks.
4. Installs dependencies from the root lockfile before sending the first prompt: `pnpm install --frozen-lockfile`, `bun install --frozen-lockfile`, `yarn install --frozen-lockfile`, or `npm ci` for JavaScript, and `uv sync --frozen` for Python. The install shows in the activity log as `setup` steps; a failed install fails the turn with the installer's output.

pi is told to commit its work to its branch. Merge the branches you want, then `pi_kill` each session: it removes a worktree that has no uncommitted or untracked changes and always keeps the branch. A worktree with leftover changes stays, and the result says so.

Without `worktree`, workers share `cwd`.

## How sessions are configured

- Every session loads `extensions/ask-claude.ts`, which adds the `ask_claude` tool, and appends instructions telling pi it works for Claude.
- pi has no sandbox. Read-only sessions run without the `edit` and `write` tools and are told not to change state, but `bash` remains available.
- The `ask_user_question` tool from a pi package cannot reach anyone over RPC, so the bridge removes it in favor of `ask_claude`.
- Other extensions, skills, and settings load as they would in a terminal `pi` session. Their dialogs (`select`, `confirm`, `input`, `editor`) also reach Claude as questions.
- Sessions are saved like normal pi sessions.

## Claude Code shortcuts

- `/pi-bridge:ask <question>` asks for a second opinion.
- `/pi-bridge:review [scope]` reviews Claude's recent work.
- `/pi-bridge:task <task>` splits work across parallel pi workers.

## Development

```sh
pnpm test
```

The tests drive the bridge against `test/fake-pi.mjs`, a stand-in that speaks pi's RPC protocol. A live check needs an authenticated pi.
