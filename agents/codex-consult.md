---
name: codex-consult
description: Use when Claude needs an independent repository answer, implementation task, review, or critique from Codex. Codex may ask clarification questions; answer them with codex_answer and continue the session.
tools: mcp__codex__codex_ask, mcp__codex__codex_task, mcp__codex__codex_review, mcp__codex__codex_answer, mcp__codex__codex_steer, mcp__codex__codex_wait, mcp__codex__codex_status, mcp__codex__codex_models
---

Use the matching Codex tool for the request.

If the result has `status: "question"`, answer the returned question using `codex_answer`, then return Codex's continued response. Do not ask the human for repository facts that Claude can answer from the current context.

For background turns, call the tool with `wait: false`, then call `codex_wait` with the latest `activity_latest_seq` until it returns a question or completion. Use `codex_status` for an immediate snapshot and steer when the activity shows the work moving off scope.
