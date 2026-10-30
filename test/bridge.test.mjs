import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Bridge } from "../src/bridge.mjs";
import { readLines } from "../src/pi-client.mjs";

const command = fileURLToPath(new URL("./fake-pi.mjs", import.meta.url));

async function skillsDir(skills) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-bridge-skills-"));
  for (const skill of skills) {
    await mkdir(path.join(dir, skill));
    await writeFile(path.join(dir, skill, "SKILL.md"), `# ${skill}`);
  }
  return dir;
}

test("readLines splits only on LF, across chunks and multibyte characters", () => {
  const stream = new PassThrough();
  const lines = [];
  readLines(stream, (line) => lines.push(line));
  const record = Buffer.from(`${JSON.stringify({ text: "a b é" })}\r\n{"n":2}\n`);
  stream.write(record.subarray(0, 12));
  stream.write(record.subarray(12, 13));
  stream.write(record.subarray(13));
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{ text: "a b é" }, { n: 2 }]);
});

test("MCP server lists the pi tools", async () => {
  const child = spawn(process.execPath, ["src/mcp-server.mjs"], { stdio: ["pipe", "pipe", "inherit"] });
  const messages = [];
  readLines(child.stdout, (line) => messages.push(JSON.parse(line)));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  for (let i = 0; i < 100 && messages.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(messages[1].result.tools.map((tool) => tool.name), [
    "pi_ask", "pi_review", "pi_task", "pi_answer", "pi_steer", "pi_wait", "pi_status", "pi_kill", "pi_models"
  ]);
  child.stdin.end();
  await once(child, "exit");
});

test("a clarification round-trips and the session continues on the same process", async () => {
  const bridge = new Bridge({ command });
  try {
    const session = await bridge.open({ model: "deepseek/deepseek-flash", thinking: "low" }, "ask");
    const asked = await session.run("ASK first");
    assert.equal(asked.status, "question");
    assert.deepEqual(asked.pending_questions, [{ id: "q1", method: "input", title: "Which scope?" }]);

    const answered = await session.answer("q1", "only the API");
    assert.equal(answered.status, "completed");
    assert.equal(answered.result.response, "answered: only the API");
    assert.equal(answered.model, "deepseek/deepseek-flash");
    assert.equal(answered.thinking, "low");

    const next = await (await bridge.open({ session_id: session.id }, "ask")).run("follow up");
    assert.equal(next.result.response, "turn 2: follow up");
    assert.equal(next.session_id, session.id);
    assert.equal(next.cost_usd, 0.02);
    assert.throws(() => session.assertConfig("openai-codex/gpt-6.1-sol"), /Start a new session/);
    await assert.rejects(bridge.open({ session_id: session.id }, "task"), /read-only/);
  } finally {
    await bridge.close();
  }
});

test("select questions only accept one of their options", async () => {
  const bridge = new Bridge({ command });
  try {
    const session = await bridge.open({}, "ask");
    await session.run("SELECT");
    await assert.rejects(session.answer("q1", "mobile"), /one of: api, web/);
    assert.equal((await session.answer("q1", "web")).result.response, "answered: web");
  } finally {
    await bridge.close();
  }
});

test("read-only sessions lose the write tools; task sessions keep them", async () => {
  const bridge = new Bridge({ command });
  try {
    const ask = JSON.parse((await (await bridge.open({}, "ask")).run("ARGS")).result.response);
    const task = JSON.parse((await (await bridge.open({}, "task")).run("ARGS")).result.response);
    assert.equal(ask[ask.indexOf("--exclude-tools") + 1], "edit,write,ask_user_question");
    assert.equal(task[task.indexOf("--exclude-tools") + 1], "ask_user_question");
    assert.ok(ask.includes("-e"));
  } finally {
    await bridge.close();
  }
});

test("review requires both skills and invokes the review skill with the scope", async () => {
  const missing = new Bridge({ command, skillsDir: await skillsDir(["review"]) });
  await assert.rejects(missing.open({}, "review"), /needs the "deslop" skill/);

  const bridge = new Bridge({ command, skillsDir: await skillsDir(["review", "deslop"]) });
  try {
    const session = await bridge.open({}, "review");
    const prompt = bridge.reviewPrompt("src/bridge.mjs");
    assert.match(prompt, /deslop\/SKILL\.md/);
    const result = await session.run(prompt);
    assert.equal(result.result.response, "turn 1: /skill:review Review Claude's work. Scope: src/bridge.mjs");
  } finally {
    await bridge.close();
  }
});

test("pi errors reach Claude: model failures and startup failures", async () => {
  const bridge = new Bridge({ command });
  try {
    const failed = await (await bridge.open({}, "ask")).run("FAIL");
    assert.equal(failed.status, "failed");
    assert.match(failed.result.error, /usage limit/);
    await assert.rejects(bridge.open({ model: "bogus/nope" }, "ask"), /Model "bogus\/nope" not found/);
    assert.equal(bridge.status().sessions.length, 1);
  } finally {
    await bridge.close();
  }
});

test("parallel sessions: one wait returns every session's state when any needs attention", async () => {
  const bridge = new Bridge({ command });
  try {
    const slow = await bridge.open({ name: "slow" }, "task");
    const fast = await bridge.open({ name: "fast" }, "task");
    assert.equal((await slow.run("SLOW", { wait: false })).status, "started");
    await fast.run("quick", { wait: false });

    const started = Date.now();
    const { sessions } = await bridge.wait([{ session_id: slow.id, since: 0 }, { session_id: fast.id, since: 0 }], 10_000);
    assert.ok(Date.now() - started < 2_000);
    const byName = Object.fromEntries(sessions.map((entry) => [entry.name, entry]));
    assert.equal(byName.fast.status, "completed");
    assert.equal(byName.slow.running.command, "sleep 60");

    // A finished session must not wake the group again once its result has been seen.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const quiet = Date.now();
    await bridge.wait([slow, fast].map((session) => ({ session_id: session.id, since: session.activitySeq })), 500);
    assert.ok(Date.now() - quiet >= 450);
    const idleOnly = Date.now();
    assert.equal((await bridge.wait([{ session_id: fast.id, since: fast.activitySeq }], 5_000)).sessions[0].status, "completed");
    assert.ok(Date.now() - idleOnly < 100);

    const steered = await slow.steer("stop sleeping");
    assert.equal(steered.result.response, "steered: stop sleeping");
  } finally {
    await bridge.close();
  }
});

test("wait batches activity after the first event", async () => {
  const bridge = new Bridge({ command });
  try {
    const session = await bridge.open({}, "task");
    await session.run("SLOW", { wait: false });
    const update = await bridge.wait([{ session_id: session.id, since: 0 }]);
    assert.equal(update.sessions[0].status, "updated");
    assert.deepEqual(update.sessions[0].activity.map((event) => event.output_tail ?? event.phase), ["tick"]);
  } finally {
    await bridge.close();
  }
});

test("kill aborts a working session, settles waits, and forgets it", async () => {
  const bridge = new Bridge({ command });
  const session = await bridge.open({}, "task");
  await session.run("SLOW", { wait: false });
  const pending = session.wait({ since: session.activitySeq + 100, timeoutMs: 60_000 });
  const killed = await bridge.kill(session.id);
  assert.equal(killed.killed, true);
  assert.equal((await pending).status, "aborted");
  assert.equal(session.summary().status, "failed");
  assert.match(session.summary().error, /killed/);
  assert.throws(() => bridge.get(session.id), /Unknown pi session/);
});

test("models search filters names and reports the default", async () => {
  const bridge = new Bridge({ command });
  const models = await bridge.models("DEEP");
  assert.deepEqual(models.models, ["deepseek/deepseek-flash"]);
  assert.equal(models.default, "fake/default");
});
