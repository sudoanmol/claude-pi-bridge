// Loaded into each bridge pi session; the dialog becomes a question Claude answers with pi_answer.
export default function (pi) {
  pi.registerTool({
    name: "ask_claude",
    label: "Ask Claude",
    description: "Ask Claude Code, which assigned this work, a clarification question. Use it instead of guessing when a material requirement or repository fact is missing. Blocks until Claude answers.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "One short, actionable question." },
        options: { type: "array", items: { type: "string" }, description: "Suggested answers, if any." }
      },
      required: ["question"]
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const answer = await ctx.ui.input(params.question, params.options?.join(" | "));
      const text = answer ?? "Claude did not answer. Proceed with the safest reasonable assumption and state it.";
      return { content: [{ type: "text", text }], details: { question: params.question, answer: answer ?? null } };
    }
  });
}
