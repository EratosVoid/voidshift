#!/bin/sh
# Copies the license and readme into each package and builds it, so every
# published package carries both. Run from the repo root.
set -e
for dir in packages/cli tools/awake tools/agents tools/memory; do
  cp LICENSE "$dir/LICENSE"
  cp README.md "$dir/README.md"
done
pnpm -r build
