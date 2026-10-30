import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_PROVIDER = "openai-codex";

// Thinking levels each Codex model may use on Plus; an empty list bans the model. Other plans have no limits.
const PLUS_LEVELS = {
  "openai-codex/gpt-6-astra": [],
  "openai-codex/gpt-6.1-sol": ["low", "medium", "high"],
  "openai-codex/gpt-6.1-terra": ["low", "medium", "high", "xhigh", "max"]
};

export const MODEL_GUIDE = `Pick a model and thinking level when starting a pi session:
- deepseek/deepseek-flash (DeepSeek V4.1 Flash): fastest and cheapest. Default choice for parallel workers, routine tasks, and quick second opinions. Thinking: low, high, or max.
- openai-codex/gpt-6.1-terra: the most cost-efficient Codex model. Thinking: low through max.
- openai-codex/gpt-6.1-sol: cost-efficient and highly capable; pi's default. On Plus: low, medium, or high only.
- openai-codex/gpt-6-astra: the most capable model and very costly. Reserve it for the hardest reviews and problems. Never available on Plus.
Codex models draw on the user's ChatGPT plan limits. Call pi_limits before starting Codex work and use deepseek/deepseek-flash when a limit is reached. The bridge rejects Codex models and thinking levels the plan does not allow.`;

// Prints nothing: the token stays in this process and goes only to chatgpt.com.
async function account(command = process.env.PI_BIN ?? "pi") {
  let token;
  try {
    token = (await exec(command, ["auth", "print-bearer-token", "--provider", CODEX_PROVIDER])).stdout.trim();
  } catch {
    throw new Error("pi is not signed in to openai-codex. Run `pi` and sign in with /login.");
  }
  const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}");
  const auth = claims["https://api.openai.com/auth"] ?? {};
  return { token, accountId: auth.chatgpt_account_id, plan: auth.chatgpt_plan_type ?? "unknown" };
}

export async function codexPlan(command) {
  return (await account(command)).plan;
}

export function allowedModels(plan) {
  if (plan !== "plus") return "All Codex models and thinking levels.";
  return Object.fromEntries(Object.entries(PLUS_LEVELS).map(([model, levels]) => [model, levels.length ? levels : "not allowed"]));
}

export function assertAllowed(plan, model, thinking) {
  const levels = plan === "plus" ? PLUS_LEVELS[model] : undefined;
  if (!levels) return;
  if (!levels.length) throw new Error(`${model} is not allowed on the ChatGPT ${plan} plan. Use openai-codex/gpt-6.1-sol or deepseek/deepseek-flash.`);
  if (!levels.includes(thinking)) throw new Error(`${model} on the ChatGPT ${plan} plan allows thinking ${levels.join(", ")}; this session would run at "${thinking}".`);
}

export async function codexLimits(command) {
  const { token, accountId, plan } = await account(command);
  const response = await fetch(USAGE_URL, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": accountId, "User-Agent": "pi-agent" }
  });
  if (!response.ok) throw new Error(`Codex usage request failed: HTTP ${response.status}`);
  return summarizeUsage(await response.json(), plan);
}

export function summarizeUsage(usage, plan = usage.plan_type) {
  const window = (value, name) => value && {
    window: name,
    used_percent: value.used_percent,
    resets_at: value.reset_at ? new Date(value.reset_at * 1000).toISOString() : null,
    resets_in_minutes: value.reset_after_seconds != null ? Math.ceil(value.reset_after_seconds / 60) : null
  };
  const limit = usage.rate_limit ?? {};
  return {
    plan: usage.plan_type ?? plan,
    limit_reached: Boolean(limit.limit_reached),
    windows: [window(limit.primary_window, "5h"), window(limit.secondary_window, "week")].filter(Boolean),
    unavailable_models: Object.fromEntries(Object.entries(usage.model_usage ?? {})
      .filter(([, value]) => value.available === false)
      .map(([model, value]) => [model, { available_at: value.available_at ?? null }])),
    credits: usage.credits ? { has_credits: Boolean(usage.credits.has_credits), balance: usage.credits.balance ?? null } : null,
    allowed_models: allowedModels(usage.plan_type ?? plan)
  };
}
