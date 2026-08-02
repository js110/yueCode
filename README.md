# Yue

Yue is my personal, event-driven agent. Every conversation, tool call, and file edit is an event in an immutable log. Your UI, the LLM context, and the session tree are all projections of that log.

[简体中文](./README.zh-CN.md)

## About It

Yue’s shell comes from Pi -> Yue. Thanks to Pi for open sourcing.

Yue is a fork of [pizza](https://github.com/tomsun28/pizza), an open-source event-driven coding agent. It pays tribute to pizza: the reactor-driven turn loop, the SQLite event store, and the single-CLI-tool design are all inherited from it. We stand on the shoulders of the original author and the Pi project that came before it.

- **Reactor-driven turn cycle**
  Unlike `Pi, Claude Code, and Codex`, Yue does not run the agent loop as a brittle `while true` loop. Each turn is a state machine driven by an event-handler table. The result: interrupts, retries, parallel tool calls, and mid-turn failures can all be handled reliably.

- **The log is the single source of truth**
  Every message, model call, tool result, and file change is written to an immutable `EventStore` (SQLite). The UI, the LLM context, and the session tree are all live projections of that log. State is no longer hidden in mutable objects — it can be rebuilt, audited, and replayed, because the log is the single source of truth.

- **Only one execution tool — the CLI**
  JSON is program-friendly at the API level but not model-friendly. Yue aggressively gives the model only one tool: the `CLI Tool`. The model uses it to call `_read`, `_write`, `_edit`, and other command-line commands. Surprisingly, it performs better and is more stable.

- **Why New Session**
  In Yue, you do not need to manually create a new session. Think of it as a long-term task for a friend you can chat with for ten years. A friend will manage their own context.

- **All interfaces share the same runtime**
  The interactive TUI, JSON-RPC server, and one-shot print mode all consume the same `SessionFacade` event stream. Script it, embed it, or chat with it directly in the terminal — it is the same agent.

- **Git log-like branch tree memory**
  Sessions can fork from any earlier message. Rewind, branch, compare. Restart your life anytime, anywhere.

- **Sub-agent graph workflows**
  The main agent can orchestrate multi-step delegation with `_workflow`: a JSON DAG of `delegate` / `verify` / `synthesize` nodes is saved under the agent dir and re-run by name, with zero-token coordination — the definition is the plan. Only sub-agents' final replies enter your context.

## Sub-Agent Workflow (Graph DAGs)

Beyond single delegations, Yue lets the persistent (main) agent orchestrate multi-step sub-agent graphs. A workflow is a JSON DAG of nodes:

- `delegate` — fan a task out to every project directory (requires `task`).
- `verify` — spawn a fresh verifier per directory that checks acceptance criteria (requires `criteria`).
- `synthesize` — one fresh agent reviews all upstream outputs (requires `task` + 1 cwd).

Workflows are persisted as one JSON file per workflow under `<agentDir>/workflows/<name>.json`, so a saved graph can be re-run by name. Nodes whose `dependsOn` are satisfied run in parallel; per-target spawn failures are recorded without aborting the graph, so a `verify` node can still check partial work.

```json
{
  "name": "fix-auth",
  "description": "Fix the auth bug across projects",
  "nodes": [
    {
      "id": "workers",
      "kind": "delegate",
      "cwds": ["../proj-a", "../proj-b"],
      "task": "fix the auth bug and summarize the change"
    },
    {
      "id": "check",
      "kind": "verify",
      "cwds": ["../proj-a", "../proj-b"],
      "criteria": "the auth fix lands and all tests pass",
      "dependsOn": ["workers"]
    },
    {
      "id": "report",
      "kind": "synthesize",
      "cwds": ["."],
      "task": "summarize the overall status of the auth fix across all projects",
      "dependsOn": ["check"]
    }
  ]
}
```

```bash
_workflow list
_workflow save fix-auth --definition '{...}'   # or the <<EOF heredoc form
_workflow run fix-auth
_workflow show fix-auth
_workflow delete fix-auth
```

`_delegate_agent` and `_workflow` are only available to the main (persistent) agent. Each sub-agent runs in its own workspace (independent event store), and only its final reply is returned — intermediate output stays out of the main context.

## Quick Start

### Desktop

Download the installer for your platform (macOS / Linux / Windows) from [GitHub Releases](https://github.com/js110/yueCode/releases), install and launch.

> **macOS users**: Since the app is unsigned, you may see "Yue.app is damaged and can't be opened. Run `xattr -cr /Applications/Yue.app` in Terminal to fix this.

### CLI

```bash
npm install -g @js110/yue
export ZAI_API_KEY=your_zai_api_key
yue
```

---
