#!/usr/bin/env node
// Minimal pi RPC stand-in. Prompt keywords pick the behavior: ASK, SELECT, SLOW, FAIL, ARGS.
import { readLines } from "../src/pi-client.mjs";

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const model = flag("--model") ?? "fake/default";
if (model === "bogus/nope") {
  console.error(`Error: Model "${model}" not found.`);
  process.exit(1);
}
const [provider, ...rest] = model.split("/");
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (command, data = {}) => send({ id: command.id, type: "response", command: command.type, success: true, data });
const assistant = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { cost: { total: 0.01 } }, ...extra });
const finish = (text, extra) => {
  send({ type: "message_end", message: assistant(text, extra) });
  send({ type: "agent_settled", aborted: false });
};
let prompts = 0;

readLines(process.stdin, (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") return reply(command, { model: { provider, id: rest.join("/") }, thinkingLevel: flag("--thinking") ?? "medium", sessionFile: "/tmp/fake-session.jsonl" });
  if (command.type === "get_available_models") return reply(command, { models: [{ provider: "deepseek", id: "deepseek-flash" }, { provider: "openai-codex", id: "gpt-6.1-sol" }] });
  if (command.type === "abort") {
    send({ type: "agent_settled", aborted: true });
    return reply(command);
  }
  if (command.type === "steer") {
    reply(command, { disposition: "queued" });
    send({ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", isError: false });
    return finish(`steered: ${command.message}`);
  }
  if (command.type === "extension_ui_response") {
    send({ type: "tool_execution_end", toolCallId: "ask-1", toolName: "ask_claude", isError: false });
    return finish(`answered: ${command.value ?? command.confirmed}`);
  }
  if (command.type !== "prompt") return;
  prompts += 1;
  const text = command.message;
  reply(command, { disposition: "started" });
  send({ type: "agent_start" });
  send({ type: "message_start", message: { role: "assistant", content: [] } });
  if (text.includes("ASK") || text.includes("SELECT")) {
    send({ type: "tool_execution_start", toolCallId: "ask-1", toolName: "ask_claude", args: { question: "Which scope?" } });
    return send(text.includes("SELECT")
      ? { type: "extension_ui_request", id: "ui-uuid-1", method: "select", title: "Which scope?", options: ["api", "web"] }
      : { type: "extension_ui_request", id: "ui-uuid-1", method: "input", title: "Which scope?" });
  }
  if (text.includes("SLOW")) {
    send({ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: { command: "sleep 60" } });
    return setTimeout(() => send({ type: "tool_execution_update", toolCallId: "bash-1", toolName: "bash", partialResult: { content: [{ type: "text", text: "tick" }] } }), 50);
  }
  if (text.includes("FAIL")) return finish("", { content: [], stopReason: "error", errorMessage: "Codex error: The usage limit has been reached" });
  if (text.includes("ARGS")) return finish(JSON.stringify(args));
  setTimeout(() => finish(`turn ${prompts}: ${text.split("\n")[0]}`), 20);
});
