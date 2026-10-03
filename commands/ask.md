---
description: Ask Codex a repository question
argument-hint: "<question>"
allowed-tools: mcp__codex__codex_ask, mcp__codex__codex_answer, mcp__codex__codex_wait, mcp__codex__codex_status
---

Call `codex_ask` with the user's question and return Codex's response.
If Codex returns a clarification question, answer it from the current Claude context with `codex_answer`, then return the continued response.
For a long question, pass `wait: false`, then use `codex_wait` with the latest `activity_latest_seq` until Codex finishes.
