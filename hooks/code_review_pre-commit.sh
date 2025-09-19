#!/usr/bin/env bash
set -euo pipefail

LOG_DIR="${HOME}/.git-hooks-code-review"
LOG_FILE="${LOG_DIR}/code_review_progress.log"
AI_STDERR_LOG="${LOG_DIR}/ai_stdder.log"

mkdir -p "$LOG_DIR" 2>/dev/null || true

truncate_log_if_needed() {
  local file="$1"
  local max_size=102400

  if [ -f "$file" ]; then
    local size
    if ! size="$(wc -c < "$file" 2>/dev/null)"; then
      size=0
    fi
    size="${size//[!0-9]/}"
    if [ -z "$size" ]; then
      size=0
    fi

    if [ "$size" -gt "$max_size" ]; then
      : > "$file"
    fi
  fi
}

log_stage() {
  local stage="$1"
  local timestamp
  timestamp="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  {
    printf '%s - %s\n' "$timestamp" "$stage"
  } >> "$LOG_FILE" 2>/dev/null || true
}

log_ai_stderr() {
  local context="$1"
  local stderr_file="$2"

  if [ -s "$stderr_file" ]; then
    local timestamp
    timestamp="$(date '+%Y-%m-%dT%H:%M:%S%z')"
    mkdir -p "$LOG_DIR" 2>/dev/null || true
    {
      printf '%s - %s\n' "$timestamp" "$context"
      cat "$stderr_file"
      printf '\n'
    } >> "$AI_STDERR_LOG" 2>/dev/null || true
  fi
}

need() { command -v "$1" >/dev/null 2>&1; }
repo_path="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
truncate_log_if_needed "$LOG_FILE"
truncate_log_if_needed "$AI_STDERR_LOG"
log_stage "Pre-commit hook triggered for repository: ${repo_path}"
diff_text="$(git diff -U100000 HEAD --no-color || true)"
log_stage "Captured diff for review (length: ${#diff_text} characters)"

run_review_async() (
  log_stage "Async review worker started"
  # Run in a subshell so we can background cleanly
  out="auto_code_review.md"
  echo "_Review running..._" > "$out"
  tmp_out="$(mktemp)"
  tmp_prompt="$(mktemp)"
  tmp_stdout="$(mktemp)"
  tmp_stderr="$(mktemp)"
  trap 'rm -f "$tmp_out" "$tmp_prompt" "$tmp_stdout" "$tmp_stderr" 2>/dev/null' EXIT

  write_ai_success() {
    local context="$1"
    cat "$tmp_stdout" > "$tmp_out"
    log_ai_stderr "$context" "$tmp_stderr"
  }

  # Capture the diff up front (no colors to keep prompt clean)

  if [ -z "$diff_text" ]; then
    log_stage "Async review: no diff detected - writing placeholder output"
    printf "_Nothing to review: no diff from HEAD._\n" > "$tmp_out"
  else
    log_stage "Async review: building review prompt"
    # Build the full prompt with the diff inlined
    cat > "$tmp_prompt" <<'PROMPT'
Act as a hyper-critical senior code reviewer. Your primary mission is to find and report errors, logical flaws, and deviations from best practices. Your feedback should be direct and focus on what needs to be fixed.

Your primary task is to generate comprehensive review feedback for the following git diff. Pay extremely close attention to detail and logical correctness. Your analysis must cover the following points for every change:
- **Error Detection:** Prioritize finding potential bugs, edge cases, and logical flaws.
- Code quality and best practices, including adherence to established patterns and conventions.
- **Logical and semantic inconsistencies**, such as incorrect data aggregation, misapplied operators, or discrepancies between intended behavior and actual implementation (as indicated by names, comments etc.).
- **Meticulous detection of typos, grammatical errors, and misspellings** within code, comments, and string literals.
- Performance concerns.
- Maintainability and readability issues.
- Missing or inadequate error handling.
- Test coverage gaps.

Analyze the diff hunks below (do not run any shell commands):

```diff
PROMPT
    printf '%s\n' "$diff_text" >> "$tmp_prompt"
    printf '```\n\n' >> "$tmp_prompt"

    cat >> "$tmp_prompt" <<'PROMPT'
Structure your report exactly as follows:

1. Read the diff carefully taking the full context into account.
2. Look at what files are in the `code_review_memory/` and get their names.
3. Consult files in the `code_review_memory/` directory for concept-specific guidelines. For example, when reviewing `.sql` files, apply the rules from `sql.md`. These guidelines take precedence over general instructions. Read only relevant files for context not all files.
4. Build and output the report as instructed and structure your detailed report as follows (not outputting text delimited by: --):

## Overview
[Brief, concise summary of all changes and your overall assessment of the codes readiness.]

---

## Change-by-Change Review

-- start of repeating structure --

### Assessment of the change: BAD, GOOD or NEUTRAL
**title:** Brief few works title of the change, e.g., 'Refactor data processing logic'\
**file:** path/to/file\
**function:** function/CTE name in the file\
**Lines:** Lines changed in the diff, e.g., '10-15'\
**Details:** If the assessment is 'BAD', provide a detailed analysis of the problem. If the assessment is 'GOOD', provide a *very brief* one-line confirmation, e.g., 'change from hard coded filtering to dynamic is good.'\
**Suggestion (if 'BAD'):** Provide a specific, actionable recommendation with a concrete minimal diff code snippet.\
**Reasoning (if 'BAD'):** Explain why the issue is a problem and why the suggested change is beneficial (e.g., \'This prevents a potential 'NullPointerException' and makes the function more robust.\').\

---

-- end of repeating structure --

*Repeat the repeating structure for each distinct change in the diff.*
**critical:** *End each line with '  ' (double space) to go down a line.*

## Potential General/Design Improvements
[High level improvements to the overall design, architecture, or approach that may not be tied to a specific line of code but could enhance the systems scalability, maintainability, or efficiency.]

---

## memory files read
[List the names of the files in `code_review_memory/` that you read for context and points used (if used). format: file_name - few word point description (if point used otherwise N/A).]

-- end of report --

## Notes
- Answer only with the final report.
- Keep explanations concise and scannable.
- Include second-order issues caused by the changes.
- Dont run any command that is not used in order to read files as needed for context.
- Remove, adjust or add sections according to the memory *.md files you need in @code_review_memory.

PROMPT

    # Run AI review: try Gemini first; on failure, try Cursor (cursor-agent)
    if need gemini; then
      log_stage "Async review: invoking Gemini CLI"
      if gemini --approval-mode "auto_edit" -m gemini-2.5-pro < "$tmp_prompt" > "$tmp_stdout" 2> "$tmp_stderr"; then
        log_stage "Async review: Gemini review completed successfully"
        write_ai_success "Gemini review"
      elif need cursor-agent; then
        log_stage "Async review: Gemini review failed - attempting Cursor CLI"
        log_ai_stderr "Gemini review stderr (failure)" "$tmp_stderr"
        if cursor-agent -f --output-format text < "$tmp_prompt" > "$tmp_stdout" 2> "$tmp_stderr"; then
          log_stage "Async review: Cursor review completed successfully"
          write_ai_success "Cursor review"
        else
          log_stage "Async review: Cursor review failed"
          printf "_Cursor review failed._\n" > "$tmp_out"
          log_ai_stderr "Cursor review stderr (failure)" "$tmp_stderr"
        fi
      else
        log_stage "Async review: Gemini review failed and Cursor CLI not found"
        printf "_Gemini review failed and no Cursor CLI found._\n" > "$tmp_out"
        log_ai_stderr "Gemini review stderr (failure)" "$tmp_stderr"
      fi
    elif need cursor-agent; then
      log_stage "Async review: invoking Cursor CLI"
      if cursor-agent -f --output-format text < "$tmp_prompt" > "$tmp_stdout" 2> "$tmp_stderr"; then
        log_stage "Async review: Cursor review completed successfully"
        write_ai_success "Cursor review"
      else
        log_stage "Async review: Cursor review failed"
        printf "_Cursor review failed._\n" > "$tmp_out"
        log_ai_stderr "Cursor review stderr (failure)" "$tmp_stderr"
      fi
    else
      log_stage "Async review: no supported AI CLI found - skipping review"
      printf "_Skipped AI review (no supported CLI found: gemini, cursor-agent)_\n" > "$tmp_out"
    fi
  fi

  {
    echo
    echo '---'
    echo '## Flake8'
    log_stage "Async review: running flake8 checks"
    if need flake8; then
      flake8 --format="- **%(path)s** (Line: %(row)d, Col: %(col)d) - \`%(code)s\`: %(text)s" || true
    else
      echo "_Skipped flake8 (flake8 not found)_"
    fi
  } >> "$tmp_out"

  log_stage "Async review: flake8 step completed"

  mv -f "$tmp_out" "$out"
  formatter=""
  for candidate in \
    "${repo_path}/scripts/code_review_formatting.py" \
    "${repo_path}/scripts/post_review_formatting" \
    "${HOME}/.git-hooks-code-review/scripts/code_review_formatting.py" \
    "${HOME}/.git-hooks-code-review/scripts/post_review_formatting"; do
    if [ -n "$formatter" ]; then
      continue
    fi
    case "$candidate" in
      *.py)
        if [ -f "$candidate" ]; then
          formatter="$candidate"
        fi
        ;;
      *)
        if [ -x "$candidate" ]; then
          formatter="$candidate"
        fi
        ;;
    esac
  done
  if [ -n "$formatter" ]; then
    log_stage "Async review: running code review formatter (${formatter})"
    if [ "$(basename "$formatter")" = "code_review_formatting.py" ]; then
      local formatter_attempted=0
      local formatter_succeeded=0
      local python_success_cmd=()
      for python_candidate in "python3" "python" "py -3" "py"; do
        IFS=' ' read -r -a candidate_parts <<< "$python_candidate"
        if ! need "${candidate_parts[0]}"; then
          continue
        fi
        formatter_attempted=1
        log_stage "Async review: trying Python interpreter (${candidate_parts[*]})"
        if "${candidate_parts[@]}" "$formatter" "$out" >/dev/null 2>>"$tmp_stderr"; then
          formatter_succeeded=1
          python_success_cmd=("${candidate_parts[@]}")
          break
        else
          local exit_code=$?
          log_stage "Async review: interpreter (${candidate_parts[*]}) failed with exit code ${exit_code}"
        fi
      done
      if [ "$formatter_succeeded" -eq 1 ]; then
        log_stage "Async review: formatter completed successfully using (${python_success_cmd[*]})"
      elif [ "$formatter_attempted" -eq 0 ]; then
        log_stage "Async review: no Python interpreter found for formatter"
      else
        log_stage "Async review: formatter encountered an error"
      fi
    else
      if "$formatter" "$out" >/dev/null 2>>"$tmp_stderr"; then
        log_stage "Async review: formatter completed successfully"
      else
        log_stage "Async review: formatter encountered an error"
      fi
    fi
  else
    log_stage "Async review: code review formatter not found"
  fi
  log_stage "Async review: review output updated"
  log_stage "Async review worker finished"
)

# Fire-and-forget: do the heavy work in the background so the commit proceeds immediately
(run_review_async) >/dev/null 2>&1 &
review_pid=$!
log_stage "Background review process started (PID: ${review_pid})"

log_stage "Pre-commit hook completed; review continues in background"
exit 0
