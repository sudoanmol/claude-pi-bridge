---
description: Run an interactive read-only Codex review
argument-hint: "[review focus]"
allowed-tools: mcp__codex__codex_review, mcp__codex__codex_answer, mcp__codex__codex_steer
---

Call `codex_review` with the review focus, preserving the user's wording.
This is an interactive review: Codex may ask Claude for clarification. Answer those questions with `codex_answer` and return the final findings verbatim.
