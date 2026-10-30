---
description: Get a second opinion from pi, or ask it a repository question
argument-hint: "<question>"
allowed-tools: mcp__plugin_pi-bridge_pi__pi_ask, mcp__plugin_pi-bridge_pi__pi_answer, mcp__plugin_pi-bridge_pi__pi_wait, mcp__plugin_pi-bridge_pi__pi_status, mcp__plugin_pi-bridge_pi__pi_kill
---

Call `pi_ask` with the user's question and return pi's response.
If pi asks a clarification question, answer it from the current context with `pi_answer`, then return the continued response.
If the result is `failed`, report pi's error as given. Kill the session with `pi_kill` when no follow-up is expected.
