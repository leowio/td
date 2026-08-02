import { BoxRenderable, createCliRenderer, TextRenderable } from "@opentui/core";
import {
  changeDiff,
  changesByCommit,
  changesForCommit,
  commitDiff,
  commitsSince,
  copyToClipboard,
  workingChanges,
  type Change,
  type Commit,
} from "./git.ts";
import { ansiToStyledText, styledFileRows } from "./style.ts";
import { fileTreeRows, filterEntries, type Entry, type FileTreeRow } from "./tree.ts";

type Pane = "commits" | "files" | "diff";
type InputMode = "normal" | "query";

type DiffRequest = {
  key: string;
  mode: "working" | "commits";
  commits: Commit[];
  changes: Change[];
  folder?: FileTreeRow;
};

export type DiffTuiOptions = {
  compareRef: string;
  label: string;
};

export async function runDiffTui({ compareRef, label }: DiffTuiOptions) {
  const commits = commitsSince(compareRef);
  const working = workingChanges(compareRef);
  const commitChangesByHash = changesByCommit(compareRef);
  const patchCache = new Map<string, string>();
  const diffOutputCache = new Map<string, string>();
  const selectedCommits = new Set<string>();
  const selectedFiles = new Set<string>();
  const collapsedDirectories = new Set<string>();
  const queries: Record<"commits" | "files", string> = { commits: "", files: "" };
  const paneVisible: Record<Pane, boolean> = { commits: false, files: true, diff: true };

  let focus: Pane = "files";
  let mode: InputMode = "normal";
  let queryTarget: "commits" | "files" | undefined;
  let queryBeforeEdit = "";
  let commitIndex = 0;
  let fileIndex = 0;
  let diffScroll = 0;
  let status = "";
  let diffTimer: ReturnType<typeof setTimeout> | undefined;
  let diffGeneration = 0;
  let displayedDiffKey = "";
  let commitRowsCacheQuery = "";
  let commitRowsCache: Entry[] | undefined;
  let fileRowsCacheKey = "";
  let fileRowsCache: FileTreeRow[] | undefined;

  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const header = new TextRenderable(renderer, { height: 2, fg: "#a7b0be" });
  const body = new BoxRenderable(renderer, {
    flexGrow: 1,
    flexDirection: "row",
    gap: 1,
    focusable: true,
  });
  const commitsBox = new BoxRenderable(renderer, {
    flexGrow: 1,
    border: true,
    title: " [c] Commits ",
    borderColor: "#4b5563",
  });
  const filesBox = new BoxRenderable(renderer, {
    flexGrow: 1,
    border: true,
    title: " [f] Files ",
    borderColor: "#4b5563",
  });
  const diffBox = new BoxRenderable(renderer, {
    flexGrow: 2,
    border: true,
    title: " [d] Diff ",
    borderColor: "#4b5563",
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

  function visiblePanes() {
    return (["commits", "files", "diff"] as Pane[]).filter((pane) => paneVisible[pane]);
  }

  function stop() {
    if (diffTimer) clearTimeout(diffTimer);
    renderer.destroy();
  }

  function effectiveCommits(): Commit[] {
    if (selectedCommits.size > 0) return commits.filter((commit) => selectedCommits.has(commit.hash));
    const currentId = visibleCommits()[commitIndex]?.id;
    const current = commits.find((commit) => commit.hash === currentId);
    return current ? [current] : [];
  }

  function activeChanges() {
    if (!paneVisible.commits) return working;
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
    if (commitRowsCache && commitRowsCacheQuery === queries.commits) return commitRowsCache;
    commitRowsCacheQuery = queries.commits;
    commitRowsCache = filterEntries(
      commits.map((commit) => ({
        id: commit.hash,
        label: `${commit.shortHash} ${commit.subject}  ${commit.author} (${commit.relativeDate})`,
      })),
      queries.commits,
    );
    return commitRowsCache;
  }

  function visibleFiles(changes = activeChanges()) {
    const key = [
      queries.files,
      [...collapsedDirectories].sort().join("\0"),
      changes.map((change) => `${change.status}\t${change.oldPath ?? ""}\t${change.path}`).join("\0"),
      mode === "query" && queryTarget === "files" ? "editing" : "applied",
    ].join("\x1f");
    if (fileRowsCache && key === fileRowsCacheKey) return fileRowsCache;
    fileRowsCacheKey = key;
    fileRowsCache = fileTreeRows(
      changes,
      queries.files,
      collapsedDirectories,
      mode === "query" && queryTarget === "files",
    );
    return fileRowsCache;
  }

  function selectedOrCurrentFiles(rows: FileTreeRow[], changes: Change[]) {
    if (selectedFiles.size > 0) {
      return changes.filter((change) => selectedFiles.has(change.path));
    }
    const current = rows[fileIndex];
    return current?.kind === "file" && current.change ? [current.change] : [];
  }

  function renderDiff(request: DiffRequest) {
    if (request.changes.length === 0) {
      return request.folder
        ? `${request.folder.path}/\n\n${request.folder.filePaths.length} changed file(s). Press Tab to select this folder's files.`
        : "No file selected.";
    }
    if (request.mode === "working") {
      return request.changes
        .map((change) => changeDiff(compareRef, change) || `No diff for ${change.path}.`)
        .join("\n");
    }

    const patches: string[] = [];
    for (const file of request.changes) {
      for (const commit of request.commits) {
        let changes = commitChangesByHash.get(commit.hash);
        if (!changes) {
          changes = changesForCommit(commit.hash);
          commitChangesByHash.set(commit.hash, changes);
        }
        const change = changes.find((item) => item.path === file.path);
        if (!change) continue;
        const key = `${commit.hash}\0${file.path}`;
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

  function diffRequestFor(rows: FileTreeRow[], changes: Change[]): DiffRequest {
    const requestedChanges = selectedOrCurrentFiles(rows, changes);
    const commitsForDiff = paneVisible.commits ? effectiveCommits() : [];
    const folder = requestedChanges.length === 0 && rows[fileIndex]?.kind === "directory" ? rows[fileIndex] : undefined;
    const mode = paneVisible.commits ? "commits" : "working";
    const key = JSON.stringify({
      mode,
      commits: commitsForDiff.map((commit) => commit.hash),
      files: requestedChanges.map((change) => change.path).sort(),
      folder: folder?.path,
    });
    return { key, mode, commits: commitsForDiff, changes: requestedChanges, folder };
  }

  function scheduleDiff(request: DiffRequest) {
    if (diffTimer) clearTimeout(diffTimer);
    diffTimer = undefined;
    const generation = ++diffGeneration;
    if (request.key === displayedDiffKey) return;
    const cached = diffOutputCache.get(request.key);
    if (cached !== undefined) {
      diffText.content = ansiToStyledText(cached);
      displayedDiffKey = request.key;
      diffScroll = 0;
      diffText.scrollY = 0;
      return;
    }
    if (!displayedDiffKey) diffText.content = "Waiting for selection…";
    diffTimer = setTimeout(() => {
      diffTimer = undefined;
      const output = renderDiff(request);
      diffOutputCache.set(request.key, output);
      if (generation !== diffGeneration) return;
      diffText.content = ansiToStyledText(output);
      displayedDiffKey = request.key;
      diffScroll = 0;
      diffText.scrollY = 0;
      renderer.root.requestRender();
    }, 180);
  }

  function clampIndexes(commitRows: Entry[], fileRows: FileTreeRow[]) {
    commitIndex = Math.max(0, Math.min(commitIndex, Math.max(0, commitRows.length - 1)));
    fileIndex = Math.max(0, Math.min(fileIndex, Math.max(0, fileRows.length - 1)));
  }

  function render() {
    const commitRows = visibleCommits();
    const changes = activeChanges();
    const fileRows = visibleFiles(changes);
    clampIndexes(commitRows, fileRows);

    commitsBox.visible = paneVisible.commits;
    filesBox.visible = paneVisible.files;
    diffBox.visible = paneVisible.diff;
    commitsBox.borderColor = focus === "commits" ? "#60a5fa" : "#4b5563";
    filesBox.borderColor = focus === "files" ? "#60a5fa" : "#4b5563";
    diffBox.borderColor = focus === "diff" ? "#60a5fa" : "#4b5563";

    const activeQuery = queryTarget ? queries[queryTarget] : "";
    header.content = [
      `td-diff ${label}`,
      mode === "query"
        ? `QUERY ${queryTarget}> /${activeQuery}▌`
        : `NORMAL  panes:${visiblePanes().map((pane) => pane[0]).join("")}  focus:${focus}`,
    ].join("\n");
    commitsText.content = commitRows.length
      ? commitRows
          .map((entry, index) => `${index === commitIndex && focus === "commits" ? ">" : " "}${selectedCommits.has(entry.id) ? "[x]" : "[ ]"} ${entry.label}`)
          .join("\n")
      : "No commits ahead of the base.";
    commitsText.scrollY = Math.max(0, commitIndex - Math.max(1, commitsText.height - 2));
    filesText.content = fileRows.length
      ? styledFileRows(fileRows, selectedFiles, fileIndex, focus === "files", queries.files)
      : "No matching files.";
    filesText.scrollY = Math.max(0, fileIndex - Math.max(1, filesText.height - 2));
    diffText.scrollY = diffScroll;
    footer.content = mode === "query"
      ? `QUERY  type to filter  Enter apply  Esc cancel  Tab select  Ctrl-C clear selection\n/${activeQuery}`
      : `NORMAL  c/f/d panes  h/l focus  j/k move  / query  Tab select  Ctrl-C clear  q quit\n${status || "Enter toggles folders  Ctrl-Y copies selected paths"}`;
    if (paneVisible.diff) scheduleDiff(diffRequestFor(fileRows, changes));
    renderer.root.requestRender();
  }

  function move(delta: number) {
    if (focus === "commits") commitIndex += delta;
    if (focus === "files") fileIndex += delta;
    if (focus === "diff") diffScroll = Math.max(0, diffScroll + delta);
  }

  function toggleSelection() {
    if (focus === "commits") {
      const current = visibleCommits()[commitIndex];
      if (!current) return;
      selectedCommits.has(current.id) ? selectedCommits.delete(current.id) : selectedCommits.add(current.id);
      selectedFiles.clear();
      fileIndex = 0;
    } else if (focus === "files") {
      const current = visibleFiles()[fileIndex];
      if (!current) return;
      const allSelected = current.filePaths.every((path) => selectedFiles.has(path));
      for (const path of current.filePaths) {
        if (allSelected) selectedFiles.delete(path);
        else selectedFiles.add(path);
      }
    }
  }

  function clearSelection() {
    if (focus === "commits") {
      selectedCommits.clear();
      selectedFiles.clear();
    } else if (focus === "files") {
      selectedFiles.clear();
    } else {
      selectedCommits.clear();
      selectedFiles.clear();
    }
    status = "Selection cleared.";
  }

  function toggleFolder() {
    if (focus !== "files") return;
    const current = visibleFiles()[fileIndex];
    if (current?.kind !== "directory") return;
    current.collapsed ? collapsedDirectories.delete(current.path) : collapsedDirectories.add(current.path);
  }

  function togglePane(pane: Pane) {
    if (paneVisible[pane] && visiblePanes().length === 1) {
      status = "At least one pane must remain visible.";
      return;
    }
    paneVisible[pane] = !paneVisible[pane];
    if (pane === "diff" && !paneVisible.diff) {
      if (diffTimer) clearTimeout(diffTimer);
      diffTimer = undefined;
      diffGeneration++;
    }
    if (pane === "commits") {
      selectedFiles.clear();
      fileIndex = 0;
    }
    if (!paneVisible[focus]) focus = visiblePanes()[0] ?? "files";
    status = `${pane} pane ${paneVisible[pane] ? "shown" : "hidden"}.`;
  }

  function focusPane(delta: number) {
    const panes = visiblePanes();
    const index = panes.indexOf(focus);
    focus = panes[(index + delta + panes.length) % panes.length] ?? focus;
  }

  function startQuery() {
    if (focus === "diff") {
      status = "Focus commits or files before starting a query.";
      return;
    }
    queryTarget = focus;
    queryBeforeEdit = queries[queryTarget];
    queries[queryTarget] = "";
    mode = "query";
    if (queryTarget === "commits") commitIndex = 0;
    else fileIndex = 0;
  }

  function cancelQuery() {
    if (queryTarget) queries[queryTarget] = queryBeforeEdit;
    mode = "normal";
    queryTarget = undefined;
  }

  function applyQuery() {
    mode = "normal";
    queryTarget = undefined;
  }

  function editQuery(key: { name: string; sequence: string; ctrl: boolean; meta: boolean; shift: boolean }) {
    if (!queryTarget) return;
    if (key.name === "escape") cancelQuery();
    else if (key.name === "return") applyQuery();
    else if (key.name === "backspace") queries[queryTarget] = queries[queryTarget].slice(0, -1);
    else if (key.ctrl && key.name === "u") queries[queryTarget] = "";
    else if (key.ctrl && key.name === "w") queries[queryTarget] = queries[queryTarget].replace(/\S+\s*$/, "");
    else if (!key.ctrl && !key.meta && key.sequence.length === 1) queries[queryTarget] += key.sequence;
    if (queryTarget === "commits") commitIndex = 0;
    else fileIndex = 0;
  }

  body.onKeyDown = (key) => {
    if (key.ctrl && key.name === "c") {
      clearSelection();
      render();
      return;
    }
    if (key.name === "tab") {
      toggleSelection();
      move(key.shift ? -1 : 1);
      render();
      return;
    }
    if (mode === "query") {
      editQuery(key);
      render();
      return;
    }
    if (key.name === "q") {
      stop();
      return;
    }
    if (key.name === "c" || key.name === "f" || key.name === "d") {
      togglePane(key.name === "c" ? "commits" : key.name === "f" ? "files" : "diff");
    } else if (key.name === "h") focusPane(-1);
    else if (key.name === "l") focusPane(1);
    else if (key.name === "j" || key.name === "down" || (key.ctrl && key.name === "n")) move(1);
    else if (key.name === "k" || key.name === "up" || (key.ctrl && key.name === "p")) move(-1);
    else if (key.name === "pagedown") move(10);
    else if (key.name === "pageup") move(-10);
    else if (key.name === "/") startQuery();
    else if (key.name === "return") toggleFolder();
    else if (key.ctrl && key.name === "y") {
      const changes = activeChanges();
      const paths = selectedOrCurrentFiles(visibleFiles(changes), changes).map((change) => change.path).join("\n");
      status = paths && copyToClipboard(paths) ? "Copied selected paths." : "Clipboard command unavailable.";
    }
    render();
  };

  body.focus();
  render();
}
