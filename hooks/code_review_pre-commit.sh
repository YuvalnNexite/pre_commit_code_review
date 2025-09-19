#!/usr/bin/env bash
set -euo pipefail

need() { command -v "$1" >/dev/null 2>&1; }
diff_text="$(git diff -U100000 HEAD --no-color || true)"

run_review_async() (
  # Run in a subshell so we can background cleanly
  out="auto_code_review.md"
  echo "_Review running..._" > "$out"
  tmp_out="$(mktemp)"
  tmp_prompt="$(mktemp)"
  tmp_stdout="$(mktemp)"
  tmp_stderr="$(mktemp)"
  trap 'rm -f "$tmp_out" "$tmp_prompt" "$tmp_stdout" "$tmp_stderr" 2>/dev/null' EXIT

  append_ai_stderr() {
    if [ -s "$tmp_stderr" ]; then
      {
        echo
        echo '---'
        echo '## AI stderr'
        cat "$tmp_stderr"
      } >> "$tmp_out"
    fi
  }

  write_ai_success() {
    cat "$tmp_stdout" > "$tmp_out"
    append_ai_stderr
  }

  # Capture the diff up front (no colors to keep prompt clean)

  if [ -z "$diff_text" ]; then
    printf "_Nothing to review: no diff from HEAD._\n" > "$tmp_out"
  else
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
      if gemini --approval-mode "auto_edit" -m gemini-2.5-pro < "$tmp_prompt" > "$tmp_stdout" 2> "$tmp_stderr"; then
        write_ai_success
      elif need cursor-agent; then
        if cursor-agent -f --output-format text < "$tmp_prompt" > "$tmp_stdout" 2> "$tmp_stderr"; then
          write_ai_success
        else
          printf "_Cursor review failed._\n" > "$tmp_out"
          append_ai_stderr
        fi
      else
        printf "_Gemini review failed and no Cursor CLI found._\n" > "$tmp_out"
        append_ai_stderr
      fi
    elif need cursor-agent; then
      if cursor-agent -f --output-format text < "$tmp_prompt" > "$tmp_stdout" 2> "$tmp_stderr"; then
        write_ai_success
      else
        printf "_Cursor review failed._\n" > "$tmp_out"
        append_ai_stderr
      fi
    else
      printf "_Skipped AI review (no supported CLI found: gemini, cursor-agent)_\n" > "$tmp_out"
    fi
  fi

  {
    echo
    echo '---'
    echo '## Flake8'
    if need flake8; then
      flake8 --format="- **%(path)s** (Line: %(row)d, Col: %(col)d) - \`%(code)s\`: %(text)s" || true
    else
      echo "_Skipped flake8 (flake8 not found)_"
    fi
  } >> "$tmp_out"

  escape_for_json() {
    local input="$1"
    input="${input//\\/\\\\}"
    input="${input//\"/\\\"}"
    printf '%s' "$input"
  }

  urlencode() {
    local string="$1"
    local encoded=""
    local pos char ascii
    for ((pos = 0; pos < ${#string}; pos++)); do
      char="${string:pos:1}"
      case "$char" in
        [a-zA-Z0-9.~_-]) encoded+="$char" ;;
        ' ') encoded+="%20" ;;
        *) printf -v ascii '%%%02X' "'$char"; encoded+="$ascii" ;;
      esac
    done
    printf '%s' "$encoded"
  }

  python_cmd="python3"
  if ! need python3; then
    if need python; then
      python_cmd="python"
    fi
  fi

  helper_script=""
  if [ -f "scripts/interactive_review_helper.py" ]; then
    helper_script="scripts/interactive_review_helper.py"
  elif [ -f "$HOME/.git-hooks-code-review/scripts/interactive_review_helper.py" ]; then
    helper_script="$HOME/.git-hooks-code-review/scripts/interactive_review_helper.py"
  fi

  if [ -n "$helper_script" ]; then
    helper_command="$python_cmd \"$helper_script\""
  else
    helper_command="$python_cmd scripts/interactive_review_helper.py"
  fi

  helper_command_json="$(escape_for_json "$helper_command")"
  vscode_payload="{\"text\":\"${helper_command_json}\\n\"}"
  vscode_uri="command:workbench.action.terminal.sendSequence?$(urlencode "$vscode_payload")"

  obsidian_template="$(git config --get codeReview.obsidianUriTemplate 2>/dev/null || true)"
  obsidian_link=""
  if [ -n "$obsidian_template" ]; then
    encoded_obsidian_command="$(urlencode "$helper_command")"
    obsidian_link="${obsidian_template//\{command\}/$encoded_obsidian_command}"
    obsidian_link="${obsidian_link//\{command_raw\}/$helper_command}"
  fi

  add_interactive_hint() {
    local target tmp_header
    target="$1"
    tmp_header="$(mktemp)"
    {
      cat <<HINT
<div align="right">
  <a href="$vscode_uri" style="display:inline-block;padding:6px 12px;border-radius:6px;background:#0366d6;color:#fff;text-decoration:none;font-weight:600;">Launch interactive fixer (VS Code)</a>
</div>

> [!TIP]
> Run \`$helper_command\` to review BAD findings interactively.
HINT
      if [ -n "$obsidian_link" ]; then
        printf '> Obsidian: [Launch interactive fixer](%s)\n' "$obsidian_link"
      fi
      printf '\n'
      cat "$target"
    } >"$tmp_header"
    mv -f "$tmp_header" "$target"
  }

  add_interactive_hint "$tmp_out"
  mv -f "$tmp_out" "$out"
)

# Fire-and-forget: do the heavy work in the background so the commit proceeds immediately
(run_review_async) >/dev/null 2>&1 &

exit 0
