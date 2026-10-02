import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";

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
    "codex_status"
  ]);
  child.kill("SIGTERM");
  await once(child, "exit");
});
