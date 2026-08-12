#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="${HOME}/.local/bin"

mkdir -p "$BIN"

shopt -s nullglob
for f in "$DIR"/scripts/*; do
    [[ -f "$f" ]] || continue
    [[ "$f" == *.json ]] && continue
    chmod +x "$f"
    ln -sf "$f" "$BIN/$(basename "$f")"
done

chmod +x "$DIR/diff.ts"

# Remove helper links created by older td-diff layouts.
for name in td-agent-run.ts td-diff-run.ts td-diff-tui.ts td-diff-git.ts td-diff-style.ts td-diff-tree.ts tsconfig.json; do
    target="$BIN/$name"
    if [[ -L "$target" && "$(readlink -f "$target")" == "$DIR/scripts/$name" ]]; then
        unlink "$target"
    fi
done

# Install skills to ~/.agents/skills
SKILLS_DIR="${HOME}/.agents/skills"
mkdir -p "$SKILLS_DIR"
if [[ -d "$DIR/skills" ]]; then
    for skill in "$DIR"/skills/*; do
        [[ -d "$skill" ]] || continue
        skill_name=$(basename "$skill")
        target="$SKILLS_DIR/$skill_name"
        if [[ -e "$target" || -L "$target" ]]; then
            rm -rf "$target"
        fi
        ln -sf "$skill" "$target"
    done
    echo "Installed skills from $DIR/skills/ → $SKILLS_DIR/"
fi

echo "Installed scripts from $DIR/scripts/ → $BIN/"
