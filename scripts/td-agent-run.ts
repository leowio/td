#!/usr/bin/env bun

import { parseArgs } from "util";
import { mkdirSync } from "fs";
import { join, basename } from "path";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    agent: { type: "string", default: "auto" },
    workspace: { type: "string", default: process.env.TD_WORKSPACE ?? "" },
    command: { type: "string" },
  },
  strict: true,
});

const command = values.command;
if (!command) {
  console.error("missing --command");
  process.exit(1);
}

function detectAgent(cmd: string, explicit?: string): string {
  if (explicit && explicit !== "auto") return explicit;
  const tokens = cmd.split(/\s+/);
  for (const t of tokens) {
    const low = basename(t).toLowerCase();
    if (low.includes("claude")) return "claude";
    if (low.includes("codex")) return "codex";
  }
  for (const t of tokens) {
    const b = basename(t);
    if (["env", "command", "builtin", "exec"].includes(b) || b.includes("="))
      continue;
    return b.toLowerCase();
  }
  return "unknown";
}

const agent = detectAgent(command, values.agent);
const workspace = values.workspace;

// Output log directory for future use
const logDir =
  process.env.TD_AI_LOG_DIR ??
  join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "td-ai-logs");
mkdirSync(logDir, { recursive: true });

const logPath = join(logDir, `${process.pid}.log`);

// Use `script` to create a real PTY and capture output to a log file
const proc = Bun.spawn(
  ["script", "-qefc", command, "-O", logPath],
  {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    cwd: process.cwd(),
    env: {
      ...process.env,
      TD_AI_AGENT: agent,
      TD_AI_WORKSPACE: workspace,
    },
  },
);

const exitCode = await proc.exited;
process.exit(exitCode);
