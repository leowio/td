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

# Install opencode integrations
OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-${HOME}/.config/opencode}"
if [[ -d "$DIR/opencode/commands" ]]; then
    mkdir -p "$OPENCODE_CONFIG_DIR/commands"
    for command_file in "$DIR"/opencode/commands/*; do
        [[ -f "$command_file" ]] || continue
        ln -sf "$command_file" "$OPENCODE_CONFIG_DIR/commands/$(basename "$command_file")"
    done
    echo "Installed opencode commands from $DIR/opencode/commands/ → $OPENCODE_CONFIG_DIR/commands/"
fi
if [[ -d "$DIR/opencode/plugins" ]]; then
    mkdir -p "$OPENCODE_CONFIG_DIR/plugins"
    for plugin_file in "$DIR"/opencode/plugins/*; do
        [[ -f "$plugin_file" ]] || continue
        ln -sf "$plugin_file" "$OPENCODE_CONFIG_DIR/plugins/$(basename "$plugin_file")"
    done
    echo "Installed opencode plugins from $DIR/opencode/plugins/ → $OPENCODE_CONFIG_DIR/plugins/"
fi

echo "Installed scripts from $DIR/scripts/ → $BIN/"
