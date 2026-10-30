import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, appendFile, copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const INSTALL_TIMEOUT_MS = 10 * 60_000;
// One installer per ecosystem; the first lockfile found in each group wins.
const INSTALLERS = [
  [
    ["pnpm-lock.yaml", "pnpm", ["install", "--frozen-lockfile"]],
    ["bun.lock", "bun", ["install", "--frozen-lockfile"]],
    ["bun.lockb", "bun", ["install", "--frozen-lockfile"]],
    ["yarn.lock", "yarn", ["install", "--frozen-lockfile"]],
    ["package-lock.json", "npm", ["ci"]]
  ],
  [["uv.lock", "uv", ["sync", "--frozen"]]]
];

const git = async (cwd, ...args) => (await exec("git", args, { cwd })).stdout.trim();
const exists = (file) => access(file).then(() => true, () => false);

// Creates <repo>/.pi-bridge/worktrees/<slug> on a new branch from HEAD and copies the root .env files.
export async function createWorktree(cwd, name) {
  let root;
  try { root = await git(cwd, "rev-parse", "--show-toplevel"); } catch { throw new Error(`A worktree needs a git repository; ${cwd} is not in one.`); }
  const slug = `${(name ?? "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "task"}-${randomBytes(3).toString("hex")}`;
  const dir = path.join(root, ".pi-bridge", "worktrees", slug);
  const branch = `pi-bridge/${slug}`;
  await ignoreBridgeDir(root);
  const base = await git(root, "rev-parse", "--short", "HEAD");
  await mkdir(path.dirname(dir), { recursive: true });
  await git(root, "worktree", "add", "-b", branch, dir, "HEAD");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.startsWith(".env") && !(await exists(target))) await copyFile(path.join(root, entry.name), target);
  }
  return { path: dir, branch, base };
}

// Excludes .pi-bridge/ locally so the main tree never shows the worktrees, without editing .gitignore.
async function ignoreBridgeDir(root) {
  const exclude = path.join(path.resolve(root, await git(root, "rev-parse", "--git-common-dir")), "info", "exclude");
  const current = await readFile(exclude, "utf8").catch(() => "");
  if (current.split("\n").includes(".pi-bridge/")) return;
  await mkdir(path.dirname(exclude), { recursive: true });
  await appendFile(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}.pi-bridge/\n`);
}

export async function installCommands(dir) {
  const commands = [];
  for (const group of INSTALLERS) {
    for (const [lockfile, command, args] of group) {
      if (!(await exists(path.join(dir, lockfile)))) continue;
      commands.push([command, args]);
      break;
    }
  }
  return commands;
}

export async function install(dir, [command, args]) {
  try {
    await exec(command, args, { cwd: dir, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const output = `${error.stderr ?? ""}${error.stdout ?? ""}`.trim().slice(-1500);
    throw new Error(`Dependency install failed: ${command} ${args.join(" ")}${output ? `\n${output}` : `: ${error.message}`}`);
  }
}

// git refuses to remove a worktree with uncommitted or untracked work, which is the check we want.
export async function removeWorktree({ path: dir }) {
  try {
    await git(path.dirname(dir), "worktree", "remove", dir);
    return true;
  } catch {
    return false;
  }
}
