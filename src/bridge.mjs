import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PiClient } from "./pi-client.mjs";
import { createWorktree, install, installCommands, removeWorktree } from "./worktree.mjs";

const MAX_ACTIVITY = 200;
const RUN_WAIT_MS = 100_000;
const WAIT_TOOL_TIMEOUT_MS = 90_000;
// After the first new event, keep collecting so one wait returns a batch instead of a single event.
const WAIT_BATCH_MS = 3_000;
const KILL_ABORT_MS = 2_000;
const ASK_CLAUDE = fileURLToPath(new URL("../extensions/ask-claude.ts", import.meta.url));
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
// Activity kinds that end a wait at once; anything else is batched.
const URGENT = new Set(["question", "result", "failed"]);
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const BASE_INSTRUCTIONS = "You are pi, working for Claude Code, which assigned this work and supervises it. Follow the repository's AGENTS.md. When a material requirement or repository fact is missing, call ask_claude instead of guessing; never ask the human directly. Your final message is all Claude sees, so make it self-contained.";
const INSTRUCTIONS = {
  ask: `${BASE_INSTRUCTIONS} This session is read-only: do not modify files, commit, or run commands that change state.`,
  review: `${BASE_INSTRUCTIONS} This session is read-only: do not modify files, commit, or run commands that change state.`,
  task: `${BASE_INSTRUCTIONS} Make the requested changes, run the relevant checks, and end with what changed and which checks ran.`
};
// pi has no sandbox; read-only sessions only lose the file-writing tools. The user's own
// ask_user_question tool cannot reach anyone over RPC, so every session uses ask_claude instead.
const EXCLUDED_TOOLS = { ask: "edit,write,ask_user_question", review: "edit,write,ask_user_question", task: "ask_user_question" };

export class Bridge {
  constructor({ command, skillsDir = path.join(os.homedir(), ".agents", "skills") } = {}) {
    this.sessions = new Map();
    this.command = command;
    this.skillsDir = skillsDir;
    this.nextId = 1;
  }

  async open({ session_id, cwd = process.cwd(), model, thinking, name, worktree = false } = {}, mode) {
    if (session_id) {
      const session = this.get(session_id);
      if (mode === "task" && session.mode !== "task") throw new Error(`Session ${session_id} is read-only; start a new pi_task session.`);
      session.assertConfig(model, thinking);
      return session;
    }
    if (mode === "review") await this.assertReviewSkills();
    const tree = worktree ? await createWorktree(path.resolve(cwd), name) : null;
    const session = new PiSession({ id: `p${this.nextId++}`, mode, cwd: tree?.path ?? path.resolve(cwd), name, worktree: tree, command: this.command });
    try {
      await session.start({ model, thinking });
    } catch (error) {
      await session.kill();
      throw error;
    }
    this.sessions.set(session.id, session);
    return session;
  }

  async assertReviewSkills() {
    for (const skill of ["review", "deslop"]) {
      const file = path.join(this.skillsDir, skill, "SKILL.md");
      try { await access(file); } catch { throw new Error(`pi_review needs the "${skill}" skill at ${file}`); }
    }
  }

  reviewPrompt(scope) {
    return [
      `/skill:review Review Claude's work. Scope: ${scope}`,
      "",
      "This is a read-only review: report findings; do not edit files or remove tests.",
      `Also apply the deslop skill (${path.join(this.skillsDir, "deslop", "SKILL.md")}) to the same scope and report the slop it finds as findings instead of removing it.`,
      "Order findings by severity. Give each one file:line, the problem, and a concrete fix."
    ].join("\n");
  }

  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown pi session: ${sessionId}`);
    return session;
  }

  status(sessionId, since) {
    if (sessionId) return this.get(sessionId).status(since);
    return { sessions: [...this.sessions.values()].map((session) => session.summary()) };
  }

  // Returns when any listed session needs attention, with every listed session's state.
  async wait(entries, timeoutMs) {
    if (!entries?.length) throw new Error("sessions must list at least one session");
    const targets = entries.map(({ session_id, since }) => [this.get(session_id), since]);
    // A finished session only ends the wait through new events, unless nothing is left running.
    const wakeWhenIdle = targets.every(([session]) => !session.active);
    const controller = new AbortController();
    const waits = targets.map(([session, since]) => session.wait({ since, timeoutMs, wakeWhenIdle, signal: controller.signal }));
    await Promise.race(waits);
    controller.abort();
    return { sessions: await Promise.all(waits) };
  }

  async kill(sessionId) {
    const session = this.get(sessionId);
    await session.kill();
    this.sessions.delete(sessionId);
    const result = { session_id: sessionId, killed: true, cost_usd: session.cost };
    if (session.worktree) {
      const removed = await removeWorktree(session.worktree);
      result.worktree = { ...session.worktree, removed };
      if (!removed) result.worktree.note = "Kept: the worktree has uncommitted or untracked changes.";
    }
    return result;
  }

  async models(search = "") {
    const client = new PiClient({ cwd: process.cwd(), args: ["--no-session"], command: this.command });
    client.start();
    try {
      const [{ models = [] }, state] = await Promise.all([client.request("get_available_models"), client.request("get_state")]);
      const needle = search.toLowerCase();
      return {
        default: modelName(state.model),
        models: models.map(modelName).filter((name) => name.toLowerCase().includes(needle)),
        thinking_levels: THINKING_LEVELS,
        note: "pi maps a thinking level the model does not support to a nearby one; each result reports the level in use."
      };
    } finally {
      await client.close();
    }
  }

  async close() {
    await Promise.all([...this.sessions.values()].map((session) => session.kill()));
    this.sessions.clear();
  }
}

class PiSession {
  constructor({ id, mode, cwd, name, worktree, command }) {
    this.id = id;
    this.worktree = worktree;
    this.mode = mode;
    this.cwd = cwd;
    this.name = name ?? null;
    this.command = command;
    this.activity = [];
    this.activitySeq = 0;
    this.activityEvictedThrough = 0;
    this.questions = new Map();
    this.nextQuestion = 1;
    this.waiters = new Set();
    this.active = false;
    this.running = null;
    this.result = null;
    this.failure = null;
    this.cost = 0;
  }

  async start({ model, thinking }) {
    const instructions = this.worktree
      ? `${INSTRUCTIONS[this.mode]} You work alone in a git worktree on branch ${this.worktree.branch}, created from ${this.worktree.base}; other workers have their own. Commit your changes to this branch when done. Do not push, rebase, or switch branches.`
      : INSTRUCTIONS[this.mode];
    const args = ["--append-system-prompt", instructions, "-e", ASK_CLAUDE, "--exclude-tools", EXCLUDED_TOOLS[this.mode]];
    if (model) args.push("--model", model);
    if (thinking) args.push("--thinking", thinking);
    if (this.name) args.push("--name", this.name);
    this.client = new PiClient({
      cwd: this.cwd,
      args,
      command: this.command,
      onEvent: (event) => this.handleEvent(event),
      onFailure: (error) => this.handleFailure(error)
    });
    this.client.start();
    const state = await this.client.request("get_state");
    this.model = modelName(state.model);
    this.thinking = state.thinkingLevel ?? null;
    this.sessionFile = state.sessionFile ?? null;
    this.requested = { model, thinking };
  }

  assertConfig(model, thinking) {
    if (model !== undefined && model !== this.requested.model && model !== this.model) throw new Error(`Session ${this.id} uses model "${this.model}". Start a new session to change model.`);
    if (thinking !== undefined && thinking !== this.requested.thinking && thinking !== this.thinking) throw new Error(`Session ${this.id} uses thinking "${this.thinking}". Start a new session to change it.`);
  }

  // Runs in the background so pi_task with wait:false returns at once; the first prompt waits for it.
  async installDependencies() {
    for (const command of await installCommands(this.cwd)) {
      const started = Date.now();
      this.recordActivity({ kind: "setup", phase: "started", command: command.flat().join(" ") });
      await install(this.cwd, command);
      this.recordActivity({ kind: "setup", phase: "completed", command: command.flat().join(" "), duration_ms: Date.now() - started });
    }
  }

  async run(prompt, { wait = true } = {}) {
    if (this.failure) throw this.failure;
    if (this.active) throw new Error(`Session ${this.id} is still working; use pi_steer, pi_wait, or pi_kill.`);
    this.activity = [];
    this.activityEvictedThrough = this.activitySeq;
    this.result = null;
    this.running = null;
    this.lastAssistant = null;
    this.startedAt = Date.now();
    this.active = true;
    // Started here, after the activity reset, so the install steps show in this turn's activity.
    if (this.worktree) this.setup ??= this.installDependencies();
    const sent = (async () => {
      await this.setup;
      const { disposition } = await this.client.request("prompt", { message: prompt });
      if (disposition === "handled") this.finish({ aborted: false });
    })();
    if (!this.setup) {
      try { await sent; } catch (error) { this.active = false; throw error; }
    } else sent.catch((error) => this.failTurn(error));
    return wait ? this.wait({ terminalOnly: true, timeoutMs: RUN_WAIT_MS }) : this.summary("started");
  }

  async answer(questionId, answer, { wait = true } = {}) {
    const pending = this.questions.get(questionId);
    if (!pending) throw new Error(`Unknown question ${questionId} in session ${this.id}`);
    const { method, options } = pending.question;
    if (method === "select" && !options.includes(answer)) throw new Error(`Answer must be one of: ${options.join(", ")}`);
    this.questions.delete(questionId);
    const reply = method === "confirm" ? { confirmed: /^(y|yes|true|ok|confirm)/i.test(answer.trim()) } : { value: answer };
    this.client.send({ type: "extension_ui_response", id: pending.rpcId, ...reply });
    return wait ? this.wait({ terminalOnly: true, timeoutMs: RUN_WAIT_MS }) : this.summary();
  }

  async steer(message, { wait = true } = {}) {
    if (!this.active) throw new Error(`Session ${this.id} is not working; send a new prompt instead.`);
    await this.client.request("steer", { message });
    return wait ? this.wait({ terminalOnly: true, timeoutMs: RUN_WAIT_MS }) : this.summary();
  }

  handleEvent(event) {
    switch (event.type) {
      case "extension_ui_request":
        if (DIALOGS.has(event.method)) this.ask(event);
        return;
      case "message_start":
        if (event.message?.role === "assistant") this.running = { kind: "model", started_at: Date.now() };
        return;
      case "message_end":
        return this.handleAssistant(event.message);
      case "tool_execution_start": {
        const item = describeTool(event);
        this.running = { ...item, started_at: Date.now() };
        return this.recordActivity({ phase: "started", ...item }, event.toolCallId);
      }
      case "tool_execution_update":
        if (event.toolName === "bash") this.recordActivity({ output_tail: shortTail(textOf(event.partialResult)) }, event.toolCallId);
        return;
      case "tool_execution_end":
        if (this.running?.item_id === event.toolCallId) this.running = null;
        return this.recordActivity({ phase: "completed", is_error: Boolean(event.isError), duration_ms: event.durationMs ?? null }, event.toolCallId);
      case "auto_retry_start":
        return this.recordActivity({ kind: "retry", attempt: event.attempt, text: shortText(event.errorMessage) });
      case "auto_retry_end":
        if (!event.success) this.recordActivity({ kind: "error", text: shortText(event.finalError) });
        return;
      case "compaction_end":
        if (event.errorMessage) this.recordActivity({ kind: "error", text: shortText(`Compaction failed: ${event.errorMessage}`) });
        return;
      case "extension_error":
        return this.recordActivity({ kind: "error", text: shortText(`Extension ${path.basename(event.extensionPath ?? "")} failed in ${event.event}: ${event.error}`) });
      case "agent_settled":
        return this.finish(event);
    }
  }

  handleAssistant(message) {
    if (message?.role !== "assistant") return;
    this.running = null;
    this.lastAssistant = message;
    this.cost += message.usage?.cost?.total ?? 0;
    const text = textOf(message);
    if (text) this.recordActivity({ kind: "message", text: shortText(text) });
  }

  ask(request) {
    const id = `q${this.nextQuestion++}`;
    const question = { id, method: request.method, title: request.title };
    if (request.message) question.message = request.message;
    if (request.options) question.options = request.options;
    if (request.placeholder) question.hint = request.placeholder;
    this.questions.set(id, { rpcId: request.id, question });
    this.recordActivity({ kind: "question", question_id: id, text: shortText(request.title) });
    // pi resolves a timed dialog on its own; drop the question so Claude does not answer a stale one.
    if (request.timeout) setTimeout(() => { this.questions.delete(id); this.notifyWaiters(); }, request.timeout).unref();
  }

  finish({ aborted }) {
    const message = this.lastAssistant;
    const status = aborted ? "aborted" : message?.stopReason === "error" ? "failed" : "completed";
    this.result = { status, response: (message && textOf(message)) || null, duration_ms: Date.now() - this.startedAt };
    if (status === "failed") this.result.error = message.errorMessage ?? "pi reported an error";
    this.active = false;
    this.running = null;
    this.questions.clear();
    this.recordActivity({ kind: "result", status });
  }

  failTurn(error) {
    if (!this.active) return;
    this.result = { status: "failed", response: null, error: error.message, duration_ms: Date.now() - this.startedAt };
    this.active = false;
    this.running = null;
    this.recordActivity({ kind: "result", status: "failed" });
  }

  recordActivity(event, itemId = null) {
    const index = itemId ? this.activity.findIndex((entry) => entry.item_id === itemId) : -1;
    const previous = index >= 0 ? this.activity.splice(index, 1)[0] : {};
    this.activity.push({ ...previous, ...event, seq: ++this.activitySeq, at: Date.now() });
    if (this.activity.length > MAX_ACTIVITY) this.activityEvictedThrough = this.activity.shift().seq;
    this.notifyWaiters();
  }

  wait({ since = this.activitySeq, timeoutMs = WAIT_TOOL_TIMEOUT_MS, terminalOnly = false, wakeWhenIdle = true, signal } = {}) {
    if (!Number.isSafeInteger(since) || since < 0) throw new Error("since must be a non-negative integer");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("timeout_ms must be a non-negative integer");
    return new Promise((resolve) => {
      const waiter = { since, terminalOnly, wakeWhenIdle, resolve, batchTimer: null };
      waiter.timer = setTimeout(() => this.settleWaiter(waiter), Math.min(timeoutMs, terminalOnly ? RUN_WAIT_MS : WAIT_TOOL_TIMEOUT_MS));
      signal?.addEventListener("abort", () => this.settleWaiter(waiter), { once: true });
      this.waiters.add(waiter);
      this.checkWaiter(waiter);
    });
  }

  checkWaiter(waiter) {
    if (waiter.terminalOnly) {
      if (this.failure || this.questions.size || !this.active) this.settleWaiter(waiter);
      return;
    }
    const fresh = this.activity.filter((event) => event.seq > waiter.since);
    if (fresh.some((event) => URGENT.has(event.kind)) || (!this.active && waiter.wakeWhenIdle)) this.settleWaiter(waiter);
    else if (fresh.length) waiter.batchTimer ??= setTimeout(() => this.settleWaiter(waiter), WAIT_BATCH_MS);
  }

  settleWaiter(waiter) {
    if (!this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    clearTimeout(waiter.batchTimer);
    const reason = this.waitReason(waiter.since) ?? "running";
    waiter.resolve(waiter.terminalOnly ? this.summary(reason === "updated" ? "running" : reason) : this.status(waiter.since, reason));
  }

  notifyWaiters() {
    for (const waiter of this.waiters) this.checkWaiter(waiter);
  }

  waitReason(since) {
    if (this.failure) return "failed";
    if (this.questions.size) return "question";
    if (!this.active) return this.result?.status ?? "idle";
    if (this.activity.at(-1)?.seq > since) return "updated";
    return null;
  }

  summary(status) {
    return {
      session_id: this.id,
      name: this.name,
      mode: this.mode,
      model: this.model,
      thinking: this.thinking,
      status: status ?? this.waitReason(this.activitySeq) ?? "running",
      pending_questions: [...this.questions.values()].map(({ question }) => question),
      result: this.result,
      error: this.failure?.message ?? null,
      cost_usd: Number(this.cost.toFixed(4)),
      worktree: this.worktree,
      activity_latest_seq: this.activitySeq,
      session_file: this.sessionFile
    };
  }

  status(since = 0, reason) {
    return {
      ...this.summary(reason),
      cwd: this.cwd,
      elapsed_ms: this.active ? Date.now() - this.startedAt : null,
      running: this.running ? { ...this.running, elapsed_ms: Date.now() - this.running.started_at } : null,
      activity: this.activity.filter((event) => event.seq > since),
      activity_truncated: since < this.activityEvictedThrough
    };
  }

  handleFailure(error) {
    if (this.failure) return;
    this.failure = error;
    this.active = false;
    this.running = null;
    this.questions.clear();
    this.recordActivity({ kind: "failed", text: shortText(error.message) });
  }

  async kill() {
    // Abort first so the provider stops generating; closing alone could let the run finish.
    if (this.active && !this.failure) await Promise.race([this.client.request("abort").catch(() => {}), delay(KILL_ABORT_MS)]);
    this.handleFailure(new Error(`Session ${this.id} was killed`));
    await this.client?.close();
  }
}

function describeTool({ toolCallId, toolName, args = {} }) {
  const base = { item_id: toolCallId, tool: toolName };
  if (toolName === "bash") return { ...base, kind: "command", command: shortText(args.command, 240) };
  if (toolName === "edit" || toolName === "write") return { ...base, kind: "file_change", path: args.path ?? null };
  return { ...base, kind: "tool", ...(args.path ? { path: args.path } : args.pattern ? { pattern: shortText(args.pattern) } : {}) };
}

function textOf(value) {
  const content = value?.content;
  if (typeof content === "string") return content;
  return (content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
}

function shortText(value, limit = 200) {
  if (!value) return null;
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function shortTail(value, limit = 240) {
  return value ? value.slice(-limit) : null;
}

function modelName(model) {
  return model ? `${model.provider}/${model.id}` : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
