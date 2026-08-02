#!/usr/bin/env bun

import { parseArgs } from "util";
import { runDiffTui } from "./diff/tui.ts";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    base: { type: "string" },
    direct: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
  allowPositionals: true,
});

if (values.help) {
  console.log(`Usage: td-diff [branch]

Arguments:
  branch                Base branch to compare against (defaults to the remote default branch)

Options:
  --base <branch>       Alias for the branch argument
  --direct              Compare directly against the base branch tip instead of the merge base

Normal mode:
  c / f / d             Toggle commits, files, or diff pane
  h / l                 Focus the pane to the left or right
  j / k                 Navigate the focused pane
  mouse wheel           Move the pointer in the commit or file pane
  left click            Focus the commit or file pane and select a row
  /                     Start an fzf query for the focused list
  tab / shift-tab       Toggle selection and move
  enter                 Collapse or expand a folder
  ctrl-c                Copy selected diff text, otherwise clear selection
  ctrl-y                Copy selected file paths
  q                     Exit

Query mode:
  enter                 Apply query
  escape                Cancel query and restore the previous query
  tab / shift-tab       Toggle selection and move
  ctrl-c                Copy selected diff text, otherwise clear selection
`);
  process.exit(0);
}

function runGit(args: string[], quiet = false) {
  const proc = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr).trimEnd();
  if (proc.exitCode !== 0 && !quiet) throw new Error(stderr || `git ${args[0]} failed`);
  return { code: proc.exitCode, stdout, stderr };
}

function remoteNames() {
  return runGit(["remote"], true).stdout.split("\n").filter(Boolean);
}

function remoteDefaultBranch(remote: string) {
  const ref = runGit(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], true).stdout.trim();
  const prefix = `${remote}/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
}

function remoteBranchCandidates(requested?: string) {
  const remotes = remoteNames();
  if (remotes.length === 0) throw new Error("No git remotes are configured.");
  const parts = requested?.split("/") ?? [];
  const explicitRemote = Boolean(requested) && remotes.includes(parts[0] ?? "") && parts.length > 1;
  const fallbackRemote = remotes[0];
  if (!fallbackRemote) throw new Error("No git remotes are configured.");
  const remote = explicitRemote ? parts[0]! : remotes.includes("origin") ? "origin" : fallbackRemote;
  const branch = requested
    ? explicitRemote
      ? parts.slice(1).join("/")
      : requested
    : remoteDefaultBranch(remote);
  const branches = branch ? (branch === "main" ? ["main", "master"] : [branch]) : ["main", "master"];
  return branches.map((candidate) => ({ remote, branch: candidate }));
}

function resolveBaseRef(requested?: string) {
  for (const candidate of remoteBranchCandidates(requested)) {
    const ref = `${candidate.remote}/${candidate.branch}`;
    const fetched = runGit(
      ["fetch", "--quiet", candidate.remote, `+refs/heads/${candidate.branch}:refs/remotes/${ref}`],
      true,
    );
    if (fetched.code === 0 && runGit(["rev-parse", "--verify", `${ref}^{commit}`], true).code === 0) return ref;
  }
  throw new Error(`Remote branch${requested ? ` '${requested}'` : ""} was not found or could not be fetched.`);
}

async function main() {
  if (runGit(["rev-parse", "--is-inside-work-tree"], true).code !== 0) {
    throw new Error("td-diff: not inside a git repository.");
  }
  const baseRef = resolveBaseRef(values.base ?? positionals[0]);
  const compareRef = values.direct ? baseRef : runGit(["merge-base", baseRef, "HEAD"]).stdout.trim();
  const label = values.direct ? `${baseRef}..worktree` : `${baseRef}...worktree | merge-base: ${compareRef}`;
  await runDiffTui({ compareRef, label });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
