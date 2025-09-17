# Pre-Commit Code Review Hook

Automated code review using Gemini AI that runs before each commit.

## Quick Installation

### One-line installation for macOS, Linux, Windows(Git Bash)
```bash
curl -fsSL https://raw.githubusercontent.com/YuvalnNexite/pre_commit_code_review/main/install.sh | bash
```

### Manual installation
```bash
git clone https://github.com/YuvalnNexite/pre_commit_code_review.git
cp pre_commit_code_review/hooks/code_review_pre-commit.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
mkdir -p code_review_memory
cp <root>/code_review_memory/* code_review_memory/
```

### Uninstallation
```bash
curl -fsSL https://raw.githubusercontent.com/YuvalnNexite/pre_commit_code_review/main/uninstall.sh | bash
```
or, from a local clone:
```bash
./uninstall.sh
```
## Dependencies
### Python linting
pip install flake8

### Gemini AI (requires API key)
```bash
npm install -g @google/generative-ai-cli
```
gemini config set apiKey GEMINI_API_KEY = your_api_key

### cursor cli (optional)
for macOS/Linux:
```bash
curl https://cursor.com/install -fsS | bash
```

## Memory Usage
To use the persistent memory feature put a code_review_memory directory in the project root and follow the template to create consept.md memory files.
The AI will consult the memory file when he finds the name of the file related to the changed text.
examples:
if you change a .py file -> the AI will read python.md
if you change a file that uses a library called numpy -> it will read numpy.md
if you change a file in a directory called reports -> it will read reports.md

## Explanation:
This script installs a pre-commit hook that uses AI to review code before each commit. It requires Gemini cli or cursor cli for the reviews and flake8 for linting.
The hook script is copied to the `HOME.git-hooks-code-review` directory and made executable.
A memory directory is created to improve future reviews and give the model domain knowledge.
