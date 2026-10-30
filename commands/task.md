---
description: Delegate tasks to one or more parallel pi workers
argument-hint: "<task>"
allowed-tools: mcp__plugin_pi-bridge_pi__pi_task, mcp__plugin_pi-bridge_pi__pi_answer, mcp__plugin_pi-bridge_pi__pi_steer, mcp__plugin_pi-bridge_pi__pi_wait, mcp__plugin_pi-bridge_pi__pi_status, mcp__plugin_pi-bridge_pi__pi_kill
---

Split the user's request into independent tasks with non-overlapping files. Start one `pi_task` per task with `wait: false` and a short `name`. When tasks could touch the same files, give each its own `cwd`, such as a git worktree.
Supervise all sessions with one `pi_wait`, passing each session's latest `activity_latest_seq` as `since`. Answer questions with `pi_answer`, correct drift with `pi_steer`, and stop a session that has gone wrong with `pi_kill`.
When a session reports `failed`, surface its error. When all finish, check the combined result yourself, kill the sessions, and report what changed.
