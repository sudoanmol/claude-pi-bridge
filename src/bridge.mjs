import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppServerClient } from "./app-server-client.mjs";

const MAX_CLARIFICATIONS = 3;

export class Bridge {
  constructor({ appServerCommand } = {}) {
    this.sessions = new Map();
    this.appServerCommand = appServerCommand;
  }

  async session({ sessionId = randomUUID(), cwd = process.cwd(), model, effort, mode = "ask" } = {}) {
    if (this.sessions.has(sessionId)) return this.sessions.get(sessionId);
    const root = path.resolve(cwd);
    const session = new CodexSession({ sessionId, cwd: root, model, effort, mode, appServerCommand: this.appServerCommand });
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
  constructor({ sessionId, cwd, model, effort, mode, appServerCommand }) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.model = model;
    this.effort = effort;
    this.mode = mode;
    this.appServerCommand = appServerCommand;
    this.clarifications = 0;
    this.pendingQuestion = null;
    this.active = null;
  }

  async start() {
    this.client = new AppServerClient({
      cwd: this.cwd,
      onServerRequest: (message, client) => this.handleServerRequest(message, client),
      onNotification: (message) => this.handleNotification(message),
      onFailure: (error) => this.handleFailure(error),
      command: this.appServerCommand
    });
    await this.client.start();
    this.modelCatalog = await this.loadModels();
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
      approvalPolicy: "never",
      sandbox: this.mode === "task" ? "workspace-write" : "read-only",
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

  async task(prompt, options = {}) {
    if (this.mode !== "task") throw new Error("codex_task requires a task session");
    return this.run(`${prompt}\nMake the requested changes in the repository, then report what changed and any checks you ran. Ask Claude for clarification when needed.`, options);
  }

  async run(prompt, { model, effort } = {}) {
    if (this.active) throw new Error("This Codex session already has an active turn");
    this.validateModelOptions(model ?? this.model, effort ?? this.effort);
    this.clarifications = 0;
    this.output = "";
    this.active = { turnId: null };
    const resultPromise = this.waitForActiveTurn();
    try {
      const started = await this.client.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: prompt }],
        model: model ?? this.model ?? null,
        effort: effort ?? this.effort ?? null,
        cwd: this.cwd,
        sandboxPolicy: this.mode === "task" ? { type: "workspaceWrite", writableRoots: [this.cwd] } : { type: "readOnly" }
      });
      this.active.turnId = started.turn?.id ?? null;
      const result = await resultPromise;
      if (result.status !== "question") this.active = null;
      return { ...result, session_id: this.sessionId };
    } catch (error) {
      this.active = null;
      throw error;
    }
  }

  async answer(questionId, answer) {
    const question = this.pendingQuestion;
    if (!question || !question.questions.some((entry) => entry.id === questionId)) throw new Error(`Unknown question: ${questionId}`);
    question.answers[questionId] = { answers: [answer] };
    const next = question.questions.find((entry) => !question.answers[entry.id]);
    if (next) {
      question.id = next.id;
      question.question = next;
      return { status: "question", question, session_id: this.sessionId };
    }
    this.pendingQuestion = null;
    const completion = this.waitForActiveTurn();
    this.client.respond(question.rpcId, {
      answers: question.answers
    });
    const result = await completion;
    if (result.status !== "question") this.active = null;
    return { ...result, session_id: this.sessionId };
  }

  async steer(message) {
    if (!this.active?.turnId) throw new Error("No active Codex turn to steer");
    await this.client.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.active.turnId,
      input: [{ type: "text", text: message }]
    });
    const result = await this.waitForActiveTurn();
    if (result.status !== "question") this.active = null;
    return { ...result, session_id: this.sessionId };
  }

  waitForActiveTurn() {
    if (!this.active) throw new Error("No active Codex turn");
    if (this.active.result) {
      const result = this.active.result;
      this.active.result = null;
      return Promise.resolve(result);
    }
    if (this.active.pause) {
      const result = this.active.pause;
      this.active.pause = null;
      return Promise.resolve(result);
    }
    return new Promise((resolve, reject) => { this.active.resume = { resolve, reject }; });
  }

  handleServerRequest(message, client) {
    if (message.method !== "item/tool/requestUserInput") {
      client.respondError(message.id, { code: -32601, message: `Unsupported Codex request: ${message.method}` });
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
    this.pendingQuestion = { id: question.id, rpcId: message.id, question, questions, answers: {}, sessionId: this.sessionId };
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
    else active.result = result;
  }

  handleFailure(error) {
    const active = this.active;
    this.pendingQuestion = null;
    this.active = null;
    active?.reject?.(error);
    active?.resume?.reject(error);
  }

  async loadModels() {
    try {
      const result = await this.client.request("model/list", { includeHidden: false });
      return result.data ?? [];
    } catch {
      return [];
    }
  }

  validateModelOptions(model, effort) {
    if (!model && !effort) return;
    const selected = model ? this.modelCatalog.find((entry) => entry.id === model || entry.model === model) : null;
    if (model && !selected) throw new Error(`Unknown Codex model: ${model}. Use codex_models to list available models.`);
    if (!effort) return;
    const target = selected ?? this.modelCatalog.find((entry) => entry.id === this.model || entry.model === this.model || entry.isDefault);
    const efforts = target?.supportedReasoningEfforts?.map((entry) => entry.reasoningEffort) ?? [];
    if (efforts.length && !efforts.includes(effort)) throw new Error(`Unsupported reasoning effort "${effort}" for ${model ?? this.model}; supported: ${efforts.join(", ")}`);
  }

  status() {
    return {
      session_id: this.sessionId,
      thread_id: this.threadId,
      cwd: this.cwd,
      mode: this.mode,
      active: Boolean(this.active),
      pending_question: this.pendingQuestion
    };
  }

  models() { return this.modelCatalog ?? []; }

  async close() { await this.client?.close(); }
}
