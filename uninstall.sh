#!/usr/bin/env bash
# uninstall.sh
set -euo pipefail

GLOBAL_HOOKS_DIR="$HOME/.git-hooks-code-review"

echo "Uninstalling pre-commit code review hook..."

if [ -d "$GLOBAL_HOOKS_DIR" ]; then
  echo "Removing global hooks directory at $GLOBAL_HOOKS_DIR"
  rm -rf "$GLOBAL_HOOKS_DIR"
  echo "Removed $GLOBAL_HOOKS_DIR"
else
  echo "No global hooks directory found at $GLOBAL_HOOKS_DIR"
fi

if git config --global --get core.hooksPath >/dev/null 2>&1; then
  echo "Unsetting git global hooks path..."
  git config --global --unset core.hooksPath
  echo "Unset core.hooksPath"
else
  echo "Global git core.hooksPath was not set"
fi

echo "✅ Uninstallation complete."
