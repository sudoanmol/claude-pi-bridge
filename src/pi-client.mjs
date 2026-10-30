import { spawn } from "node:child_process";

// Split on LF only: readline also splits on U+2028/U+2029, which are valid inside JSON strings.
export function readLines(stream, onLine) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
  });
}

export class PiClient {
  constructor({ cwd, args = [], onEvent, onFailure, command = process.env.PI_BIN ?? "pi" } = {}) {
    this.cwd = cwd;
    this.args = args;
    this.onEvent = onEvent;
    this.onFailure = onFailure;
    this.command = command;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.stderr = "";
  }

  start() {
    this.process = spawn(this.command, ["--mode", "rpc", ...this.args], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-4000); });
    // A dead child surfaces through `exit`; without this listener an EPIPE would crash the MCP server.
    this.process.stdin.on("error", () => {});
    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", (code, signal) => {
      if (!this.closed) this.fail(new Error(`pi exited (${signal ?? code})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
    });
    readLines(this.process.stdout, (line) => this.handleLine(line));
  }

  request(type, params = {}) {
    if (this.failed) return Promise.reject(this.failed);
    if (this.closed) return Promise.reject(new Error("pi is closed"));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, type });
      this.send({ id, type, ...params });
    });
  }

  send(message) {
    if (!this.process?.stdin.writable) throw new Error("pi stdin is unavailable");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch (error) { return this.fail(new Error(`Invalid pi JSON: ${error.message}`)); }
    if (message.type !== "response") return this.onEvent?.(message);
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.success) pending.resolve(message.data ?? {});
    else pending.reject(new Error(message.error ?? `${pending.type} failed`));
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
    this.process?.stdin.end();
    await new Promise((resolve) => {
      if (!this.process || this.process.exitCode !== null || this.process.signalCode) return resolve();
      const timer = setTimeout(resolve, 1000);
      this.process.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    if (this.process && this.process.exitCode === null && !this.process.signalCode) this.process.kill("SIGTERM");
  }
}
