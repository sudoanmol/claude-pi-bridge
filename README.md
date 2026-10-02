# Claude ↔ Codex Bridge

Local, one-way-by-default orchestration between Claude Code and Codex CLI.

The bridge exposes Claude-facing MCP tools and keeps a Codex app-server thread alive. Claude can start a task or review, steer Codex while it works, and answer clarification requests that Codex sends through `item/tool/requestUserInput`.

## Status

The project is being built in checkpoints. The current checkpoint contains the app-server client and MCP transport skeleton.

## Requirements

- Node.js 18.18+
- Codex CLI installed and authenticated (`codex --version`)
- Claude Code with local stdio MCP support
