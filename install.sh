#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p ~/.local/bin
mkdir -p ~/.config/fish/functions

for f in "$DIR"/bin/*; do
    ln -sf "$f" ~/.local/bin/
done

for f in "$DIR"/fish/*.fish; do
    ln -sf "$f" ~/.config/fish/functions/
done

echo "Installed: bin scripts → ~/.local/bin/, fish functions → ~/.config/fish/functions/"
