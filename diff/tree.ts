import type { Change } from "./git.ts";

export type Entry = {
  id: string;
  label: string;
};

export type FileTreeRow = Entry & {
  kind: "directory" | "file";
  path: string;
  name: string;
  depth: number;
  change?: Change;
  filePaths: string[];
  collapsed?: boolean;
};

type FileTreeNode = {
  kind: "directory" | "file";
  path: string;
  name: string;
  change?: Change;
  children: Map<string, FileTreeNode>;
};

export function statusLabel(change: Change) {
  const path = change.oldPath ? `${change.oldPath} -> ${change.path}` : change.path;
  return `${change.status.padEnd(4, " ")} ${path}`;
}

export function filterEntries(entries: Entry[], query: string, scheme?: "path") {
  if (!query) return entries;
  const input = entries.map((entry) => `${entry.id}\t${entry.label}`).join("\0");
  const proc = Bun.spawnSync(
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
    { stdin: new TextEncoder().encode(`${input}\0`), stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return new TextDecoder()
    .decode(proc.stdout)
    .split("\0")
    .filter(Boolean)
    .map((line) => byId.get(line.slice(0, line.indexOf("\t"))))
    .filter((entry): entry is Entry => Boolean(entry));
}

export function fileTreeRows(
  changes: Change[],
  query: string,
  collapsedDirectories: Set<string>,
  expandMatches = false,
) {
  const root: FileTreeNode = { kind: "directory", path: "", name: "", children: new Map() };
  for (const change of changes) {
    const parts = change.path.split("/").filter(Boolean);
    let parent = root;
    let path = "";
    parts.forEach((part, index) => {
      path = path ? `${path}/${part}` : part;
      const isFile = index === parts.length - 1;
      let child = parent.children.get(part);
      if (!child) {
        child = {
          kind: isFile ? "file" : "directory",
          path,
          name: part,
          change: isFile ? change : undefined,
          children: new Map(),
        };
        parent.children.set(part, child);
      } else if (isFile) {
        child.change = change;
      } else if (child.kind === "file") {
        child.kind = "directory";
      }
      parent = child;
    });
  }

  const matchedPaths = new Set(
    filterEntries(changes.map((change) => ({ id: change.path, label: statusLabel(change) })), query, "path")
      .map((entry) => entry.id),
  );
  const includeCache = new Map<FileTreeNode, boolean>();
  const descendantCache = new Map<FileTreeNode, string[]>();
  const includes = (node: FileTreeNode): boolean => {
    const cached = includeCache.get(node);
    if (cached !== undefined) return cached;
    const included = node.kind === "file"
      ? matchedPaths.has(node.path)
      : Boolean(node.change && matchedPaths.has(node.path)) || [...node.children.values()].some(includes);
    includeCache.set(node, included);
    return included;
  };
  const descendants = (node: FileTreeNode): string[] => {
    const cached = descendantCache.get(node);
    if (cached) return cached;
    const paths = node.kind === "file"
      ? [node.path]
      : [...(node.change ? [node.path] : []), ...[...node.children.values()].flatMap(descendants)];
    descendantCache.set(node, paths);
    return paths;
  };

  const rows: FileTreeRow[] = [];
  const visit = (node: FileTreeNode, depth: number) => {
    if (node !== root && !includes(node)) return;
    if (node !== root) {
      rows.push({
        id: node.kind === "directory" ? `dir:${node.path}` : node.path,
        label: node.name,
        kind: node.kind,
        path: node.path,
        name: node.name,
        depth,
        change: node.change,
        filePaths: descendants(node),
        collapsed: node.kind === "directory" && collapsedDirectories.has(node.path),
      });
    }
    if (node.kind === "file" || (node !== root && !expandMatches && collapsedDirectories.has(node.path))) return;
    if (node.change && matchedPaths.has(node.path)) {
      rows.push({
        id: node.path,
        label: `${node.name} (file)`,
        kind: "file",
        path: node.path,
        name: `${node.name} (file)`,
        depth: depth + 1,
        change: node.change,
        filePaths: [node.path],
      });
    }
    const children = [...node.children.values()].sort(
      (left, right) => Number(left.kind === "file") - Number(right.kind === "file") || left.name.localeCompare(right.name),
    );
    for (const child of children) visit(child, node === root ? 0 : depth + 1);
  };
  visit(root, -1);
  return rows;
}
