---
description: Have pi review Claude's work with the review and deslop skills
argument-hint: "[scope]"
allowed-tools: mcp__plugin_pi-bridge_pi__pi_review, mcp__plugin_pi-bridge_pi__pi_answer, mcp__plugin_pi-bridge_pi__pi_steer, mcp__plugin_pi-bridge_pi__pi_wait, mcp__plugin_pi-bridge_pi__pi_status, mcp__plugin_pi-bridge_pi__pi_kill
---

Call `pi_review` with a concrete scope: the files, diff range, or change Claude just made. Use the user's wording when given; otherwise describe the work from the current context.
pi may ask about intent or scope. Answer with `pi_answer` from the current context.
Return pi's findings verbatim, then say which ones you agree with. Do not apply fixes unless the user asks. Kill the session with `pi_kill` when done.
