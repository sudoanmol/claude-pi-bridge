import { spawn } from "node:child_process";
import readline from "node:readline";

export class AppServerClient {
  constructor({ cwd, onServerRequest, onNotification, onFailure, command = process.env.CODEX_BIN ?? "codex" } = {}) {
    this.cwd = cwd;
    this.onServerRequest = onServerRequest;
    this.onNotification = onNotification;
    this.onFailure = onFailure;
    this.command = command;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  async start() {
    this.process = spawn(this.command, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process.stderr.setEncoding("utf8");
    this.stderr = "";
    this.process.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", (code, signal) => {
      if (!this.closed) this.fail(new Error(`codex app-server exited (${signal ?? code})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
    });

    const lines = readline.createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.lines = lines;

    await this.request("initialize", {
      clientInfo: { name: "claude_codex_bridge", title: "Claude Codex Bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true }
    });
    this.notify("initialized", {});
    return this;
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ id, method, params });
    });
  }

  respond(id, result) {
    this.send({ id, result });
  }

  respondError(id, error) {
    this.send({ id, error });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  send(message) {
    if (!this.process?.stdin.writable) throw new Error("Codex app-server stdin is unavailable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch (error) { return this.fail(new Error(`Invalid app-server JSON: ${error.message}`)); }

    if (message.id !== undefined && message.method) {
      return this.onServerRequest?.(message, this);
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? `${pending.method} failed`));
      else pending.resolve(message.result ?? {});
      return;
    }
    this.onNotification?.(message);
  }

  fail(error) {
    if (this.failed) return;
    this.failed = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.onFailure?.(error);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.lines?.close();
    this.process?.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500);
      this.process?.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    if (this.process && this.process.exitCode === null) this.process.kill("SIGTERM");
  }
}
