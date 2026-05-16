#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="${HOME}/.local/bin"

mkdir -p "$BIN"

shopt -s nullglob
for f in "$DIR"/scripts/*; do
    [[ -f "$f" ]] || continue
    chmod +x "$f"
    ln -sf "$f" "$BIN/$(basename "$f")"
done

echo "Installed scripts from $DIR/scripts/ → $BIN/"
