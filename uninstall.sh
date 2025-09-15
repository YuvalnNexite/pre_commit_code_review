#!/usr/bin/env bash
# uninstall.sh
set -euo pipefail

GLOBAL_HOOKS_DIR="$HOME/.git-hooks"
HOOK_PATH="$GLOBAL_HOOKS_DIR/pre-commit"
BACKUP_PATH="$HOOK_PATH.pre_commit_code_review.backup"
STATE_FILE="$GLOBAL_HOOKS_DIR/.code_review_pre_commit_install_state"
MEMORY_DIR="$GLOBAL_HOOKS_DIR/code_review_memory"
MEMORY_TEMPLATE="$MEMORY_DIR/memory_template.txt"

compute_checksum() {
  local file="$1"

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$file" <<'PY'
import hashlib
import sys
from pathlib import Path

path = Path(sys.argv[1])
print(hashlib.sha256(path.read_bytes()).hexdigest())
PY
  else
    echo "Error: unable to compute checksum (missing sha256sum/shasum/python3)" >&2
    return 1
  fi
}

echo "Uninstalling pre-commit code review hook..."

hook_checksum=""
memory_dir_created=0
memory_template_installed=0
memory_template_checksum=""

if [ -f "$STATE_FILE" ]; then
  # shellcheck disable=SC1090
  source "$STATE_FILE"
else
  echo "No installation state found at $STATE_FILE (proceeding cautiously)."
fi

hook_checksum=${hook_checksum:-}
memory_dir_created=${memory_dir_created:-0}
memory_template_installed=${memory_template_installed:-0}
memory_template_checksum=${memory_template_checksum:-}

if [ -f "$BACKUP_PATH" ]; then
  echo "Restoring previous pre-commit hook from backup..."
  [ -f "$HOOK_PATH" ] && rm -f "$HOOK_PATH"
  mv "$BACKUP_PATH" "$HOOK_PATH"
  echo "Restored original pre-commit hook to $HOOK_PATH"
elif [ -f "$HOOK_PATH" ]; then
  if [ -n "$hook_checksum" ]; then
    current_checksum="$(compute_checksum "$HOOK_PATH")"
    if [ "$current_checksum" = "$hook_checksum" ]; then
      echo "Removing installed pre-commit hook at $HOOK_PATH"
      rm -f "$HOOK_PATH"
    else
      echo "Skipping removal of $HOOK_PATH (file modified since installation)."
    fi
  else
    echo "Skipping removal of $HOOK_PATH (no checksum information available)."
  fi
else
  echo "No pre-commit hook found at $HOOK_PATH"
fi

if [ -f "$MEMORY_TEMPLATE" ] && [ "$memory_template_installed" -eq 1 ]; then
  if [ -n "$memory_template_checksum" ]; then
    current_template_checksum="$(compute_checksum "$MEMORY_TEMPLATE")"
    if [ "$current_template_checksum" = "$memory_template_checksum" ]; then
      echo "Removing memory template at $MEMORY_TEMPLATE"
      rm -f "$MEMORY_TEMPLATE"
    else
      echo "Leaving $MEMORY_TEMPLATE (file modified since installation)."
      memory_template_installed=0
    fi
  else
    echo "Leaving $MEMORY_TEMPLATE (no checksum information available)."
    memory_template_installed=0
  fi
fi

if [ -d "$MEMORY_DIR" ] && [ "$memory_dir_created" -eq 1 ]; then
  if rmdir "$MEMORY_DIR" 2>/dev/null; then
    echo "Removed empty directory $MEMORY_DIR"
  else
    echo "Leaving $MEMORY_DIR (directory not empty)."
  fi
fi

if [ -f "$STATE_FILE" ]; then
  rm -f "$STATE_FILE"
fi

if git config --global --get core.hooksPath >/dev/null 2>&1; then
  current_hooks_path="$(git config --global --get core.hooksPath)"
  if [ "$current_hooks_path" = "$GLOBAL_HOOKS_DIR" ]; then
    echo "Unsetting git global hooks path..."
    git config --global --unset core.hooksPath
    echo "Unset core.hooksPath"
  else
    echo "core.hooksPath points to $current_hooks_path; not changing it."
  fi
else
  echo "Global git core.hooksPath was not set"
fi

echo "✅ Uninstallation complete."
