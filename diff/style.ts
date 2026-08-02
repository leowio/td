import { fg, StyledText } from "@opentui/core";
import type { FileTreeRow } from "./tree.ts";

export function ansiToStyledText(content: string) {
  const colors: Record<number, string> = {
    30: "#000000", 31: "#ef4444", 32: "#22c55e", 33: "#eab308", 34: "#3b82f6", 35: "#d946ef", 36: "#06b6d4", 37: "#e5e7eb",
    90: "#6b7280", 91: "#f87171", 92: "#4ade80", 93: "#facc15", 94: "#60a5fa", 95: "#e879f9", 96: "#22d3ee", 97: "#f9fafb",
  };
  const chunks: StyledText["chunks"] = [];
  const pattern = /\x1b\[([0-9;]*)m/g;
  let color: string | undefined;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    const text = content.slice(start, match.index);
    if (text) chunks.push(color ? fg(color)(text) : { __isChunk: true, text });
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
  if (text) chunks.push(color ? fg(color)(text) : { __isChunk: true, text });
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
  const chunks: StyledText["chunks"] = [];
  let cursor = 0;
  for (const char of token.toLowerCase()) {
    const index = lower.indexOf(char, cursor);
    if (index === -1) return [{ __isChunk: true as const, text: path }];
    if (index > cursor) chunks.push({ __isChunk: true, text: path.slice(cursor, index) });
    chunks.push(fg("#facc15")(path[index] ?? ""));
    cursor = index + 1;
  }
  if (cursor < path.length) chunks.push({ __isChunk: true, text: path.slice(cursor) });
  return chunks;
}

export function styledFileRows(
  rows: FileTreeRow[],
  selected: Set<string>,
  currentIndex: number,
  focused: boolean,
  query: string,
) {
  const chunks: StyledText["chunks"] = [];
  rows.forEach((entry, index) => {
    const selectedCount = entry.filePaths.filter((path) => selected.has(path)).length;
    const marker = selectedCount === 0 ? "[ ]" : selectedCount === entry.filePaths.length ? "[x]" : "[-]";
    chunks.push({
      __isChunk: true,
      text: `${index === currentIndex && focused ? ">" : " "}${marker} ${"  ".repeat(entry.depth)}`,
    });
    if (entry.kind === "directory") {
      chunks.push(fg("#60a5fa")(entry.collapsed ? "▸ " : "▾ "));
      chunks.push(...highlightedPath(entry.name, query));
      chunks.push(fg("#6b7280")(` (${entry.filePaths.length})`));
    } else if (entry.change) {
      chunks.push(fg(statusColor(entry.change.status))(entry.change.status.padEnd(4, " ")));
      chunks.push({ __isChunk: true, text: " " });
      chunks.push(...highlightedPath(entry.name, query));
    }
    if (index < rows.length - 1) chunks.push({ __isChunk: true, text: "\n" });
  });
  return new StyledText(chunks);
}
