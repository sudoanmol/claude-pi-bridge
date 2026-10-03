---
description: Ask Codex to make repository changes
argument-hint: "<task>"
allowed-tools: mcp__codex__codex_task, mcp__codex__codex_answer, mcp__codex__codex_steer, mcp__codex__codex_status
---

Call `codex_task` with the user's task and return the result.
If Codex returns a clarification question, answer it from the current Claude context with `codex_answer`, then continue the same session.
For a long task, pass `wait: false`, poll `codex_status` with `since`, and use `codex_steer` when the activity shows the work moving off scope.
