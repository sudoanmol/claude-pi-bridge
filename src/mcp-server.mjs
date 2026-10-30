#!/usr/bin/env node
import { Bridge, THINKING_LEVELS } from "./bridge.mjs";
import { codexLimits, MODEL_GUIDE } from "./codex.mjs";
import { readLines } from "./pi-client.mjs";

const bridge = new Bridge();

const sessionProperties = {
  session_id: { type: "string", description: "Continue this session. Omit to start a new one." },
  cwd: { type: "string", description: "Working directory for a new session; defaults to the bridge's working directory." },
  model: { type: "string", description: "provider/id for a new session; see the pi server instructions for which model to pick. Defaults to pi's configured model, openai-codex/gpt-6.1-sol." },
  thinking: { type: "string", enum: THINKING_LEVELS, description: "Thinking level for a new session. pi maps unsupported levels to a nearby one; the result reports the level in use." },
  name: { type: "string", description: "Label for a new session, shown in pi_status and pi's session list." },
  wait: { type: "boolean", description: "Wait up to 100 seconds for a question or completion (default true). Set false to start the turn and supervise with pi_wait, for example when running sessions in parallel." }
};
const answerNote = "pi can ask Claude a clarification question: the result then has status \"question\" and pending_questions; answer with pi_answer. Errors from pi or its model come back as status \"failed\" with error.";

const tools = [
  {
    name: "pi_ask",
    description: `Get a second opinion from pi, or ask it a repository question. The session is read-only: pi has no edit or write tools and is told not to change state. ${answerNote}`,
    inputSchema: { type: "object", properties: { prompt: { type: "string" }, ...sessionProperties }, required: ["prompt"] }
  },
  {
    name: "pi_review",
    description: `Have pi review Claude's work with the review and deslop skills from ~/.agents/skills; fails if either skill is missing. Read-only: pi reports findings and Claude decides what to apply. Pass the scope: files, a diff range such as main...HEAD, or a description of the change. ${answerNote}`,
    inputSchema: { type: "object", properties: { scope: { type: "string", description: "What to review." }, ...sessionProperties }, required: ["scope"] }
  },
  {
    name: "pi_task",
    description: `Give pi a task that changes the workspace. To run pi workers in parallel, start each with worktree:true and wait:false, then supervise them all with one pi_wait. ${answerNote}`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        ...sessionProperties,
        worktree: { type: "boolean", description: "Run in a new git worktree under <repo>/.pi-bridge/worktrees on its own branch from HEAD (uncommitted changes are not included). Root .env files are copied and dependencies installed from the lockfile before pi starts the task. pi commits its work to the branch; merge it, then pi_kill removes the worktree when it is clean. Use for parallel workers." }
      },
      required: ["prompt"]
    }
  },
  {
    name: "pi_answer",
    description: "Answer a question pi asked. For a select question, answer with one of its options; for confirm, answer yes or no.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        question_id: { type: "string", description: "The id from pending_questions, for example q1." },
        answer: { type: "string" },
        wait: sessionProperties.wait
      },
      required: ["session_id", "question_id", "answer"]
    }
  },
  {
    name: "pi_steer",
    description: "Send a correction to a working session. pi reads it after its current tool calls, before its next model call.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, message: { type: "string" }, wait: sessionProperties.wait },
      required: ["session_id", "message"]
    }
  },
  {
    name: "pi_wait",
    description: "Wait on one or more sessions without sending anything. Returns when any of them asks a question, finishes, fails, or shows new activity (batched for 3 seconds after the first event), with the state of every listed session. Pass each session's last activity_latest_seq as since.",
    inputSchema: {
      type: "object",
      properties: {
        sessions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { session_id: { type: "string" }, since: { type: "integer", minimum: 0, description: "Last activity_latest_seq seen; 0 at first." } },
            required: ["session_id", "since"]
          }
        },
        timeout_ms: { type: "integer", minimum: 0, maximum: 90000, default: 90000, description: "Maximum wait; capped at 90 seconds." }
      },
      required: ["sessions"]
    }
  },
  {
    name: "pi_status",
    description: "Read a session's progress now: activity after since, the running step, questions, result, errors, and cost. Without session_id, list every open session. Prefer pi_wait to repeated polling.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, since: { type: "integer", minimum: 0, description: "Return activity after this sequence number." } }
    }
  },
  {
    name: "pi_kill",
    description: "Kill a session: abort its running turn and stop its pi process so it spends no more tokens. Kill sessions you no longer need, including finished ones. A worktree is removed only when it has no uncommitted or untracked changes; its branch is always kept.",
    inputSchema: { type: "object", properties: { session_id: { type: "string" } }, required: ["session_id"] }
  },
  {
    name: "pi_limits",
    description: "Read the ChatGPT plan behind pi's Codex models: plan name, 5-hour and weekly usage with reset times, models that are temporarily unavailable, and the models and thinking levels this plan allows. Check before starting Codex work.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "pi_models",
    description: "Search the models pi can use. Returns provider/id names, pi's default model, and the thinking levels.",
    inputSchema: {
      type: "object",
      properties: { search: { type: "string", description: "Case-insensitive substring, for example deepseek or sonnet. An empty string lists every model (hundreds)." } },
      required: ["search"]
    }
  }
];

async function callTool(name, args = {}) {
  const wait = args.wait !== false;
  if (name === "pi_ask") return (await bridge.open(args, "ask")).run(args.prompt, { wait });
  if (name === "pi_review") return (await bridge.open(args, "review")).run(bridge.reviewPrompt(args.scope), { wait });
  if (name === "pi_task") return (await bridge.open(args, "task")).run(args.prompt, { wait });
  if (name === "pi_answer") return bridge.get(args.session_id).answer(args.question_id, args.answer, { wait });
  if (name === "pi_steer") return bridge.get(args.session_id).steer(args.message, { wait });
  if (name === "pi_wait") return bridge.wait(args.sessions, args.timeout_ms);
  if (name === "pi_status") return bridge.status(args.session_id, args.since ?? 0);
  if (name === "pi_kill") return bridge.kill(args.session_id);
  if (name === "pi_limits") return codexLimits();
  if (name === "pi_models") return bridge.models(args.search);
  throw new Error(`Unknown tool: ${name}`);
}

const instructions = `pi is a second coding agent. Use pi_ask for a second opinion, pi_review to have it review your work, and pi_task to delegate changes, including parallel workers in their own worktrees. pi can ask you questions mid-turn; answer them with pi_answer. Kill sessions with pi_kill once you no longer need them.

${MODEL_GUIDE}`;

const write = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

readLines(process.stdin, async (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    return write({
      id: message.id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "claude-pi-bridge", version: "0.2.0" }, instructions }
    });
  }
  try {
    if (message.method === "tools/list") return write({ id: message.id, result: { tools } });
    if (message.method === "tools/call") {
      const value = await callTool(message.params?.name, message.params?.arguments);
      return write({ id: message.id, result: { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] } });
    }
    write({ id: message.id, error: { code: -32601, message: `Unknown method: ${message.method}` } });
  } catch (err) {
    write({ id: message.id, result: { content: [{ type: "text", text: err.message }], isError: true } });
  }
});

const shutdown = async () => { await bridge.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("end", shutdown);
