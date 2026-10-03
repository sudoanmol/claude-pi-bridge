import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppServerClient } from "./app-server-client.mjs";

const MAX_CLARIFICATIONS = 3;

export class Bridge {
  constructor({ appServerCommand } = {}) {
    this.sessions = new Map();
    this.appServerCommand = appServerCommand;
  }

  async session({ sessionId, cwd = process.cwd(), model, effort, mode = "ask" } = {}) {
    if (sessionId && this.sessions.has(sessionId)) {
      const existing = this.sessions.get(sessionId);
      existing.assertConfig(model, effort);
      return existing;
    }
    if (sessionId) throw new Error(`Unknown bridge session: ${sessionId}`);
    sessionId = randomUUID();
    const root = path.resolve(cwd);
    const session = new CodexSession({ sessionId, cwd: root, model, effort, mode, appServerCommand: this.appServerCommand });
    try {
      await session.start();
    } catch (error) {
      await session.close();
      throw error;
    }
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown bridge session: ${sessionId}`);
    return session;
  }

  async closeSession(sessionId) {
    const session = this.get(sessionId);
    await session.close();
    this.sessions.delete(sessionId);
    return { session_id: sessionId, closed: true };
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
    const defaultModel = this.modelCatalog.find((entry) => entry.isDefault);
    const selectedModel = this.model
      ? this.modelCatalog.find((entry) => entry.id === this.model || entry.model === this.model)
      : defaultModel;
    if (this.model && !selectedModel) throw new Error(`Unknown Codex model: ${this.model}. Use codex_models to list available models.`);
    this.model = selectedModel?.model ?? selectedModel?.id ?? null;
    this.effort ??= selectedModel?.defaultReasoningEffort ?? null;
    this.validateModelOptions(this.model, this.effort);
    const developerInstructions = [
      "You are Codex working as a peer to Claude Code.",
      "Work only inside the supplied repository and follow its AGENTS.md instructions.",
      "When a material requirement or repository fact is missing, use request_user_input to ask Claude for clarification instead of guessing.",
      "Keep clarification questions short and actionable. Do not ask the human directly."
    ].join(" ");
    this.collaborationMode = this.mode === "task" ? "default" : "plan";
    this.collaborationSettings = {
      model: this.model,
      reasoning_effort: this.effort,
      developer_instructions: developerInstructions
    };
    const thread = await this.client.request("thread/start", {
      cwd: this.cwd,
      model: this.model ?? null,
      ephemeral: false,
      approvalPolicy: "never",
      sandbox: this.mode === "task" ? "workspace-write" : "read-only",
      developerInstructions,
      collaborationMode: { mode: this.collaborationMode, settings: this.collaborationSettings },
      threadSource: "cli"
    });
    this.threadId = thread.thread?.id;
    if (!this.threadId) throw new Error("Codex did not return a thread id");
  }

  async ask(prompt, options = {}) {
    return this.run(prompt, options);
  }

  async review({ prompt = "Review the current repository changes and report concrete findings.", base, ...options } = {}) {
    const target = base ? `Review the changes from ${base} to HEAD.` : "Review the current uncommitted changes, including untracked files.";
    return this.run(`${target}\n${prompt}\nDo not modify files. Ask Claude for clarification when needed.`, options);
  }

  async task(prompt, options = {}) {
    if (this.mode !== "task") throw new Error("codex_task requires a task session");
    return this.run(`${prompt}\nMake the requested changes in the repository, then report what changed and any checks you ran. Ask Claude for clarification when needed.`, options);
  }

  async run(prompt, { model, effort, include_commentary = false, wait = true } = {}) {
    if (this.active?.result) this.active = null;
    if (this.active) throw new Error("This Codex session already has an active turn");
    this.assertConfig(model, effort);
    this.clarifications = 0;
    this.output = "";
    this.messages = new Map();
    this.active = { turnId: null, includeCommentary: include_commentary, startedAt: Date.now() };
    const resultPromise = wait ? this.waitForActiveTurn() : null;
    try {
      const started = await this.client.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: prompt }],
        model: this.model,
        effort: this.effort,
        cwd: this.cwd,
        sandboxPolicy: this.mode === "task" ? { type: "workspaceWrite", writableRoots: [this.cwd] } : { type: "readOnly" },
        collaborationMode: { mode: this.collaborationMode, settings: this.collaborationSettings }
      });
      this.active.turnId = started.turn?.id ?? null;
      if (!wait) return this.envelope({ status: "started", turn: this.summarizeTurn(started.turn ?? { id: this.active.turnId, status: "inProgress" }) });
      const result = await resultPromise;
      if (result.status !== "question") this.active = null;
      return this.envelope(result);
    } catch (error) {
      this.active = null;
      throw error;
    }
  }

  async answer(questionId, answer) {
    const question = this.pendingQuestion;
    if (!question || !question.questions.some((entry) => entry.id === questionId)) throw new Error(`Unknown question: ${questionId}`);
    if (question.kind === "async") return this.answerAsyncQuestion(question, questionId, answer);
    question.answers[questionId] = { answers: [answer] };
    const next = question.questions.find((entry) => !question.answers[entry.id]);
    if (next) {
      question.id = next.id;
      question.question = next;
      return this.envelope({ status: "question", question });
    }
    this.pendingQuestion = null;
    const completion = this.waitForActiveTurn();
    this.client.respond(question.rpcId, {
      answers: question.answers
    });
    const result = await completion;
    if (result.status !== "question") this.active = null;
    return this.envelope(result);
  }

  async answerAsyncQuestion(question, questionId, answer) {
    question.answers[questionId] = answer;
    const next = question.questions.find((entry) => !question.answers[entry.id]);
    if (next) {
      question.id = next.id;
      question.question = next;
      return this.envelope({ status: "question", question });
    }
    this.pendingQuestion = null;
    this.active = null;
    const prompt = Object.entries(question.answers).map(([id, value]) => `${id}: ${value}`).join("\n");
    return this.run(prompt, { include_commentary: question.includeCommentary });
  }

  async steer(message) {
    if (!this.active?.turnId) throw new Error("No active Codex turn to steer");
    if (this.active.result) throw new Error("The Codex turn has already completed");
    await this.client.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.active.turnId,
      input: [{ type: "text", text: message }]
    });
    const result = await this.waitForActiveTurn();
    if (result.status !== "question") this.active = null;
    return this.envelope(result);
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
    if (message.method === "item/agentMessage/delta") {
      const itemId = message.params?.itemId ?? "default";
      this.messages.set(itemId, `${this.messages.get(itemId) ?? ""}${message.params?.delta ?? ""}`);
      this.output += message.params?.delta ?? "";
    }
    if (message.method !== "turn/completed") return;
    const active = this.active;
    if (!active) return;
    const turn = message.params?.turn ?? null;
    const agentMessage = turn?.items?.find((item) => item.type === "agentMessage");
    const asyncQuestions = agentMessage?.questions ?? [];
    if (asyncQuestions.length) {
      const questions = asyncQuestions.map((question, index) => ({
        id: question.id ?? question.title ?? `question_${index + 1}`,
        title: question.title ?? question.question ?? "Clarification",
        options: question.options ?? []
      }));
      const pendingQuestion = {
        kind: "async",
        id: questions[0].id,
        question: questions[0],
        questions,
        answers: {},
        includeCommentary: active.includeCommentary,
        sessionId: this.sessionId
      };
      this.pendingQuestion = pendingQuestion;
      const result = { status: "question", question: pendingQuestion, response: null, turn: this.summarizeTurn(turn) };
      if (active.resume) { active.resume.resolve(result); active.resume = null; }
      else active.result = result;
      return;
    }
    const final = agentMessage?.phase === "final_answer" ? agentMessage.text : turn?.items?.find((item) => item.type === "agentMessage" && item.phase === "final_answer")?.text;
    const response = active.includeCommentary ? [...this.messages.values()].join("\n") : final ?? this.output;
    const result = { status: turn?.status ?? "completed", response, turn: this.summarizeTurn(turn) };
    if (active.resume) { active.resume.resolve(result); active.resume = null; }
    else active.result = result;
  }

  summarizeTurn(turn) {
    if (!turn) return null;
    return {
      id: turn.id,
      status: turn.status,
      error: turn.error ?? null,
      startedAt: turn.startedAt ?? null,
      completedAt: turn.completedAt ?? null,
      durationMs: turn.durationMs ?? null,
      item_ids: (turn.items ?? []).map((item) => item.id).filter(Boolean)
    };
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

  assertConfig(model, effort) {
    if (model !== undefined && model !== this.model) throw new Error(`This session uses model "${this.model}". Start a new session to change model.`);
    if (effort !== undefined && effort !== this.effort) throw new Error(`This session uses reasoning effort "${this.effort}". Start a new session to change effort.`);
  }

  envelope(result) {
    return { ...result, session_id: this.sessionId, model: this.model, effort: this.effort };
  }

  status() {
    return {
      session_id: this.sessionId,
      thread_id: this.threadId,
      cwd: this.cwd,
      mode: this.mode,
      model: this.model,
      effort: this.effort,
      active: Boolean(this.active && !this.active.result),
      turn_id: this.active?.turnId ?? null,
      elapsed_ms: this.active?.startedAt ? Date.now() - this.active.startedAt : null,
      pending_question: this.pendingQuestion,
      result: this.active?.result ?? null
    };
  }

  models(verbose = false) {
    if (verbose) return this.modelCatalog ?? [];
    return (this.modelCatalog ?? []).map((entry) => ({
      id: entry.model ?? entry.id,
      displayName: entry.displayName,
      isDefault: entry.isDefault,
      defaultReasoningEffort: entry.defaultReasoningEffort,
      supportedReasoningEfforts: (entry.supportedReasoningEfforts ?? []).map((effort) => effort.reasoningEffort)
    }));
  }

  async close() { await this.client?.close(); }
}
