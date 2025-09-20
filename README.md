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

### Gemini Cli
```bash
npm install -g @google/generative-ai-cli
```
Make sure the Gemini cli works independently and set up authentication/API if needed.
for a quick check run:
```
gemini -p "hey"
```
For more information about the gemini cli: `https://github.com/google-gemini/gemini-cli`

### Cursor Cli (optional)
for macOS/Linux:
```bash
curl https://cursor.com/install -fsS | bash
```


## Review Viewer

An optional Flask web application is available to inspect `auto_code_review.md` files with live refresh support.

### Requirements

Install Flask (and its dependencies) into your Python environment:

```bash
pip install flask
```

No additional packages are required—the server polls the filesystem for changes.

### Running the server

```bash
python scripts/review_viewer/app.py
```

By default the viewer listens on `http://0.0.0.0:5000`. You can customise the host/port using the environment variables `REVIEW_VIEWER_HOST` and `REVIEW_VIEWER_PORT` (or `PORT`).

Open `http://localhost:5000/` in your browser and select the repository directory that contains the `auto_code_review.md` you want to inspect. The UI renders the Markdown locally—including `diff` code blocks with inline highlighting—and automatically refreshes whenever the file changes. Live updates are delivered over Server-Sent Events, so the page stays in sync without manual reloads.

## Memory Usage
To use the persistent memory feature put a code_review_memory directory in the project root and follow the template to create consept.md memory files.
The AI will consult the memory file when he finds the name of the file related to the changed text.
examples:
if you change a .py file -> the AI will read python.md
if you change a file that uses a library called numpy -> it will read numpy.md
if you change a file in a directory called reports -> it will read reports.md

## Explanation:
This script installs a pre-commit hook that uses AI to review code before each commit. It requires Gemini cli or cursor cli for the reviews and flake8 for linting.
The hook script is copied to the `$HOME.git-hooks-code-review` directory and made executable.
A memory directory is created to improve future reviews and give the model domain knowledge.
