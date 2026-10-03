#!/usr/bin/env node
import readline from "node:readline";
import { Bridge } from "./bridge.mjs";

const bridge = new Bridge();

const tools = [
  {
    name: "codex_ask",
    description: "Ask Codex a repository question. Codex may pause and return a clarification question for Claude to answer with codex_answer.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        session_id: { type: "string" },
        cwd: { type: "string" },
        model: { type: "string", description: "Set only when starting a new session. Use codex_models for valid values." },
        effort: { type: "string", description: "Set only when starting a new session. Use codex_models for valid values." },
        include_commentary: { type: "boolean", description: "Include streamed commentary as well as the final answer." },
        wait: { type: "boolean", description: "Wait for completion. Set false to steer or answer while Codex works." }
      },
      required: ["prompt"]
    }
  },
  {
    name: "codex_task",
    description: "Ask Codex to make repository changes. Codex can pause for clarification before continuing.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        session_id: { type: "string" },
        cwd: { type: "string" },
        model: { type: "string", description: "Set only when starting a new session. Use codex_models for valid values." },
        effort: { type: "string", description: "Set only when starting a new session. Use codex_models for valid values." },
        include_commentary: { type: "boolean", description: "Include streamed commentary as well as the final answer." },
        wait: { type: "boolean", description: "Wait for completion. Set false to steer or answer while Codex works." }
      },
      required: ["prompt"]
    }
  },
  {
    name: "codex_review",
    description: "Run an interactive read-only Codex review. Codex can ask Claude clarification questions before returning findings.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        base: { type: "string" },
        session_id: { type: "string" },
        cwd: { type: "string" },
        model: { type: "string", description: "Set only when starting a new session. Use codex_models for valid values." },
        effort: { type: "string", description: "Set only when starting a new session. Use codex_models for valid values." },
        include_commentary: { type: "boolean", description: "Include streamed commentary as well as the final answer." },
        wait: { type: "boolean", description: "Wait for completion. Set false to steer or answer while Codex works." }
      }
    }
  },
  {
    name: "codex_answer",
    description: "Answer a clarification question Codex asked during the current session.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, question_id: { type: "string" }, answer: { type: "string" } },
      required: ["session_id", "question_id", "answer"]
    }
  },
  {
    name: "codex_steer",
    description: "Send feedback or a correction to an active Codex turn.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, message: { type: "string" } },
      required: ["session_id", "message"]
    }
  },
  {
    name: "codex_models",
    description: "List Codex models and the reasoning efforts each model supports.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, cwd: { type: "string" }, verbose: { type: "boolean" } }
    }
  },
  {
    name: "codex_close",
    description: "Close a Codex session and its local app-server process.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"]
    }
  },
  {
    name: "codex_status",
    description: "Inspect a Codex bridge session and any pending clarification question.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"]
    }
  }
];

async function callTool(name, args = {}) {
  if (name === "codex_ask") {
    const session = args.session_id ? bridge.get(args.session_id) : await bridge.session(args);
    return session.ask(args.prompt, args);
  }
  if (name === "codex_task") {
    const session = args.session_id ? bridge.get(args.session_id) : await bridge.session({ ...args, mode: "task" });
    return session.task(args.prompt, args);
  }
  if (name === "codex_review") {
    const session = args.session_id ? bridge.get(args.session_id) : await bridge.session({ ...args, mode: "review" });
    return session.review(args);
  }
  if (name === "codex_answer") return bridge.get(args.session_id).answer(args.question_id, args.answer);
  if (name === "codex_steer") return bridge.get(args.session_id).steer(args.message);
  if (name === "codex_models") {
    if (args.session_id) {
      const session = bridge.get(args.session_id);
      return { session_id: session.sessionId, models: session.models(args.verbose === true) };
    }
    const session = await bridge.session({ cwd: args.cwd });
    try {
      return { models: session.models(args.verbose === true) };
    } finally {
      await bridge.closeSession(session.sessionId);
    }
  }
  if (name === "codex_close") return bridge.closeSession(args.session_id);
  if (name === "codex_status") return bridge.get(args.session_id).status();
  throw new Error(`Unknown tool: ${name}`);
}

function result(id, value) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] } };
}

function error(id, message) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

const input = readline.createInterface({ input: process.stdin });
input.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "notifications/initialized") return;
  if (message.method === "initialize") {
    return process.stdout.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-codex-bridge", version: "0.1.0" }
      }
    })}\n`);
  }
  try {
    if (message.method === "tools/list") return process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } })}\n`);
    if (message.method === "tools/call") {
      const value = await callTool(message.params?.name, message.params?.arguments);
      return process.stdout.write(`${JSON.stringify(result(message.id, value))}\n`);
    }
    process.stdout.write(`${JSON.stringify(error(message.id, `Unknown method: ${message.method}`))}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify(error(message.id, err.message))}\n`);
  }
});

process.on("SIGINT", async () => { await bridge.close(); process.exit(0); });
process.on("SIGTERM", async () => { await bridge.close(); process.exit(0); });
