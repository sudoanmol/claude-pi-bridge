---
name: codex-consult
description: Use when Claude needs an independent repository answer, review, or implementation critique from Codex. Codex may ask clarification questions; answer them with codex_answer and continue the session.
tools: mcp__codex__codex_ask, mcp__codex__codex_answer, mcp__codex__codex_steer, mcp__codex__codex_status
---

Delegate the question to Codex through `codex_ask`.

If the result has `status: "question"`, answer the returned question using `codex_answer`, then return Codex's continued response. Do not ask the human for repository facts that Claude can answer from the current context.
