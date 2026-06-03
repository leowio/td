---
name: td-spawn
description: Spawn an AI panel with a starting message automatically sent. Use this when you need to create a new AI assistant instance (spawn yourself or another agent) with an initial prompt or context. The spawned panel will appear in the current td workspace with the message passed via the agent's native CLI (opencode supported).
allowed-tools: Bash(td-spawn)
---

# td-spawn

Spawn a new AI panel in the current td workspace with an optional starting message automatically sent.

## When to use

- You need to spawn another instance of yourself or a different AI agent
- You want to delegate a task to a fresh AI panel with pre-loaded context
- You need to open a new AI assistant with a specific starting prompt
- You want to create a sub-agent for parallel work in the same project

## Parameters

All parameters are optional except when specified:

| Parameter | Flag | Default | Description |
|-----------|------|---------|-------------|
| **Message** | `-m`, `--message` | _(none)_ | The starting message to auto-send to the new AI panel |
| **Agent** | `-a`, `--agent` | `TD_AI_CMD` or `claude` | The AI command to run in the spawned panel |
| **Workspace** | `-w`, `--workspace` | Current `td-*` workspace | Which workspace to spawn into |
| **Directory** | `-d`, `--directory` | Current directory | Working directory for the new panel |
| **Title** | `-t`, `--title` | _(none)_ | Window title hint for focusing |

## Usage

Spawn yourself with a task:

```bash
td-spawn -m "Review the changes in src/main.ts and suggest improvements"
```

Spawn a different agent with context:

```bash
td-spawn -a codex -m "Implement a user authentication system"
```

Spawn with custom working directory:

```bash
td-spawn -d ./backend -m "Debug the failing test in tests/api.test.ts"
```

## Examples for agents

When you need to delegate work, spawn a sub-agent:

```bash
# Spawn another Claude instance to work on documentation
td-spawn -m "Write comprehensive README documentation for this project"

# Spawn Codex to handle a specific implementation task
td-spawn -a codex -m "Refactor the database layer to use connection pooling"

# Spawn with full context of what you're currently doing
td-spawn -m "Continue implementing the feature I was working on. Current file: src/auth.ts. Goal: add JWT token refresh."
```

## Important notes

- The spawned panel uses the same td workspace layout as `td-agent`
- The window is registered with role `ai` in the workspace state
- Message auto-send uses each AI app's native CLI support; **only opencode is currently supported**
- For opencode, the message is passed via `--prompt` (TUI mode) or as positional args (`run` mode)
- For other agents (claude, codex, etc.), `--message` will spawn the panel but warn that auto-send is not supported
- You can pass additional AI arguments after `--`: `td-spawn -m "hello" -- --dangerously-skip-permissions`
- If not in a `td-*` workspace, spawns a standalone terminal with the AI command
