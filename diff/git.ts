import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

export type Change = {
  status: string;
  path: string;
  oldPath?: string;
};

export type Commit = {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  relativeDate: string;
};

function run(args: string[], input?: string) {
  const proc = Bun.spawnSync(args, {
    stdin: input === undefined ? undefined : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr).trimEnd();
  if (proc.exitCode !== 0) throw new Error(stderr || `${args[0]} exited ${proc.exitCode}`);
  return stdout;
}

function tryRun(args: string[], input?: string) {
  try {
    return run(args, input);
  } catch {
    return "";
  }
}

function parseChanges(output: string): Change[] {
  return output
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
}

export function workingChanges(compareRef: string): Change[] {
  const tracked = parseChanges(tryRun(["git", "diff", "--name-status", "-M", compareRef]));
  const seen = new Set(tracked.map((change) => change.path));
  const untracked = tryRun(["git", "ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter((path) => path && !seen.has(path))
    .map((path) => ({ status: "A", path }));
  return [...tracked, ...untracked];
}

export function commitsSince(baseRef: string): Commit[] {
  return tryRun([
    "git",
    "log",
    "--reverse",
    "--format=%H%x1f%h%x1f%s%x1f%an%x1f%ar",
    `${baseRef}..HEAD`,
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", shortHash = "", subject = "", author = "", relativeDate = ""] = line.split("\x1f");
      return { hash, shortHash, subject, author, relativeDate };
    })
    .filter((commit) => commit.hash.length > 0);
}

export function changesForCommit(hash: string): Change[] {
  return parseChanges(tryRun(["git", "diff-tree", "--no-commit-id", "--name-status", "-r", "-M", hash]));
}

export function changesByCommit(baseRef: string) {
  const changes = new Map<string, Change[]>();
  const output = tryRun([
    "git",
    "log",
    "--reverse",
    "--format=%x1e%H",
    "--name-status",
    "-M",
    `${baseRef}..HEAD`,
  ]);
  for (const record of output.split("\x1e").filter(Boolean)) {
    const [hash = "", ...lines] = record.trim().split("\n");
    if (hash) changes.set(hash, parseChanges(lines.join("\n")));
  }
  return changes;
}

let resolvedSemCommand: string | undefined | null;
let resolvedBatCommand: string | undefined | null;

function batCommand() {
  if (resolvedBatCommand !== undefined) return resolvedBatCommand ?? undefined;
  resolvedBatCommand = tryRun(["sh", "-lc", "command -v bat"])
    ? "bat"
    : tryRun(["sh", "-lc", "command -v batcat"])
      ? "batcat"
      : null;
  return resolvedBatCommand ?? undefined;
}

const MAX_FULL_FILE_BYTES = 256 * 1024;

function fullFileHeader(status: "ADDED" | "DELETED", path: string) {
  const color = status === "ADDED" ? 92 : 91;
  return `\x1b[${color}m${status}\x1b[0m  ${path}`;
}

function fullFileTooLarge(status: "ADDED" | "DELETED", path: string, size: number) {
  return `${fullFileHeader(status, path)}\n\nFile is too large to display (${(size / 1024).toFixed(0)} KiB; limit ${MAX_FULL_FILE_BYTES / 1024} KiB).`;
}

function fullFileDiff(status: "ADDED" | "DELETED", path: string, content: string) {
  const size = Buffer.byteLength(content);
  if (size > MAX_FULL_FILE_BYTES) return fullFileTooLarge(status, path, size);
  const bat = batCommand();
  const highlighted = bat
    ? tryRun([bat, "--color=always", "--style=plain", "--paging=never", "--theme=ansi", "--file-name", path, "-"], content) || content
    : content;
  return `${fullFileHeader(status, path)}\n\n${highlighted}`;
}

function semCommand() {
  if (resolvedSemCommand !== undefined) return resolvedSemCommand ?? undefined;
  const local = join(process.cwd(), "node_modules", ".bin", "sem");
  const localCli = join(process.cwd(), "node_modules", ".bin", "sem-cli");
  if (existsSync(local)) return (resolvedSemCommand = local);
  if (existsSync(localCli)) return (resolvedSemCommand = localCli);
  resolvedSemCommand = tryRun(["sh", "-lc", "command -v sem-cli"])
    ? "sem-cli"
    : tryRun(["sh", "-lc", "command -v sem"])
      ? "sem"
      : null;
  return resolvedSemCommand ?? undefined;
}

function writeRefFile(ref: string, path: string, target: string) {
  const exists = Bun.spawnSync(["git", "cat-file", "-e", `${ref}:${path}`], { stderr: "pipe" }).exitCode === 0;
  if (!exists) return false;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, tryRun(["git", "show", `${ref}:${path}`]));
  return true;
}

function semanticDiff(beforeRef: string, beforePath: string, afterRef: string, afterPath: string) {
  const sem = semCommand();
  if (!sem) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "td-diff-sem-"));
  try {
    const before = join(dir, "before", beforePath);
    const after = join(dir, "after", afterPath);
    if (!writeRefFile(beforeRef, beforePath, before) || !writeRefFile(afterRef, afterPath, after)) return undefined;
    return tryRun([sem, "diff", "-v", "--color", "always", before, after])
      .replaceAll(before, beforePath)
      .replaceAll(after, afterPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function semanticWorkingDiff(compareRef: string, change: Change) {
  const sem = semCommand();
  if (!sem || !existsSync(change.path)) return undefined;
  try {
    if (!statSync(change.path).isFile()) return undefined;
  } catch {
    return undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), "td-diff-sem-"));
  try {
    const beforePath = change.oldPath ?? change.path;
    const before = join(dir, "before", beforePath);
    const after = join(dir, "after", change.path);
    if (!writeRefFile(compareRef, beforePath, before)) return undefined;
    mkdirSync(dirname(after), { recursive: true });
    writeFileSync(after, readFileSync(change.path));
    return tryRun([sem, "diff", "-v", "--color", "always", before, after])
      .replaceAll(before, beforePath)
      .replaceAll(after, change.path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function changeDiff(compareRef: string, change: Change) {
  if (change.status[0] === "A") {
    try {
      const size = statSync(change.path).size;
      if (size > MAX_FULL_FILE_BYTES) return fullFileTooLarge("ADDED", change.path, size);
      return fullFileDiff("ADDED", change.path, readFileSync(change.path, "utf8"));
    } catch {
      return `Unable to read added file ${change.path}.`;
    }
  }
  if (change.status[0] === "D") {
    const path = change.oldPath ?? change.path;
    return fullFileDiff("DELETED", path, tryRun(["git", "show", `${compareRef}:${path}`]));
  }
  const semantic = semanticWorkingDiff(compareRef, change);
  if (semantic) return semantic;
  const diff = tryRun(["git", "diff", "--no-ext-diff", "--color=always", compareRef, "--", change.path]);
  return diff || tryRun(["git", "diff", "--no-index", "--color=always", "/dev/null", change.path]);
}

export function commitDiff(hash: string, change: Change) {
  if (change.status[0] === "A") {
    return fullFileDiff("ADDED", change.path, tryRun(["git", "show", `${hash}:${change.path}`]));
  }
  if (change.status[0] === "D") {
    const path = change.oldPath ?? change.path;
    return fullFileDiff("DELETED", path, tryRun(["git", "show", `${hash}^:${path}`]));
  }
  const semantic = semanticDiff(`${hash}^`, change.oldPath ?? change.path, hash, change.path);
  return semantic || tryRun(["git", "show", "--format=fuller", "--color=always", hash, "--", change.path]);
}

export function copyToClipboard(text: string) {
  const command = ["wl-copy", "xclip", "xsel", "pbcopy"].find((candidate) =>
    tryRun(["sh", "-lc", `command -v ${candidate}`]),
  );
  if (!command) return false;
  const args = command === "xclip"
    ? [command, "-selection", "clipboard"]
    : command === "xsel"
      ? [command, "--clipboard", "--input"]
      : [command];
  try {
    run(args, text);
    return true;
  } catch {
    return false;
  }
}
