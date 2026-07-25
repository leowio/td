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
