# Pre-Commit Code Review Hook

Automated code review using Gemini AI that runs before each commit.

## Quick Installation

### One-line installation
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
## Dependencies
### Python linting
pip install flake8

### Gemini AI (requires API key)
```bash
npm install -g @google/generative-ai-cli
```
gemini config set apiKey GEMINI_API_KEY = your_api_key_here

### cursor cli (optional)
for macOS, Linux, Windows (WSL):
```bash
curl https://cursor.com/install -fsS | bash
```
