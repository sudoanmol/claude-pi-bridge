import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Bridge } from "../src/bridge.mjs";

async function sessionFor(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-wait-test-"));
  const fake = path.join(dir, "codex.mjs");
  await writeFile(fake, `#!/usr/bin/env node
    import readline from "node:readline";
    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "initialize") send({ id: message.id, result: {} });
      if (message.method === "model/list") send({ id: message.id, result: { data: [] } });
      if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread" } } });
      if (message.method === "turn/start") send({ id: message.id, result: { turn: { id: "turn" } } });
      if (message.id === 90 || message.method === "turn/steer") {
        if (message.method) send({ id: message.id, result: {} });
        send({ method: "turn/completed", params: { turn: {
          id: "turn", status: "completed",
          items: [{ type: "agentMessage", phase: "final_answer", text: "Answered" }]
        } } });
      }
    });
  `);
  await chmod(fake, 0o755);
  const bridge = new Bridge({ appServerCommand: fake });
  t.after(async () => { await bridge.close(); await rm(dir, { recursive: true, force: true }); });
  return bridge.session({ cwd: dir });
}

function emit(session, method, params) {
  session.handleNotification({ method, params });
}

function complete(session) {
  emit(session, "turn/completed", { turn: { id: "turn", status: "completed", items: [
    { type: "agentMessage", phase: "final_answer", text: "Done" }
  ] } });
}

test("wait returns item updates, bounded output tails, and completion without steering", async (t) => {
  const session = await sessionFor(t);
  await session.ask("Observe", { wait: false });
  const waiting = session.wait(0, 1000);
  const command = { type: "commandExecution", id: "cmd", command: "python3 slug.py", cwd: session.cwd, status: "inProgress" };
  emit(session, "item/started", { item: command });
  const started = await waiting;
  assert.equal(started.status, "updated");
  assert.equal(started.running.command, command.command);
  assert.equal(started.activity.length, 1);
  assert.equal("cwd" in started.activity[0], false);

  emit(session, "item/commandExecution/outputDelta", { itemId: "cmd", delta: "x".repeat(300) });
  emit(session, "item/commandExecution/outputDelta", { itemId: "cmd", delta: "\nlast line" });
  const output = await session.wait(started.activity_latest_seq, 0);
  assert.equal(output.activity.length, 1);
  assert.equal(output.activity[0].output_tail.length, 240);
  assert.ok(output.activity[0].output_tail.endsWith("\nlast line"));
  assert.equal(output.activity_truncated, false);
  assert.equal(started.activity[0].phase, "started");
  assert.equal(started.activity[0].output_tail, undefined);

  const finishing = session.wait(output.activity_latest_seq, 1000);
  emit(session, "item/completed", { item: { ...command, status: "completed", exitCode: 0 } });
  const finished = await finishing;
  assert.equal(finished.running, null);
  assert.equal(finished.activity[0].exit_code, 0);
  assert.equal(session.status().activity.length, 1);
  assert.deepEqual(session.status(finished.activity_latest_seq).activity, []);

  const completion = session.wait(finished.activity_latest_seq, 1000);
  complete(session);
  assert.equal((await completion).result.response, "Done");
  assert.equal((await session.wait(finished.activity_latest_seq, 0)).status, "completed");
});

test("wait times out without consuming the turn and cursors survive continuation", async (t) => {
  const session = await sessionFor(t);
  assert.equal((await session.wait(0, 0)).status, "idle");
  await session.ask("Observe", { wait: false });
  const timedOut = await session.wait(0, 10);
  assert.equal(timedOut.status, "running");
  assert.equal(timedOut.active, true);
  assert.equal(timedOut.turn_id, "turn");
  assert.throws(() => session.wait(-1, 0), /since/);
  assert.throws(() => session.wait(0, NaN), /timeout_ms/);
  emit(session, "turn/plan/updated", { explanation: "First plan" });
  const cursor = session.status().activity_latest_seq;
  complete(session);
  const synchronous = session.ask("Continue");
  emit(session, "turn/plan/updated", { explanation: "Second plan" });
  const next = await session.wait(cursor, 0);
  assert.equal(next.status, "updated");
  assert.ok(next.activity_latest_seq > cursor);
  assert.equal(next.activity_truncated, false);
  complete(session);
  assert.equal((await synchronous).response, "Done");
  assert.equal((await session.wait(next.activity_latest_seq, 0)).result.response, "Done");
});

test("wait delivers blocking and async questions without consuming answers", async (t) => {
  for (const kind of ["blocking", "async"]) {
    const session = await sessionFor(t);
    await session.ask("Ask for context", { wait: false });
    const waiting = session.wait(0, 1000);
    if (kind === "blocking") {
      session.handleServerRequest({ id: 90, method: "item/tool/requestUserInput", params: {
        questions: [{ id: "scope", question: "Which scope?" }]
      } }, session.client);
    } else {
      emit(session, "item/completed", { item: { type: "agentMessage", id: "question", questions: [
        { title: "Which scope?", options: ["Repository"] }
      ] } });
    }
    const result = await waiting;
    assert.equal(result.status, "question");
    assert.equal(result.pending_question.id, kind === "blocking" ? "scope" : "q1");
    assert.equal((await session.wait(result.activity_latest_seq, 0)).status, "question");
    const answer = await session.answer(result.pending_question.id, "Repository");
    assert.equal(answer.status, "completed");
    assert.equal(answer.response, "Answered");
  }
});

test("activity compaction preserves sequence order and reports only actual eviction", async (t) => {
  const session = await sessionFor(t);
  await session.ask("Observe", { wait: false });
  for (let i = 0; i < 201; i += 1) {
    emit(session, "item/started", { item: { id: String(i), type: "commandExecution", command: "true" } });
  }
  const status = session.status();
  assert.equal(status.activity.length, 200);
  assert.equal(status.activity_truncated, true);
  const cursor = status.activity_latest_seq;
  emit(session, "item/completed", { item: { id: "1", type: "commandExecution", command: "true", exitCode: 0 } });
  const next = session.status(cursor);
  assert.equal(next.activity.length, 1);
  assert.equal(next.activity[0].item_id, "1");
  assert.equal(next.activity_truncated, false);
  const seqs = session.status().activity.map((event) => event.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
});

test("close and app-server failure release pending waits", async (t) => {
  for (const fail of [false, true]) {
    const session = await sessionFor(t);
    await session.ask("Observe", { wait: false });
    const rejection = assert.rejects(session.wait(0, 90000), fail ? /disconnected/ : /closed/);
    if (fail) session.handleFailure(new Error("disconnected"));
    else await session.close();
    await rejection;
    assert.equal(session.waiters.size, 0);
    await assert.rejects(session.wait(0, 0), fail ? /disconnected/ : /closed/);
  }
});
