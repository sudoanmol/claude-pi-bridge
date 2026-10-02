import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { Bridge } from "../src/bridge.mjs";

test("MCP server advertises the bidirectional Codex tools", async () => {
  const child = spawn(process.execPath, ["src/mcp-server.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => lines.push(...chunk.trim().split("\n").filter(Boolean)));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  for (let i = 0; i < 20 && lines.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const listing = JSON.parse(lines[1]);
  assert.deepEqual(listing.result.tools.map((tool) => tool.name), [
    "codex_ask",
    "codex_task",
    "codex_review",
    "codex_answer",
    "codex_steer",
    "codex_models",
    "codex_close",
    "codex_status"
  ]);
  child.kill("SIGTERM");
  await once(child, "exit");
});

test("a Codex clarification can round-trip through the bridge", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-codex-bridge-"));
  const fake = path.join(dir, "fake-codex.mjs");
  await writeFile(fake, `#!/usr/bin/env node
    import readline from "node:readline";
    const input = readline.createInterface({ input: process.stdin });
    let questionSent = false;
    input.on("line", (line) => {
      const message = JSON.parse(line);
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      if (message.method === "initialize") return send({ id: message.id, result: {} });
      if (message.method === "model/list") return send({ id: message.id, result: { data: [{ id: "gpt-6-astra", model: "gpt-6-astra", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }] }] } });
      if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "thread-1" } } });
      if (message.method === "turn/start") {
        if (!questionSent) {
          questionSent = true;
          send({ id: message.id, result: { turn: { id: "turn-1" } } });
          return setTimeout(() => send({ id: 90, method: "item/tool/requestUserInput", params: { questions: [{ id: "scope", question: "Which scope?" }, { id: "format", question: "Which format?" }] } }), 5);
        }
        send({ id: message.id, result: { turn: { id: "turn-1" } } });
        return setTimeout(() => {
          send({ method: "item/agentMessage/delta", params: { delta: "READY" } });
          send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
        }, 5);
      }
      if (message.id === 90) {
        send({ method: "item/agentMessage/delta", params: { delta: "READY" } });
        return send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
      }
      if (message.method === "turn/steer") return send({ id: message.id, result: {} });
    });
  `);
  await chmod(fake, 0o755);

  const bridge = new Bridge({ appServerCommand: fake });
  try {
    await assert.rejects(bridge.session({ cwd: dir, model: "missing-model" }), /Unknown Codex model/);
    const session = await bridge.session({ cwd: dir, model: "gpt-6-astra", effort: "high" });
    await assert.rejects(session.ask("Ask me.", { model: "missing-model" }), /Start a new session to change model/);
    await assert.rejects(session.ask("Ask me.", { model: "gpt-6-astra", effort: "low" }), /Start a new session to change effort/);
    const question = await session.ask("Ask me.");
    assert.equal(question.status, "question");
    assert.equal(question.question.question.question, "Which scope?");
    const nextQuestion = await session.answer("scope", "the repository");
    assert.equal(nextQuestion.status, "question");
    assert.equal(nextQuestion.question.question.question, "Which format?");
    const answer = await session.answer("format", "plain text");
    assert.equal(answer.status, "completed");
    assert.equal(answer.response, "READY");
    const continuation = await session.ask("Ask again.");
    assert.equal(continuation.status, "completed");
    const started = await session.ask("Run asynchronously.", { wait: false });
    assert.equal(started.status, "started");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = session.status();
    assert.equal(status.active, false);
    assert.equal(status.result.response, "READY");
  } finally {
    await bridge.close();
  }
});

test("MCP continuation keeps the supplied session", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "claude-codex-bridge-mcp-"));
  const fake = path.join(dir, "fake-codex.mjs");
  await writeFile(fake, `#!/usr/bin/env node
    import readline from "node:readline";
    const input = readline.createInterface({ input: process.stdin });
    let questionSent = false;
    input.on("line", (line) => {
      const message = JSON.parse(line);
      const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
      if (message.method === "initialize") return send({ id: message.id, result: {} });
      if (message.method === "model/list") return send({ id: message.id, result: { data: [{ model: "gpt-6-astra", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }] }] } });
      if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: "thread-1" } } });
      if (message.method === "turn/start") {
        send({ id: message.id, result: { turn: { id: "turn-1" } } });
        if (!questionSent) {
          questionSent = true;
          return setTimeout(() => send({ id: 90, method: "item/tool/requestUserInput", params: { questions: [{ id: "scope", question: "Which scope?" }] } }), 5);
        }
        return setTimeout(() => {
          send({ method: "item/agentMessage/delta", params: { delta: "READY" } });
          send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
        }, 5);
      }
      if (message.id === 90) return send({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    });
  `);
  await chmod(fake, 0o755);
  const child = spawn(process.execPath, ["src/mcp-server.mjs"], {
    env: { ...process.env, CODEX_BIN: fake },
    stdio: ["pipe", "pipe", "inherit"]
  });
  const reader = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  reader.on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  const request = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 5000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  try {
    await request(1, "initialize", {});
    const first = await request(2, "tools/call", { name: "codex_ask", arguments: { cwd: dir, model: "gpt-6-astra", effort: "high", prompt: "Ask me." } });
    const firstValue = JSON.parse(first.result.content[0].text);
    const answer = await request(3, "tools/call", { name: "codex_answer", arguments: { session_id: firstValue.session_id, question_id: "scope", answer: "the repository" } });
    assert.equal(JSON.parse(answer.result.content[0].text).status, "completed");
    const continuation = await request(4, "tools/call", { name: "codex_ask", arguments: { session_id: firstValue.session_id, prompt: "Ask again." } });
    assert.equal(JSON.parse(continuation.result.content[0].text).status, "completed");
    const status = await request(5, "tools/call", { name: "codex_status", arguments: { session_id: firstValue.session_id } });
    assert.equal(JSON.parse(status.result.content[0].text).thread_id, "thread-1");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});
