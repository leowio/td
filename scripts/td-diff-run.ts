#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { basename, dirname, join, relative } from "path";
import { tmpdir } from "os";
import { parseArgs } from "util";

type Change = {
  status: string;
  path: string;
  oldPath?: string;
};

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    base: { type: "string" },
    "base-ref": { type: "string" },
    path: { type: "string" },
    preview: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
  allowPositionals: true,
});

const branchArg = positionals[0];

if (values.help) {
  console.log(`Usage: td-diff [branch]

Arguments:
  branch                Base branch to compare against (defaults to main)

Options:
  --base <branch>       Alias for the branch argument

Keys:
  enter                 Pick a file from fzf
  tab/shift-tab         Select multiple files in fzf
  ctrl-y                Copy selected file paths from fzf
  alt-a/m/d/r/c/t/u      Filter by change mode in fzf
  alt-x                 Clear the fzf filter
  ctrl-c/esc            Exit picker or pager
`);
  process.exit(0);
}

function run(args: string[], opts: { input?: string; quiet?: boolean } = {}) {
  const proc = Bun.spawnSync(args, {
    stdin: opts.input ? new TextEncoder().encode(opts.input) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr).trimEnd();
  if (proc.exitCode !== 0 && !opts.quiet) {
    throw new Error(stderr || `${args[0]} exited ${proc.exitCode}`);
  }
  return { code: proc.exitCode, stdout, stderr };
}

function has(cmd: string) {
  return run(["sh", "-lc", `command -v ${cmd}`], { quiet: true }).code === 0;
}

function git(args: string[], quiet = false) {
  return run(["git", ...args], { quiet });
}

function quote(s: string) {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function remoteNames() {
  return git(["remote"], true).stdout.split("\n").filter(Boolean);
}

function remoteBranchCandidates(requested: string) {
  const remotes = remoteNames();
  if (remotes.length === 0) throw new Error("No git remotes are configured.");

  const parts = requested.split("/");
  const first = parts[0] ?? "";
  const explicitRemote = remotes.includes(first) && parts.length > 1;
  const fallbackRemote = remotes[0];
  if (!fallbackRemote) throw new Error("No git remotes are configured.");
  const remote = explicitRemote ? first : remotes.includes("origin") ? "origin" : fallbackRemote;
  const branch = explicitRemote ? parts.slice(1).join("/") : requested;
  const branches = branch === "main" ? ["main", "master"] : [branch];

  return branches.map((candidate) => ({ remote, branch: candidate }));
}

function fetchRemoteBranch(remote: string, branch: string) {
  return git(
    ["fetch", "--quiet", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
    true,
  );
}

function resolveBaseRef(requested: string) {
  for (const candidate of remoteBranchCandidates(requested)) {
    const ref = `${candidate.remote}/${candidate.branch}`;
    const fetched = fetchRemoteBranch(candidate.remote, candidate.branch);
    if (
      fetched.code === 0 &&
      git(["rev-parse", "--verify", `${ref}^{commit}`], true).code === 0
    ) {
      return ref;
    }
  }

  throw new Error(`Remote base branch '${requested}' was not found or could not be fetched.`);
}

function changedFiles(baseRef: string): Change[] {
  const result = git(["diff", "--name-status", "-M", baseRef]);
  const tracked = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[0] ?? "?";
      if (status.startsWith("R") || status.startsWith("C")) {
        return { status, oldPath: parts[1], path: parts[2] ?? parts[1] ?? "" };
      }
      return { status, path: parts[1] ?? "" };
    })
    .filter((change) => change.path.length > 0);
  const seen = new Set(tracked.map((change) => change.path));
  const untracked = git(["ls-files", "--others", "--exclude-standard"], true)
    .stdout.split("\n")
    .filter((path) => path && !seen.has(path))
    .map((path) => ({ status: "A", path }));
  return [...tracked, ...untracked];
}

function semCommand() {
  const localCli = join(process.cwd(), "node_modules", ".bin", "sem-cli");
  if (existsSync(localCli)) return localCli;
  const local = join(process.cwd(), "node_modules", ".bin", "sem");
  if (existsSync(local)) return local;
  if (has("sem-cli")) return "sem-cli";
  return has("sem") ? "sem" : undefined;
}

function batCommand() {
  if (has("bat")) return "bat";
  return has("batcat") ? "batcat" : undefined;
}

function clipboardSinkCommand() {
  if (has("wl-copy")) return "wl-copy";
  if (has("xclip")) return "xclip -selection clipboard";
  if (has("xsel")) return "xsel --clipboard --input";
  return has("pbcopy") ? "pbcopy" : undefined;
}

function fileContentCommand(filePath: string) {
  const bat = batCommand();
  if (bat) return [bat, "--color=always", "--style=numbers", "--paging=never", "--", filePath];
  return ["cat", "--", filePath];
}

function fileHeader(change: Change) {
  const key = change.status[0] ?? "?";
  const label = key === "A" ? "ADDED" : key === "D" ? "DELETED" : change.status;
  const path = change.oldPath ? `${change.oldPath} -> ${change.path}` : change.path;
  return `${colorByStatus(label, change.status)} ${path}\n`;
}

function highlightedFile(filePath: string) {
  return run(fileContentCommand(filePath), { quiet: true }).stdout;
}

function highlightedBlob(baseRef: string, filePath: string) {
  const dir = mkdtempSync(join(tmpdir(), "td-diff-file-"));
  try {
    const target = join(dir, filePath);
    if (!writeBlob(baseRef, filePath, target)) return "";
    return highlightedFile(target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function addedOrDeletedFileText(baseRef: string, change: Change) {
  if (change.status.startsWith("A") && existsSync(change.path)) {
    return `${fileHeader(change)}\n${highlightedFile(change.path)}`;
  }

  if (change.status.startsWith("D")) {
    return `${fileHeader(change)}\n${highlightedBlob(baseRef, change.oldPath ?? change.path)}`;
  }

  return undefined;
}

function writeBlob(ref: string, filePath: string, target: string) {
  const result = git(["show", `${ref}:${filePath}`], true);
  if (result.code !== 0) return false;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, result.stdout);
  return true;
}

function writeWorkingFile(filePath: string, target: string) {
  if (!existsSync(filePath)) return false;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(filePath));
  return true;
}

async function stream(args: string[]) {
  const proc = Bun.spawn(args, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

async function pageOutput(command: string[]) {
  if (has("less")) {
    await stream(["sh", "-lc", `${command.map(quote).join(" ")} | less -R`]);
  } else {
    await stream(command);
    console.log("\nPress enter to continue...");
    await Bun.stdin.text();
  }
}

async function pageText(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "td-diff-page-"));
  const file = join(dir, "diff.txt");
  try {
    writeFileSync(file, text);
    if (has("less")) {
      await stream(["less", "-R", file]);
    } else {
      console.log(text);
      console.log("\nPress enter to continue...");
      await Bun.stdin.text();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function showAll(baseRef: string) {
  await pageText(allSummary(baseRef));
}

async function showSelected(changes: Change[]) {
  await pageText([
    `Selected files: ${changes.length}`,
    "",
    ...changes.map(
      (change) =>
        `${change.status.padEnd(4, " ")} ${change.oldPath ? `${change.oldPath} -> ` : ""}${change.path}`,
    ),
  ].join("\n"));
}

function allSummary(baseRef: string) {
  const files = changedFiles(baseRef);
  const counts = new Map<string, number>();
  for (const change of files) {
    const key = change.status[0] ?? "?";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const label = (key: string) =>
    ({
      A: "added",
      C: "copied",
      D: "deleted",
      M: "modified",
      R: "renamed",
      T: "type changed",
      U: "unmerged",
      X: "unknown",
      "?": "unknown",
    })[key] ?? key;

  const lines = [
    `td-diff summary for ${baseRef}..worktree`,
    "",
    `Files changed: ${files.length}`,
    ...[...counts.entries()].map(([key, count]) => `${label(key)}: ${count}`),
    "",
    ...files.map(
      (change) =>
        `${change.status.padEnd(4, " ")} ${change.oldPath ? `${change.oldPath} -> ` : ""}${change.path}`,
    ),
  ];
  return lines.join("\n");
}

function cleanSemOutput(output: string, change: Change, before: string, after: string) {
  const oldPath = change.oldPath ?? change.path;
  return output.replaceAll(before, oldPath).replaceAll(after, change.path);
}

function fileDiffText(baseRef: string, change: Change, sem: string) {
  const oldPath = change.oldPath ?? change.path;

  if (!change.status.startsWith("A") && !change.status.startsWith("D")) {
    const dir = mkdtempSync(join(tmpdir(), "td-diff-"));
    try {
      const before = join(dir, "before", oldPath);
      const after = join(dir, "after", change.path);
      if (writeBlob(baseRef, oldPath, before) && writeWorkingFile(change.path, after)) {
        const result = run([sem, "diff", "-v", "--color", "always", before, after], {
          quiet: true,
        });
        if (result.stdout || result.stderr)
          return cleanSemOutput(result.stdout || result.stderr, change, before, after);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const result = run(["git", "diff", "--color=always", baseRef, "--", oldPath, change.path], {
    quiet: true,
  });
  if (!result.stdout && change.status === "A" && existsSync(change.path)) {
    return run(["git", "diff", "--no-index", "--color=always", "/dev/null", change.path], {
      quiet: true,
    }).stdout;
  }
  return result.stdout || result.stderr;
}

async function showFile(baseRef: string, change: Change) {
  const sem = semCommand();
  const oldPath = change.oldPath ?? change.path;
  const fileText = addedOrDeletedFileText(baseRef, change);

  if (fileText) {
    await pageText(fileText);
    return;
  }

  if (sem && !change.status.startsWith("A") && !change.status.startsWith("D")) {
    await pageText(fileDiffText(baseRef, change, sem));
    return;
  }

  if (
    change.status === "A" &&
    existsSync(change.path) &&
    git(["cat-file", "-e", `${baseRef}:${change.path}`], true).code !== 0
  ) {
    await pageOutput(["git", "diff", "--no-index", "--color=always", "/dev/null", change.path]);
    return;
  }
  await pageOutput(["git", "diff", "--color=always", baseRef, "--", oldPath, change.path]);
}

async function previewFile(baseRef: string, filePath: string) {
  if (filePath === "__ALL__") {
    console.log(allSummary(baseRef));
    return;
  }

  const files = changedFiles(baseRef);
  const change = files.find((item) => item.path === filePath || item.oldPath === filePath);
  if (!change) return;

  const sem = semCommand();
  const oldPath = change.oldPath ?? change.path;
  const fileText = addedOrDeletedFileText(baseRef, change);

  if (fileText) {
    console.log(fileText);
    return;
  }

  if (sem && !change.status.startsWith("A") && !change.status.startsWith("D")) {
    console.log(fileDiffText(baseRef, change, sem));
    return;
  }

  if (
    change.status === "A" &&
    existsSync(change.path) &&
    git(["cat-file", "-e", `${baseRef}:${change.path}`], true).code !== 0
  ) {
    await stream(["git", "diff", "--no-index", "--color=always", "/dev/null", change.path]);
    return;
  }
  await stream(["git", "diff", "--color=always", baseRef, "--", oldPath, change.path]);
}

const ansi = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

function statusColor(status: string) {
  const key = status[0] ?? "?";
  return (
    {
      A: ansi.green,
      C: ansi.cyan,
      D: ansi.red,
      M: ansi.yellow,
      R: ansi.magenta,
      T: ansi.cyan,
      U: ansi.red,
    }[key] ?? ""
  );
}

function colorByStatus(text: string, status: string) {
  const color = statusColor(status);
  return color ? `${color}${text}${ansi.reset}` : text;
}

function pathParts(path: string) {
  return path.split("/").filter(Boolean);
}

function commonAncestor(paths: string[]) {
  const dirs = paths.map((path) => dirname(path)).filter((dir) => dir !== ".");
  if (dirs.length === 0) return ".";

  const [first = [], ...rest] = dirs.map(pathParts);
  const common = [...first];
  for (const parts of rest) {
    let index = 0;
    while (index < common.length && common[index] === parts[index]) index++;
    common.length = index;
  }
  return common.length > 0 ? common.join("/") : ".";
}

function displayFolder(filePath: string, ancestor: string) {
  const dir = dirname(filePath);
  if (dir === ".") return ".";
  if (ancestor === ".") return dir;

  const child = relative(ancestor, dir);
  return child ? join(ancestor, child) : ancestor;
}

function displayFileNode(change: Change, ancestor: string) {
  const folder = displayFolder(change.path, ancestor);
  const name = colorByStatus(basename(change.path), change.status);
  return folder === "." || folder === ancestor
    ? name
    : `${ansi.dim}${folder}/${ansi.reset}${name}`;
}

function pickerInput(files: Change[]) {
  const ancestor = commonAncestor(files.map((file) => file.path));
  return [{ status: "ALL", path: "__ALL__" }, ...files]
    .map((change) => {
      const marker = change.status.padEnd(4, " ");
      const treeName =
        change.path === "__ALL__"
          ? "All changes"
          : displayFileNode(change, ancestor);
      return `${marker}\t${change.path}\t${treeName}`;
    })
    .join("\n");
}

async function pickWithFzf(files: Change[], baseRef: string) {
  const bun = Bun.argv[0] ?? "bun";
  const script = Bun.argv[1] ?? "td-diff-run.ts";
  const ancestor = commonAncestor(files.map((file) => file.path));
  const preview = `path=$(printf '%s' {} | cut -f2); ${quote(bun)} ${quote(script)} --preview --base-ref ${quote(baseRef)} --path "$path"`;
  const clipboard = clipboardSinkCommand();
  const args = [
    "fzf",
    "--ansi",
    "--multi",
    "--border",
    "rounded",
    "--list-border",
    "rounded",
    "--input-border",
    "rounded",
    "--preview-border",
    "rounded",
    "--border-label",
    " td-diff ",
    "--list-label",
    " files ",
    "--input-label",
    " filter ",
    "--cycle",
    "--delimiter",
    "\t",
    "--with-nth",
    "1,3",
    "--accept-nth",
    "2",
    "--header",
    `td-diff ${baseRef}..worktree | root: ${ancestor} | tab: select | ctrl-y: copy paths | enter: view | alt-a/m/d/r: mode | ?: preview | esc: quit`,
    "--preview",
    preview,
    "--preview-window",
    "right,65%,wrap,border-left,nohidden",
    "--preview-label",
    " diff preview ",
    "--bind",
    "?:toggle-preview",
    "--bind",
    "alt-a:change-query(^A )",
    "--bind",
    "alt-m:change-query(^M )",
    "--bind",
    "alt-d:change-query(^D )",
    "--bind",
    "alt-r:change-query(^R)",
    "--bind",
    "alt-c:change-query(^C)",
    "--bind",
    "alt-t:change-query(^T )",
    "--bind",
    "alt-u:change-query(^U )",
    "--bind",
    "alt-x:clear-query",
    "--with-shell",
    "sh -c",
  ];

  if (clipboard) {
    args.push("--bind", `ctrl-y:execute-silent(printf '%s\n' {+2} | ${clipboard})`);
  }

  const proc = Bun.spawnSync(
    args,
    {
      stdin: new TextEncoder().encode(pickerInput(files)),
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  if (proc.exitCode !== 0) return undefined;
  const selected = new TextDecoder().decode(proc.stdout).trimEnd();
  return selected ? selected.split("\n").filter(Boolean) : undefined;
}

async function pickNumbered(files: Change[]) {
  const ancestor = commonAncestor(files.map((file) => file.path));
  console.clear();
  files.forEach((change, index) =>
    console.log(
      `${index + 1}. ${change.status.padEnd(4, " ")} ${displayFileNode(change, ancestor)}`,
    ),
  );
  console.log("\nPick a file number, 'a' for all, or enter to quit: ");
  const answer = (await Bun.stdin.text()).trim();
  if (!answer) return undefined;
  if (answer === "a") return "__ALL__";
  const index = Number(answer) - 1;
  return files[index]?.path;
}

async function main() {
  if (git(["rev-parse", "--is-inside-work-tree"], true).code !== 0) {
    console.error("td-diff: not inside a git repository.");
    process.exit(1);
  }

  const requestedBase =
    values.base ?? branchArg ?? "main";
  const baseRef = values["base-ref"] ?? resolveBaseRef(requestedBase);

  if (values.preview && values.path) {
    await previewFile(baseRef, values.path);
    return;
  }

  const files = changedFiles(baseRef);
  if (files.length === 0) {
    console.log(`No changes against ${baseRef}.`);
    return;
  }

  while (true) {
    console.clear();
    console.log(`td-diff: ${baseRef}..worktree (${files.length} files)`);
    console.log(
      semCommand() ? "renderer: sem" : "renderer: git diff (install sem for semantic diffs)",
    );
    console.log("");

    if (has("fzf")) {
      const selected = await pickWithFzf(files, baseRef);
      if (!selected) break;
      if (selected.includes("__ALL__")) {
        await showAll(baseRef);
        continue;
      }
      const changes = selected
        .map((path) => files.find((item) => item.path === path))
        .filter((change): change is Change => Boolean(change));
      const [change] = changes;
      if (changes.length === 1 && change) await showFile(baseRef, change);
      if (changes.length > 1) await showSelected(changes);
      continue;
    }

    const selected = await pickNumbered(files);
    if (!selected) break;
    if (selected === "__ALL__") {
      await showAll(baseRef);
      continue;
    }
    const change = files.find((item) => item.path === selected);
    if (change) await showFile(baseRef, change);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
