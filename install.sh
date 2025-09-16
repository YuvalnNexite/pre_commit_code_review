#!/usr/bin/env bash
# install.sh
set -euo pipefail

# Configuration: source repository that hosts the hook and memory files
SOURCE_REPO="YuvalnNexite/pre_commit_code_review"
RAW_BASE="https://raw.githubusercontent.com/${SOURCE_REPO}/main"

HOOK_NAME="code_review_pre-commit.sh"
GLOBAL_HOOKS_DIR="$HOME/.git-hooks-code-review"

echo "Installing pre-commit code review hook globally..."
echo "Source: ${SOURCE_REPO}"

# Create global hooks directory
mkdir -p "$GLOBAL_HOOKS_DIR"

# Download the hook script to global directory
echo "Downloading hook script..."
curl -fsSL "${RAW_BASE}/hooks/${HOOK_NAME}" -o "$GLOBAL_HOOKS_DIR/pre-commit"

# Make it executable
chmod +x "$GLOBAL_HOOKS_DIR/pre-commit"

# Set global git hooks path
echo "Configuring git to use global hooks..."
git config --global core.hooksPath "$GLOBAL_HOOKS_DIR"

# Create global code_review_memory directory
echo "Setting up global code review memory files..."
mkdir -p "$GLOBAL_HOOKS_DIR/code_review_memory"
curl -fsSL "${RAW_BASE}/code_review_memory/memory_template.txt" -o "$GLOBAL_HOOKS_DIR/code_review_memory/memory_template.txt" 2>/dev/null || true

echo "✅ Global installation complete!"
echo ""
echo "Global hooks directory: $GLOBAL_HOOKS_DIR"
echo ""
echo "Next steps:"
echo "1. Install dependencies: pip install flake8"
echo "2. Install Gemini CLI: npm install -g @google/generative-ai-cli"
echo "3. Configure Gemini: gemini config set apiKey YOUR_API_KEY"
echo ""
echo "The hook will now run on every commit in ALL repositories!"
echo ""
echo "To uninstall: git config --global --unset core.hooksPath"
