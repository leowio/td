#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p ~/.local/bin

for f in "$DIR"/scripts/*; do
    ln -sf "$f" ~/.local/bin/
done

echo "Installed: bin scripts → ~/.local/bin/"
