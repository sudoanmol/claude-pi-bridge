---
description: Delegate tasks to one or more parallel pi workers
argument-hint: "<task>"
allowed-tools: mcp__plugin_pi-bridge_pi__pi_task, mcp__plugin_pi-bridge_pi__pi_answer, mcp__plugin_pi-bridge_pi__pi_steer, mcp__plugin_pi-bridge_pi__pi_wait, mcp__plugin_pi-bridge_pi__pi_status, mcp__plugin_pi-bridge_pi__pi_kill
---

For a single task, call `pi_task` in the current tree. For several, split the request into independent tasks and start one `pi_task` per task with `worktree: true`, `wait: false`, and a short `name`. Worktrees branch from `HEAD`, so commit work the tasks depend on first.
Supervise all sessions with one `pi_wait`, passing each session's latest `activity_latest_seq` as `since`. Answer questions with `pi_answer`, correct drift with `pi_steer`, and stop a session that has gone wrong with `pi_kill`.
When a session reports `failed`, surface its error. When all finish, review each worker's branch, merge the ones that hold up, kill the sessions, and report what changed and which branches remain.
