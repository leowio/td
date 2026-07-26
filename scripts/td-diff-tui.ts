import { BoxRenderable, createCliRenderer, fg, StyledText, TextRenderable } from "@opentui/core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";

type Change = {
  status: string;
  path: string;
  oldPath?: string;
};

type Commit = {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  relativeDate: string;
};

type Pane = "commits" | "files" | "diff";

type Entry = {
  id: string;
  label: string;
};

export type DiffTuiOptions = {
  compareRef: string;
  label: string;
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

function workingChanges(compareRef: string): Change[] {
  const tracked = parseChanges(tryRun(["git", "diff", "--name-status", "-M", compareRef]));
  const seen = new Set(tracked.map((change) => change.path));
  const untracked = tryRun(["git", "ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter((path) => path && !seen.has(path))
    .map((path) => ({ status: "A", path }));
  return [...tracked, ...untracked];
}

function commitsSince(baseRef: string): Commit[] {
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

function changesForCommit(hash: string): Change[] {
  return parseChanges(tryRun(["git", "diff-tree", "--no-commit-id", "--name-status", "-r", "-M", hash]));
}

function statusLabel(change: Change) {
  const path = change.oldPath ? `${change.oldPath} -> ${change.path}` : change.path;
  return `${change.status.padEnd(4, " ")} ${path}`;
}

function semCommand() {
  const localCli = join(process.cwd(), "node_modules", ".bin", "sem-cli");
  if (existsSync(localCli)) return localCli;
  const local = join(process.cwd(), "node_modules", ".bin", "sem");
  if (existsSync(local)) return local;
  return tryRun(["sh", "-lc", "command -v sem-cli"]) ? "sem-cli" : tryRun(["sh", "-lc", "command -v sem"]) ? "sem" : undefined;
}

function writeRefFile(ref: string, path: string, target: string) {
  const exists = Bun.spawnSync(["git", "cat-file", "-e", `${ref}:${path}`], { stderr: "pipe" }).exitCode === 0;
  if (!exists) return false;
  const source = tryRun(["git", "show", `${ref}:${path}`]);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
  return true;
}

function semanticDiff(beforeRef: string, beforePath: string, afterRef: string, afterPath: string) {
  const sem = semCommand();
  if (!sem) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "td-diff-sem-"));
  try {
    const before = join(dir, "before", beforePath);
    const after = join(dir, "after", afterPath);
    if (!writeRefFile(beforeRef, beforePath, before)) return undefined;
    if (!writeRefFile(afterRef, afterPath, after)) return undefined;
    const result = tryRun([sem, "diff", "-v", "--color", "always", before, after]);
    return result.replaceAll(before, beforePath).replaceAll(after, afterPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function semanticWorkingDiff(compareRef: string, change: Change) {
  const sem = semCommand();
  if (!sem || !existsSync(change.path)) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "td-diff-sem-"));
  try {
    const before = join(dir, "before", change.oldPath ?? change.path);
    const after = join(dir, "after", change.path);
    if (!writeRefFile(compareRef, change.oldPath ?? change.path, before)) return undefined;
    mkdirSync(dirname(after), { recursive: true });
    writeFileSync(after, readFileSync(change.path));
    const result = tryRun([sem, "diff", "-v", "--color", "always", before, after]);
    return result.replaceAll(before, change.oldPath ?? change.path).replaceAll(after, change.path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function filterEntries(entries: Entry[], query: string, scheme?: "path") {
  if (!query) return entries;
  const input = entries.map((entry) => `${entry.id}\t${entry.label}`).join("\0");
  const output = tryRun(
    [
      "fzf",
      "--filter",
      query,
      "--read0",
      "--print0",
      "--delimiter",
      "\t",
      "--nth",
      "2..",
      ...(scheme ? ["--scheme", scheme] : []),
    ],
    `${input}\0`,
  );
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return output
    .split("\0")
    .filter(Boolean)
    .map((line) => byId.get(line.slice(0, line.indexOf("\t"))))
    .filter((entry): entry is Entry => Boolean(entry));
}

function changeDiff(compareRef: string, change: Change) {
  const semantic = semanticWorkingDiff(compareRef, change);
  if (semantic) return semantic;
  const diff = tryRun(["git", "diff", "--no-ext-diff", "--color=always", compareRef, "--", change.path]);
  if (diff) return diff;
  return tryRun(["git", "diff", "--no-index", "--color=always", "/dev/null", change.path]);
}

function commitDiff(hash: string, change: Change) {
  const semantic = semanticDiff(`${hash}^`, change.oldPath ?? change.path, hash, change.path);
  if (semantic) return semantic;
  return tryRun(["git", "show", "--format=fuller", "--color=always", hash, "--", change.path]);
}

function ansiToStyledText(content: string) {
  const colors: Record<number, string> = {
    30: "#000000", 31: "#ef4444", 32: "#22c55e", 33: "#eab308", 34: "#3b82f6", 35: "#d946ef", 36: "#06b6d4", 37: "#e5e7eb",
    90: "#6b7280", 91: "#f87171", 92: "#4ade80", 93: "#facc15", 94: "#60a5fa", 95: "#e879f9", 96: "#22d3ee", 97: "#f9fafb",
  };
  const chunks = [];
  const pattern = /\x1b\[([0-9;]*)m/g;
  let color: string | undefined;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const text = content.slice(start, match.index);
    if (text) chunks.push(color ? fg(color)(text) : { __isChunk: true as const, text });
    const codes = match[1]?.split(";").map(Number) ?? [0];
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index] ?? 0;
      if (code === 0 || code === 39) color = undefined;
      else if (colors[code]) color = colors[code];
      else if (code === 38 && codes[index + 1] === 2) {
        const red = codes[index + 2] ?? 255;
        const green = codes[index + 3] ?? 255;
        const blue = codes[index + 4] ?? 255;
        color = `#${red.toString(16).padStart(2, "0")}${green.toString(16).padStart(2, "0")}${blue.toString(16).padStart(2, "0")}`;
        index += 4;
      }
    }
    start = pattern.lastIndex;
  }
  const text = content.slice(start);
  if (text) chunks.push(color ? fg(color)(text) : { __isChunk: true as const, text });
  return new StyledText(chunks);
}

function statusColor(status: string) {
  const key = status[0];
  return key === "A" ? "#4ade80" : key === "D" ? "#f87171" : key === "M" ? "#facc15" : key === "R" ? "#e879f9" : "#d1d5db";
}

function highlightedPath(path: string, query: string) {
  const token = query.split(/\s+/).find((part) => /^[\w./-]+$/.test(part.replaceAll("'", "")))?.replaceAll("'", "");
  if (!token) return [{ __isChunk: true as const, text: path }];
  const lower = path.toLowerCase();
  const target = token.toLowerCase();
  const chunks = [];
  let cursor = 0;
  for (const char of target) {
    const index = lower.indexOf(char, cursor);
    if (index === -1) return [{ __isChunk: true as const, text: path }];
    if (index > cursor) chunks.push({ __isChunk: true as const, text: path.slice(cursor, index) });
    chunks.push(fg("#facc15")(path[index] ?? ""));
    cursor = index + 1;
  }
  if (cursor < path.length) chunks.push({ __isChunk: true as const, text: path.slice(cursor) });
  return chunks;
}

function styledFileRows(
  rows: Entry[],
  changes: Change[],
  selected: Set<string>,
  currentIndex: number,
  focused: boolean,
  query: string,
) {
  const byPath = new Map(changes.map((change) => [change.path, change]));
  const chunks: StyledText["chunks"] = [];
  rows.forEach((entry, index) => {
    const change = byPath.get(entry.id);
    const prefix = `${index === currentIndex && focused ? ">" : " "}${selected.has(entry.id) ? "[x]" : "[ ]"} `;
    chunks.push({ __isChunk: true, text: prefix });
    if (change) {
      chunks.push(fg(statusColor(change.status))(change.status.padEnd(4, " ")));
      chunks.push({ __isChunk: true, text: " " });
      if (change.oldPath) chunks.push({ __isChunk: true, text: `${change.oldPath} -> ` });
      chunks.push(...highlightedPath(change.path, query));
    } else {
      chunks.push({ __isChunk: true, text: entry.label });
    }
    if (index < rows.length - 1) chunks.push({ __isChunk: true, text: "\n" });
  });
  return new StyledText(chunks);
}

function copyToClipboard(text: string) {
  const command = ["wl-copy", "xclip", "xsel", "pbcopy"].find((candidate) =>
    tryRun(["sh", "-lc", `command -v ${candidate}`]),
  );
  if (!command) return false;
  const args =
    command === "xclip"
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

export async function runDiffTui({ compareRef, label }: DiffTuiOptions) {
  const commits = commitsSince(compareRef);
  const commitChangesByHash = new Map<string, Change[]>();
  const patchCache = new Map<string, string>();
  const working = workingChanges(compareRef);
  const selectedCommits = new Set<string>();
  const selectedFiles = new Set<string>();
  const queries: Record<"commits" | "files", string> = { commits: "", files: "" };
  let showCommits = false;
  let focus: Pane = "files";
  let commitIndex = 0;
  let fileIndex = 0;
  let diffScroll = 0;
  let status = "";

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const header = new TextRenderable(renderer, { height: 2, fg: "#a7b0be" });
  const body = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
    focusable: true,
  });
  const commitsBox = new BoxRenderable(renderer, {
    width: "31%",
    border: true,
    title: " Commits ",
    borderColor: "#4b5563",
    focusedBorderColor: "#60a5fa",
  });
  const filesBox = new BoxRenderable(renderer, {
    width: showCommits ? "27%" : "36%",
    border: true,
    title: " Files ",
    borderColor: "#4b5563",
    focusedBorderColor: "#60a5fa",
  });
  const diffBox = new BoxRenderable(renderer, {
    flexGrow: 1,
    border: true,
    title: " Diff ",
    borderColor: "#4b5563",
    focusedBorderColor: "#60a5fa",
  });
  const commitsText = new TextRenderable(renderer, { wrapMode: "none", truncate: true, flexGrow: 1 });
  const filesText = new TextRenderable(renderer, { wrapMode: "none", truncate: true, flexGrow: 1 });
  const diffText = new TextRenderable(renderer, { wrapMode: "none", flexGrow: 1, fg: "#d1d5db" });
  const footer = new TextRenderable(renderer, { height: 2, fg: "#94a3b8" });

  commitsBox.add(commitsText);
  filesBox.add(filesText);
  diffBox.add(diffText);
  body.add(commitsBox);
  body.add(filesBox);
  body.add(diffBox);
  renderer.root.add(header);
  renderer.root.add(body);
  renderer.root.add(footer);

  function effectiveCommits(): Commit[] {
    if (selectedCommits.size > 0) return commits.filter((commit) => selectedCommits.has(commit.hash));
    const current = commits[commitIndex];
    return current ? [current] : [];
  }

  function activeChanges() {
    if (!showCommits) return working;
    const changes = new Map<string, Change>();
    for (const commit of effectiveCommits()) {
      let items = commitChangesByHash.get(commit.hash);
      if (!items) {
        items = changesForCommit(commit.hash);
        commitChangesByHash.set(commit.hash, items);
      }
      for (const item of items) changes.set(item.path, item);
    }
    return [...changes.values()];
  }

  function visibleCommits() {
    return filterEntries(
      commits.map((commit) => ({
        id: commit.hash,
        label: `${commit.shortHash} ${commit.subject}  ${commit.author} (${commit.relativeDate})`,
      })),
      queries.commits,
    );
  }

  function visibleFiles() {
    return filterEntries(
      activeChanges().map((change) => ({ id: change.path, label: statusLabel(change) })),
      queries.files,
      "path",
    );
  }

  function selectedOrCurrentFiles(): Entry[] {
    const visible = visibleFiles();
    if (selectedFiles.size > 0) return visible.filter((entry) => selectedFiles.has(entry.id));
    const current = visible[fileIndex];
    return current ? [current] : [];
  }

  function renderDiff() {
    const files = selectedOrCurrentFiles();
    if (files.length === 0) return "No file selected.";
    if (!showCommits) {
      return files
        .map((file) => {
          const change = working.find((item) => item.path === file.id);
          return change ? changeDiff(compareRef, change) || `No diff for ${file.id}.` : `No diff for ${file.id}.`;
        })
        .join("\n");
    }

    const selected = effectiveCommits();
    const patches: string[] = [];
    for (const file of files) {
      for (const commit of selected) {
        let changes = commitChangesByHash.get(commit.hash);
        if (!changes) {
          changes = changesForCommit(commit.hash);
          commitChangesByHash.set(commit.hash, changes);
        }
        const change = changes.find((item) => item.path === file.id);
        if (!change) continue;
        const key = `${commit.hash}\0${file.id}`;
        let patch = patchCache.get(key);
        if (patch === undefined) {
          patch = commitDiff(commit.hash, change);
          patchCache.set(key, patch);
        }
        if (patch) patches.push(patch);
      }
    }
    return patches.length > 0 ? patches.join("\n") : "Selected commits do not modify this file.";
  }

  function clampIndexes() {
    const commitRows = visibleCommits();
    const fileRows = visibleFiles();
    commitIndex = Math.max(0, Math.min(commitIndex, Math.max(0, commitRows.length - 1)));
    fileIndex = Math.max(0, Math.min(fileIndex, Math.max(0, fileRows.length - 1)));
  }

  function render() {
    clampIndexes();
    const commitRows = visibleCommits();
    const fileRows = visibleFiles();
    header.content = [
      `td-diff ${label}`,
      showCommits
        ? `Commit view: ${selectedCommits.size || 1} effective commit(s) | query: ${queries[focus === "commits" ? "commits" : "files"] || "(empty)"}`
        : `Working-tree view | query: ${queries.files || "(empty)"}`,
    ].join("\n");
    commitsBox.visible = showCommits;
    filesBox.width = showCommits ? "27%" : "36%";
    commitsBox.borderColor = focus === "commits" ? "#60a5fa" : "#4b5563";
    filesBox.borderColor = focus === "files" ? "#60a5fa" : "#4b5563";
    diffBox.borderColor = focus === "diff" ? "#60a5fa" : "#4b5563";
    commitsText.content = commitRows.length
      ? commitRows
          .map((entry, index) => `${index === commitIndex && focus === "commits" ? ">" : " "}${selectedCommits.has(entry.id) ? "[x]" : "[ ]"} ${entry.label}`)
          .join("\n")
      : "No commits ahead of the base.";
    filesText.content = fileRows.length
      ? styledFileRows(fileRows, activeChanges(), selectedFiles, fileIndex, focus === "files", queries.files)
      : "No matching files.";
    diffText.content = ansiToStyledText(renderDiff());
    diffText.scrollY = diffScroll;
    footer.content = [
      "Alt-G commits  Alt-Left/Right panes  Up/Down navigate  Tab select  Ctrl-U clear  Ctrl-W delete word",
      `${status || "Type to search with fzf syntax. Esc/Ctrl-C exits."}`,
    ].join("\n");
    renderer.root.requestRender();
  }

  function currentEntry(pane: "commits" | "files") {
    const rows = pane === "commits" ? visibleCommits() : visibleFiles();
    return rows[pane === "commits" ? commitIndex : fileIndex];
  }

  function move(delta: number) {
    if (focus === "commits") commitIndex += delta;
    if (focus === "files") fileIndex += delta;
    if (focus === "diff") diffScroll = Math.max(0, diffScroll + delta);
  }

  function toggleSelection() {
    if (focus === "commits") {
      const current = currentEntry("commits");
      if (!current) return;
      selectedCommits.has(current.id) ? selectedCommits.delete(current.id) : selectedCommits.add(current.id);
      selectedFiles.clear();
      fileIndex = 0;
    }
    if (focus === "files") {
      const current = currentEntry("files");
      if (!current) return;
      selectedFiles.has(current.id) ? selectedFiles.delete(current.id) : selectedFiles.add(current.id);
    }
  }

  function addToQuery(sequence: string) {
    const pane = focus === "commits" ? "commits" : "files";
    queries[pane] += sequence;
    if (pane === "commits") commitIndex = 0;
    else fileIndex = 0;
  }

  body.onKeyDown = (key) => {
    if (key.ctrl && key.name === "c") {
      renderer.destroy();
      return;
    }
    if (key.name === "escape") {
      renderer.destroy();
      return;
    }
    if (key.meta && key.name === "g") {
      showCommits = !showCommits;
      focus = showCommits ? "commits" : "files";
      selectedFiles.clear();
      fileIndex = 0;
      status = showCommits ? "Commit sidebar enabled." : "Commit sidebar hidden.";
      render();
      return;
    }
    if (key.meta && (key.name === "left" || key.name === "right")) {
      const panes: Pane[] = showCommits ? ["commits", "files", "diff"] : ["files", "diff"];
      const index = panes.indexOf(focus);
      const delta = key.name === "left" ? -1 : 1;
      focus = panes[(index + delta + panes.length) % panes.length] ?? focus;
      render();
      return;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      move(-1);
      render();
      return;
    }
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      move(1);
      render();
      return;
    }
    if (key.name === "pageup") {
      move(-10);
      render();
      return;
    }
    if (key.name === "pagedown") {
      move(10);
      render();
      return;
    }
    if (key.name === "tab") {
      toggleSelection();
      move(key.shift ? -1 : 1);
      render();
      return;
    }
    if (key.ctrl && key.name === "u") {
      if (focus !== "diff") queries[focus] = "";
      render();
      return;
    }
    if (key.ctrl && key.name === "w") {
      if (focus !== "diff") queries[focus] = queries[focus].replace(/\S+\s*$/, "");
      render();
      return;
    }
    if (key.ctrl && key.name === "y") {
      const paths = selectedOrCurrentFiles().map((entry) => entry.id).join("\n");
      status = paths && copyToClipboard(paths) ? "Copied selected paths." : "Clipboard command unavailable.";
      render();
      return;
    }
    if (key.name === "backspace") {
      if (focus !== "diff") queries[focus] = queries[focus].slice(0, -1);
      render();
      return;
    }
    if (!key.ctrl && !key.meta && focus !== "diff" && key.sequence.length === 1) {
      addToQuery(key.sequence);
      render();
    }
  };

  body.focus();
  render();
}
