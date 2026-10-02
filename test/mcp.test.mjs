import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
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
    "codex_review",
    "codex_answer",
    "codex_steer",
    "codex_models",
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
          return setTimeout(() => send({ id: 90, method: "item/tool/requestUserInput", params: { questions: [{ id: "scope", question: "Which scope?" }] } }), 5);
        }
        return send({ id: message.id, result: { turn: { id: "turn-1" } } });
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
    const session = await bridge.session({ cwd: dir, model: "gpt-6-astra", effort: "high" });
    const question = await session.ask("Ask me.");
    assert.equal(question.status, "question");
    assert.equal(question.question.question.question, "Which scope?");
    const answer = await session.answer("scope", "the repository");
    assert.equal(answer.status, "completed");
    assert.equal(answer.response, "READY");
  } finally {
    await bridge.close();
  }
});
