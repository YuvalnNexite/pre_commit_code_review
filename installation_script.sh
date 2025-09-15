#!/usr/bin/env bash
# install.sh
set -euo pipefail

# Get the current repository URL dynamically
REPO_URL=$(git config --get remote.origin.url 2>/dev/null || echo "")
if [[ -z "$REPO_URL" ]]; then
    echo "Error: Could not determine repository URL. Make sure you're in a git repository with an origin remote."
    exit 1
fi

# Convert SSH URL to HTTPS if needed
if [[ "$REPO_URL" =~ ^git@github\.com:(.+)\.git$ ]]; then
    REPO_URL="https://github.com/${BASH_REMATCH[1]}.git"
fi

HOOK_NAME="code_review_pre-commit.sh"
GLOBAL_HOOKS_DIR="$HOME/.git-hooks"

echo "Installing pre-commit code review hook globally..."
echo "Repository: $REPO_URL"

# Create global hooks directory
mkdir -p "$GLOBAL_HOOKS_DIR"

# Download the hook script to global directory
echo "Downloading hook script..."
curl -fsSL "${REPO_URL}/raw/main/hooks/${HOOK_NAME}" -o "$GLOBAL_HOOKS_DIR/pre-commit"

# Make it executable
chmod +x "$GLOBAL_HOOKS_DIR/pre-commit"

# Set global git hooks path
echo "Configuring git to use global hooks..."
git config --global core.hooksPath "$GLOBAL_HOOKS_DIR"

# Create global code_review_memory directory
echo "Setting up global code review memory files..."
mkdir -p "$GLOBAL_HOOKS_DIR/code_review_memory"
curl -fsSL "${REPO_URL}/raw/main/code_review_memory/sql.md" -o "$GLOBAL_HOOKS_DIR/code_review_memory/sql.md" 2>/dev/null || true

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
