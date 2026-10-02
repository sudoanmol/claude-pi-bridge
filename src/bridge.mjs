import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppServerClient } from "./app-server-client.mjs";

const MAX_CLARIFICATIONS = 3;

export class Bridge {
  constructor() {
    this.sessions = new Map();
  }

  async session({ sessionId = randomUUID(), cwd = process.cwd(), model, effort, mode = "ask" } = {}) {
    if (this.sessions.has(sessionId)) return this.sessions.get(sessionId);
    const root = path.resolve(cwd);
    const session = new CodexSession({ sessionId, cwd: root, model, effort, mode });
    await session.start();
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown bridge session: ${sessionId}`);
    return session;
  }

  async close() {
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
  }
}

class CodexSession {
  constructor({ sessionId, cwd, model, effort, mode }) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.model = model;
    this.effort = effort;
    this.mode = mode;
    this.clarifications = 0;
    this.pendingQuestion = null;
    this.active = null;
  }

  async start() {
    this.client = new AppServerClient({
      cwd: this.cwd,
      onServerRequest: (message, client) => this.handleServerRequest(message, client),
      onNotification: (message) => this.handleNotification(message)
    });
    await this.client.start();
    const developerInstructions = [
      "You are Codex working as a peer to Claude Code.",
      "Work only inside the supplied repository and follow its AGENTS.md instructions.",
      "When a material requirement or repository fact is missing, use request_user_input to ask Claude for clarification instead of guessing.",
      "Keep clarification questions short and actionable. Do not ask the human directly."
    ].join(" ");
    const thread = await this.client.request("thread/start", {
      cwd: this.cwd,
      model: this.model ?? null,
      ephemeral: false,
      sandbox: "read-only",
      developerInstructions,
      threadSource: "cli"
    });
    this.threadId = thread.thread?.id;
    if (!this.threadId) throw new Error("Codex did not return a thread id");
  }

  async ask(prompt, { model, effort } = {}) {
    return this.run(prompt, { model, effort });
  }

  async review({ prompt = "Review the current repository changes and report concrete findings.", base, model, effort } = {}) {
    const target = base ? `Review the changes from ${base} to HEAD.` : "Review the current uncommitted changes, including untracked files.";
    return this.run(`${target}\n${prompt}\nDo not modify files. Ask Claude for clarification when needed.`, { model, effort });
  }

  async run(prompt, { model, effort } = {}) {
    if (this.active) throw new Error("This Codex session already has an active turn");
    this.clarifications = 0;
    this.output = "";
    const completion = new Promise((resolve, reject) => { this.active = { resolve, reject, turnId: null }; });
    const started = await this.client.request("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt }],
      model: model ?? this.model ?? null,
      effort: effort ?? this.effort ?? null,
      cwd: this.cwd,
      sandboxPolicy: { type: "readOnly" }
    });
    this.active.turnId = started.turn?.id ?? null;
    const result = await completion;
    if (result.status === "question") return { ...result, session_id: this.sessionId };
    this.active = null;
    return { ...result, session_id: this.sessionId };
  }

  async answer(questionId, answer) {
    const question = this.pendingQuestion;
    if (!question || question.id !== questionId) throw new Error(`Unknown question: ${questionId}`);
    this.pendingQuestion = null;
    this.client.respond(question.rpcId, {
      answers: { [questionId]: { answers: [answer] } }
    });
    return this.waitForActiveTurn();
  }

  async steer(message) {
    if (!this.active?.turnId) throw new Error("No active Codex turn to steer");
    await this.client.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.active.turnId,
      input: [{ type: "text", text: message }]
    });
    return this.waitForActiveTurn();
  }

  waitForActiveTurn() {
    if (!this.active) throw new Error("No active Codex turn");
    return new Promise((resolve, reject) => { this.active.resume = { resolve, reject }; });
  }

  handleServerRequest(message, client) {
    if (message.method !== "item/tool/requestUserInput") {
      client.respond(message.id, { answers: {} });
      return;
    }
    const questions = message.params?.questions ?? [];
    if (this.clarifications >= MAX_CLARIFICATIONS) {
      client.respond(message.id, { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: ["Proceed with the safest reasonable assumption and state it explicitly."] }])) });
      return;
    }
    this.clarifications += 1;
    const question = questions[0];
    if (!question) return client.respond(message.id, { answers: {} });
    this.pendingQuestion = { id: question.id, rpcId: message.id, question, sessionId: this.sessionId };
    const active = this.active;
    const result = { status: "question", question: this.pendingQuestion };
    if (active?.resume) { active.resume.resolve(result); active.resume = null; }
    else if (active) { active.pause = result; }
  }

  handleNotification(message) {
    if (message.method === "item/agentMessage/delta") this.output += message.params?.delta ?? "";
    if (message.method !== "turn/completed") return;
    const active = this.active;
    if (!active) return;
    const result = { status: message.params?.turn?.status ?? "completed", response: this.output, turn: message.params?.turn ?? null };
    if (active.resume) { active.resume.resolve(result); active.resume = null; }
    else { active.resolve(result); }
  }

  status() {
    return {
      session_id: this.sessionId,
      thread_id: this.threadId,
      cwd: this.cwd,
      active: Boolean(this.active),
      pending_question: this.pendingQuestion
    };
  }

  async close() { await this.client?.close(); }
}
