#!/usr/bin/env python3
"""Interactive tooling to walk through AI code review findings."""

from __future__ import annotations

import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

try:  # pragma: no cover - optional enhancement for user experience
    import readline  # type: ignore  # noqa: F401  pylint: disable=unused-import
except Exception:  # pragma: no cover - pylint: disable=broad-except
    readline = None  # noqa: F841  pylint: disable=invalid-name


@dataclass
class Finding:
    """Structured information about a single BAD change assessment."""

    identifier: str
    title: str
    file: str
    lines: str
    suggestion: str
    raw_block: str
    details: str = ""
    reasoning: str = ""
    function: str = ""


def resolve_command(command: str) -> Optional[str]:
    """Return the absolute command path if available on PATH."""

    return shutil.which(command)


def build_command(binary: str, *args: str) -> Optional[List[str]]:
    """Return an invocation list that works on the current platform."""

    resolved = resolve_command(binary)
    if not resolved:
        return None

    if os.name == "nt":
        suffix = Path(resolved).suffix.lower()
        if suffix in {".cmd", ".bat"}:
            comspec = os.environ.get("COMSPEC", "cmd.exe")
            return [comspec, "/c", resolved, *args]

    return [resolved, *args]


def find_repo_root() -> Path:
    """Locate the git repository root or default to the project directory."""

    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return Path(__file__).resolve().parents[1]

    return Path(result.stdout.strip())


def find_latest_review(repo_root: Path) -> Optional[Path]:
    """Return the newest auto_code_review.md file under the repository."""

    direct = repo_root / "auto_code_review.md"
    if direct.exists():
        return direct

    candidates: List[Path] = []
    for path in repo_root.rglob("auto_code_review.md"):
        if any(part.startswith(".") for part in path.parts):
            # Skip git internals or other hidden directories.
            continue
        candidates.append(path)

    if not candidates:
        return None

    return max(candidates, key=lambda p: p.stat().st_mtime)


def canonicalize_label(label: str) -> Optional[str]:
    """Map a markdown field label to an internal attribute name."""

    normalized = label.lower().strip()
    normalized = normalized.replace("(if 'bad')", "")
    normalized = normalized.replace('(if "bad")', "")
    normalized = normalized.replace("(if bad)", "")
    normalized = normalized.rstrip(":").strip()

    aliases = {
        "title": "title",
        "file": "file",
        "function": "function",
        "lines": "lines",
        "line": "lines",
        "details": "details",
        "suggestion": "suggestion",
        "reasoning": "reasoning",
    }

    return aliases.get(normalized)


def clean_value(text: str) -> str:
    """Trim review formatting artefacts while preserving indentation."""

    cleaned = text.rstrip()
    if cleaned.endswith("\\"):
        cleaned = cleaned[:-1].rstrip()
    return cleaned


def parse_fields(block_body: str) -> Dict[str, str]:
    """Parse the markdown field/value pairs from a BAD review block."""

    fields: Dict[str, List[str]] = {}
    current_field: Optional[str] = None

    for raw_line in block_body.splitlines():
        stripped = raw_line.strip()

        if not stripped:
            if current_field:
                fields.setdefault(current_field, []).append("")
            continue

        if stripped.startswith("---") or stripped.startswith("### "):
            current_field = None
            continue

        if stripped.startswith("**"):
            closing = stripped.find("**", 2)
            if closing != -1:
                label = stripped[2:closing].strip()
                remainder = stripped[closing + 2 :].lstrip(": ")
                field_name = canonicalize_label(label)
                if field_name:
                    current_field = field_name
                    fields.setdefault(current_field, [])
                    if remainder:
                        fields[current_field].append(clean_value(remainder))
                    continue

        if current_field:
            fields.setdefault(current_field, []).append(clean_value(raw_line))

    return {name: "\n".join(value).strip("\n") for name, value in fields.items()}


def parse_bad_findings(review_text: str) -> List[Finding]:
    """Extract BAD assessments from the Change-by-Change section."""

    normalized = review_text.replace("\r\n", "\n")
    section_match = re.search(
        r"## Change-by-Change Review(?P<section>.*?)(?:\n## |\Z)",
        normalized,
        flags=re.S,
    )
    if not section_match:
        return []

    section = section_match.group("section")

    pattern = re.compile(
        r"### Assessment of the change:\s*(?P<grade>[A-Z]+).*?\n(?P<body>.*?)(?=\n### Assessment|\n## |\Z)",
        re.S,
    )

    findings: List[Finding] = []
    for match in pattern.finditer(section):
        grade = match.group("grade").strip().upper()
        if grade != "BAD":
            continue
        body = match.group("body")
        fields = parse_fields(body)
        raw_block = match.group(0).strip()
        identifier = sha256(raw_block.encode("utf-8")).hexdigest()[:16]
        findings.append(
            Finding(
                identifier=identifier,
                title=fields.get("title", ""),
                file=fields.get("file", ""),
                lines=fields.get("lines", ""),
                suggestion=fields.get("suggestion", ""),
                raw_block=raw_block,
                details=fields.get("details", ""),
                reasoning=fields.get("reasoning", ""),
                function=fields.get("function", ""),
            )
        )

    return findings


def load_state(state_path: Path) -> Dict[str, object]:
    """Load persistent acknowledgement state from disk."""

    if not state_path.exists():
        return {}

    try:
        with state_path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (json.JSONDecodeError, OSError):
        return {}


def save_state(state_path: Path, state: Dict[str, object]) -> None:
    """Persist acknowledgement state to disk."""

    tmp_path = state_path.with_suffix(".tmp")
    with tmp_path.open("w", encoding="utf-8") as handle:
        json.dump(state, handle, indent=2, sort_keys=True)
        handle.write("\n")
    tmp_path.replace(state_path)


def ensure_state_for_findings(
    state: Dict[str, object], review_hash: str, findings: Iterable[Finding]
) -> Dict[str, object]:
    """Normalize the state structure for the current review file."""

    finding_ids = [finding.identifier for finding in findings]

    if state.get("review_hash") != review_hash:
        state = {"review_hash": review_hash, "findings": {}, "current_index": 0}

    findings_state: Dict[str, Dict[str, object]] = {
        key: value for key, value in state.get("findings", {}).items() if key in finding_ids
    }

    for finding in findings:
        findings_state.setdefault(
            finding.identifier,
            {
                "status": "pending",
                "last_ai_output": "",
                "last_patch": "",
                "last_patch_source": "",
            },
        )

    state["findings"] = findings_state
    if "current_index" not in state:
        state["current_index"] = 0

    return state


def find_first_pending_index(findings: List[Finding], state: Dict[str, object]) -> int:
    """Return the index of the first finding without an acknowledgement."""

    findings_state: Dict[str, Dict[str, object]] = state.get("findings", {})  # type: ignore[assignment]
    for index, finding in enumerate(findings):
        status = findings_state.get(finding.identifier, {}).get("status", "pending")
        if status not in {"acknowledged", "fixed"}:
            return index
    return len(findings)


def parse_line_span(line_text: str) -> Tuple[Optional[int], Optional[int]]:
    """Parse the "Lines" field into numeric start and end."""

    if not line_text:
        return None, None

    match = re.match(r"(\d+)(?:\s*-\s*(\d+))?", line_text)
    if not match:
        return None, None

    start = int(match.group(1))
    end = int(match.group(2)) if match.group(2) else start
    return start, end


def render_file_snippet(
    file_path: Path, start_line: Optional[int], end_line: Optional[int], context: int = 8
) -> Optional[str]:
    """Return a numbered excerpt of the target file for the fix prompt."""

    if not file_path.exists() or not file_path.is_file():
        return None

    try:
        text = file_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None

    lines = text.splitlines()
    if not lines:
        return ""

    total = len(lines)
    if start_line is None and end_line is None:
        snippet_start = 1
        snippet_end = min(total, 40)
    else:
        start = start_line or end_line or 1
        end = end_line or start_line or start
        snippet_start = max(1, start - context)
        snippet_end = min(total, end + context)

    numbered = [f"{idx:>5}: {lines[idx - 1]}" for idx in range(snippet_start, snippet_end + 1)]
    return "\n".join(numbered)


def build_fix_prompt(repo_root: Path, finding: Finding) -> str:
    """Create the instruction prompt for the AI fix command."""

    file_path = (repo_root / finding.file).resolve() if finding.file else None
    start_line, end_line = parse_line_span(finding.lines)
    snippet = render_file_snippet(file_path, start_line, end_line) if file_path else None

    suggestion = finding.suggestion or "(The reviewer did not provide an explicit suggestion.)"
    details_lines = []
    if finding.details:
        details_lines.append(f"Details: {finding.details}")
    if finding.reasoning:
        details_lines.append(f"Reasoning: {finding.reasoning}")

    prompt_parts = [
        "You are an AI code assistant helping to address a code review finding.",
        "Generate a unified diff patch that resolves the reviewer concern.",
        "The patch must apply with `git apply` without additional context.",
        "Do not include commentary outside of a single ```diff fenced block.",
        "",
        f"Repository root: {repo_root}",
        f"Target file: {finding.file or 'unknown'}",
        f"Title: {finding.title or 'n/a'}",
    ]

    if details_lines:
        prompt_parts.append("\n".join(details_lines))

    prompt_parts.append(f"Suggestion from reviewer:\n{suggestion}")
    prompt_parts.append("Full review block:")
    prompt_parts.append(finding.raw_block)

    if snippet is not None:
        prompt_parts.append(
            "Current file excerpt (with line numbers):\n```text\n" + snippet + "\n```"
        )
    else:
        prompt_parts.append(
            "The file contents could not be read automatically. Base your patch on the review context."
        )

    prompt_parts.append(
        "Respond with ONLY one markdown block containing the diff for the required changes."
    )

    return "\n\n".join(prompt_parts)


def run_ai_fix(repo_root: Path, finding: Finding) -> Optional[str]:
    """Execute Gemini or Cursor CLI to request a fix for the current finding."""

    prompt = build_fix_prompt(repo_root, finding)

    tool_name: Optional[str] = None
    command: Optional[List[str]] = None

    gemini_command = build_command(
        "gemini", "--approval-mode", "auto_edit", "-m", "gemini-2.5-pro"
    )
    if gemini_command:
        tool_name = "gemini"
        command = gemini_command
    else:
        cursor_command = build_command(
            "cursor-agent", "-f", "--output-format", "text"
        )
        if cursor_command:
            tool_name = "cursor-agent"
            command = cursor_command

    if not command or not tool_name:
        print("No supported AI CLI (gemini or cursor-agent) found on PATH.")
        return None

    try:
        process = subprocess.run(
            command,
            input=prompt,
            text=True,
            capture_output=True,
            cwd=repo_root,
            check=False,
        )
    except OSError as exc:
        print(f"Failed to execute {command[0]}: {exc}")
        return None

    combined_output = process.stdout or ""
    if process.stderr:
        sys.stderr.write(process.stderr)
        sys.stderr.flush()
        if combined_output:
            combined_output += "\n"
        combined_output += process.stderr

    if process.returncode != 0:
        print(f"{tool_name} exited with status {process.returncode}.")
        if not combined_output:
            return None

    output = process.stdout.strip()
    if not output:
        print("AI command returned no output.")
        if combined_output:
            show_text_in_new_terminal(combined_output)
        return None

    if show_text_in_new_terminal(combined_output):
        print("Opened AI response in a separate terminal window.")
    else:
        print("AI response:")
        print(combined_output.strip() or output)

    return output


def extract_patch(ai_output: str) -> Optional[str]:
    """Extract a diff block from the AI response."""

    pattern = re.compile(r"```(?:diff|patch|suggestion)?\n(.*?)```", re.S)
    match = pattern.search(ai_output)
    if not match:
        return None

    patch = match.group(1).strip()
    if not patch.endswith("\n"):
        patch += "\n"
    return patch



def prepare_patch_for_application(patch: str) -> Optional[str]:
    """Validate and normalize a diff before piping it to git apply."""

    normalized = patch.replace("\r\n", "\n")
    normalized = normalized.strip("\n")
    if not normalized.strip():
        return None
    if not normalized.endswith("\n"):
        normalized += "\n"
    if not re.search(r"^--- ", normalized, re.MULTILINE):
        return None
    if not re.search(r"^\+\+\+ ", normalized, re.MULTILINE):
        return None
    if not re.search(r"^@@ ", normalized, re.MULTILINE):
        return None
    return normalized

def powershell_quote(text: str) -> str:
    """Quote a string for use in PowerShell single-quoted literals."""

    return "'" + text.replace("'", "''") + "'"


def show_text_in_new_terminal(text: str) -> bool:
    """Display the provided text in a freshly opened terminal window."""

    cleaned = text.strip()
    if not cleaned:
        return False

    output_path: Optional[Path] = None
    script_path: Optional[Path] = None

    try:
        with tempfile.NamedTemporaryFile(
            "w", delete=False, encoding="utf-8", suffix=".txt"
        ) as handle:
            handle.write(cleaned)
            output_path = Path(handle.name)
    except OSError as exc:
        print(f"Failed to prepare output viewer: {exc}")
        return False

    try:
        if os.name == "nt":
            powershell = (
                resolve_command("powershell.exe")
                or resolve_command("pwsh")
                or resolve_command("powershell")
            )
            if not powershell:
                raise RuntimeError("PowerShell was not found on PATH.")

            script_path = output_path.with_suffix(".ps1")
            script_content = textwrap.dedent(
                f"""
                $ErrorActionPreference = 'SilentlyContinue'
                [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
                $outputPath = {powershell_quote(str(output_path))}
                if (Test-Path -LiteralPath $outputPath) {{
                    Get-Content -Raw -Encoding UTF8 -LiteralPath $outputPath
                }} else {{
                    Write-Host 'AI output file not found.'
                }}
                Write-Host ''
                Write-Host 'Press Enter to close this window...'
                [void][System.Console]::ReadLine()
                Remove-Item -ErrorAction SilentlyContinue -LiteralPath $outputPath
                Remove-Item -ErrorAction SilentlyContinue -LiteralPath $MyInvocation.MyCommand.Path
                """
            ).strip()
            script_path.write_text(script_content + "\n", encoding="utf-8")
            creationflags = getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
            subprocess.Popen(  # pylint: disable=consider-using-with
                [powershell, "-ExecutionPolicy", "Bypass", "-File", str(script_path)],
                creationflags=creationflags,
            )
            return True

        script_path = output_path.with_suffix(".sh")
        output_quoted = shlex.quote(str(output_path))
        script_content = textwrap.dedent(
            f"""
            #!/usr/bin/env bash
            set -e
            if [ -f {output_quoted} ]; then
                cat {output_quoted}
            else
                echo "AI output file not found."
            fi
            echo
            read -r -p "Press Enter to close this window..." _
            rm -f {output_quoted}
            rm -f -- "$0"
            """
        ).strip()
        script_path.write_text(script_content + "\n", encoding="utf-8")
        script_path.chmod(0o700)

        launched = False

        if sys.platform == "darwin":
            osa_command = (
                "tell application \"Terminal\"\n"
                "activate\n"
                f"do script \"bash {shlex.quote(str(script_path))}\"\n"
                "end tell"
            )
            try:
                subprocess.Popen(["osascript", "-e", osa_command])
                launched = True
            except OSError:
                launched = False

        if not launched:
            terminal_candidates = [
                ("x-terminal-emulator", "-e"),
                ("gnome-terminal", "--"),
                ("konsole", "-e"),
                ("xfce4-terminal", "-e"),
                ("mate-terminal", "-e"),
                ("alacritty", "-e"),
                ("kitty", "-e"),
                ("terminator", "-e"),
                ("tilix", "-e"),
                ("xterm", "-e"),
            ]
            for binary, option in terminal_candidates:
                terminal = resolve_command(binary)
                if not terminal:
                    continue
                cmd = [terminal, option]
                if option == "--":
                    cmd.extend(["bash", str(script_path)])
                else:
                    cmd.extend(["bash", str(script_path)])
                try:
                    subprocess.Popen(cmd)
                    launched = True
                    break
                except OSError:
                    continue

        if not launched:
            raise RuntimeError("No supported terminal emulator found.")

        return True
    except Exception as exc:  # pylint: disable=broad-except
        for path in (output_path, script_path):
            if path is None:
                continue
            try:
                path.unlink(missing_ok=True)  # type: ignore[arg-type]
            except Exception:  # pylint: disable=broad-except
                pass
        print(
            f"Could not open a new terminal window ({exc}). Showing output inline."
        )
        return False



def apply_patch(repo_root: Path, patch: str) -> bool:
    """Apply a git patch after confirmation."""

    prepared = prepare_patch_for_application(patch)
    if not prepared:
        print("The provided patch is not a valid unified diff.")
        return False

    try:
        process = subprocess.run(
            ["git", "apply", "-"],
            input=prepared,
            text=True,
            capture_output=True,
            cwd=repo_root,
            check=False,
        )
    except OSError as exc:
        print(f"Failed to run git apply: {exc}")
        return False

    if process.returncode != 0:
        if process.stdout:
            print(process.stdout)
        if process.stderr:
            sys.stderr.write(process.stderr)
            sys.stderr.flush()
        print("git apply failed.")
        return False

    if process.stdout:
        print(process.stdout)
    print("Patch applied successfully.")
    return True


def open_in_editor(repo_root: Path, finding: Finding) -> None:
    """Open the referenced file in the user's configured editor."""

    editor = os.environ.get("EDITOR")
    if not editor:
        print("$EDITOR is not set; cannot open the file automatically.")
        return

    if not finding.file:
        print("The review did not specify a file path.")
        return

    file_path = repo_root / finding.file
    if not file_path.exists():
        print(f"File '{finding.file}' was not found in the repository.")
        return

    start_line, end_line = parse_line_span(finding.lines)
    line_for_jump = start_line or end_line

    editor_parts = shlex.split(editor)
    program = Path(editor_parts[0]).name.lower()

    args: List[str]
    if program in {"vim", "nvim", "vi", "hx"} and line_for_jump:
        args = editor_parts + [f"+{line_for_jump}", str(file_path)]
    elif program == "nano" and line_for_jump:
        args = editor_parts + [f"+{line_for_jump}", str(file_path)]
    elif program in {"code", "code-insiders"} and line_for_jump:
        args = editor_parts + ["--goto", f"{file_path}:{line_for_jump}"]
    elif program in {"subl", "sublime_text"} and line_for_jump:
        args = editor_parts + [f"{file_path}:{line_for_jump}"]
    else:
        args = editor_parts + [str(file_path)]

    try:
        subprocess.run(args, cwd=repo_root, check=False)
    except OSError as exc:
        print(f"Failed to launch editor '{editor_parts[0]}': {exc}")


def display_finding(index: int, total: int, finding: Finding, status: str) -> None:
    """Print a summary of the current finding to the console."""

    header = f"[{index + 1}/{total}] {finding.title or '(untitled finding)'}"
    print("=" * len(header))
    print(header)
    print("=" * len(header))
    print(f"File: {finding.file or 'n/a'}")
    print(f"Lines: {finding.lines or 'n/a'}")
    if finding.function:
        print(f"Function: {finding.function}")
    print(f"Status: {status}")
    if finding.details:
        print("Details:")
        print(textwrap.indent(finding.details, "  "))
    print("Suggestion:")
    if finding.suggestion:
        print(textwrap.indent(finding.suggestion, "  "))
    else:
        print("  (No suggestion provided.)")
    print()


def interactive_loop(repo_root: Path, findings: List[Finding], state: Dict[str, object]) -> None:
    """Run the readline-driven review walkthrough."""

    findings_state: Dict[str, Dict[str, object]] = state.get("findings", {})  # type: ignore[assignment]
    index = min(state.get("current_index", find_first_pending_index(findings, state)), len(findings))  # type: ignore[arg-type]

    if index >= len(findings):
        index = find_first_pending_index(findings, state)

    total = len(findings)

    while 0 <= index < total:
        finding = findings[index]
        entry = findings_state.get(finding.identifier, {})
        status = entry.get("status", "pending")
        display_finding(index, total, finding, status)

        command = input("Command [n=next, o=open, f=fix, a=apply, p=prev, q=quit, ?=help]: ").strip().lower()
        if not command:
            command = "n"

        if command in {"?", "help"}:
            print(
                "Commands:\n"
                "  n / next    Mark as acknowledged and move to the next finding.\n"
                "  o / open    Open the file in $EDITOR at the referenced location.\n"
                "  f / fix     Ask gemini or cursor-agent for a patch (opens in a new terminal).\n"
                "  a / apply   Apply the stored patch or the review suggestion diff.\n"
                "  p / prev    Revisit the previous finding.\n"
                "  q / quit    Exit the reviewer.\n"
            )
            continue

        if command in {"q", "quit"}:
            break

        if command in {"p", "prev"}:
            index = max(0, index - 1)
            state["current_index"] = index
            save_state(repo_root / "auto_code_review_state.json", state)
            continue

        if command in {"o", "open"}:
            open_in_editor(repo_root, finding)
            continue

        if command in {"f", "fix"}:
            ai_output = run_ai_fix(repo_root, finding)
            if ai_output:
                patch = extract_patch(ai_output)
                entry["last_ai_output"] = ai_output
                if patch:
                    entry["last_patch"] = patch
                    entry["last_patch_source"] = "ai"
                    print("Stored diff for later application (use 'a' to apply).")
                else:
                    entry["last_patch"] = ""
                    entry["last_patch_source"] = ""
                    print("No diff block detected in AI output.")
            findings_state[finding.identifier] = entry
            save_state(repo_root / "auto_code_review_state.json", state)
            continue

        if command in {"a", "apply"}:
            patch = entry.get("last_patch") or ""
            patch_source = entry.get("last_patch_source") or ""
            suggestion_issue = ""
            prepared_patch = prepare_patch_for_application(patch) if patch else None
            if prepared_patch:
                patch = prepared_patch
            elif patch:
                print(
                    "Stored patch could not be prepared for application and will be discarded."
                )
                patch = ""
                patch_source = ""
                entry["last_patch"] = ""
                entry["last_patch_source"] = ""
                findings_state[finding.identifier] = entry
                save_state(repo_root / "auto_code_review_state.json", state)

            if not patch:
                if finding.suggestion:
                    suggestion_patch = extract_patch(finding.suggestion)
                    if suggestion_patch:
                        prepared_suggestion = prepare_patch_for_application(
                            suggestion_patch
                        )
                        if prepared_suggestion:
                            patch = prepared_suggestion
                            patch_source = "suggestion"
                            entry["last_patch"] = patch
                            entry["last_patch_source"] = patch_source
                            findings_state[finding.identifier] = entry
                            save_state(repo_root / "auto_code_review_state.json", state)
                        else:
                            suggestion_issue = (
                                "The review suggestion includes a diff but it could not be prepared "
                                "for application."
                            )
                    else:
                        suggestion_issue = (
                            "The review suggestion did not include a diff to apply automatically."
                        )
                else:
                    suggestion_issue = "The review suggestion did not contain a diff."

            if not patch:
                if suggestion_issue:
                    print(suggestion_issue)
                response = input(
                    "No usable diff is available. Generate an AI fix now? [y/N]: "
                ).strip().lower()
                if response not in {"y", "yes"}:
                    print("No patch available to apply.")
                    continue
                ai_output = run_ai_fix(repo_root, finding)
                if not ai_output:
                    print("AI fix failed to produce output.")
                    continue
                entry["last_ai_output"] = ai_output
                ai_patch = extract_patch(ai_output)
                if not ai_patch:
                    print("AI fix did not return a diff block.")
                    entry["last_patch"] = ""
                    entry["last_patch_source"] = ""
                    findings_state[finding.identifier] = entry
                    save_state(repo_root / "auto_code_review_state.json", state)
                    continue
                prepared_ai_patch = prepare_patch_for_application(ai_patch)
                if not prepared_ai_patch:
                    print(
                        "AI fix returned a diff that could not be prepared for application."
                    )
                    entry["last_patch"] = ""
                    entry["last_patch_source"] = ""
                    findings_state[finding.identifier] = entry
                    save_state(repo_root / "auto_code_review_state.json", state)
                    continue
                patch = prepared_ai_patch
                patch_source = "ai"
                entry["last_patch"] = patch
                entry["last_patch_source"] = patch_source
                findings_state[finding.identifier] = entry
                save_state(repo_root / "auto_code_review_state.json", state)
                print("Stored AI-generated diff for review.")

            if not patch:
                print("No patch available to apply.")
                continue

            label_map = {
                "suggestion": "review suggestion",
                "ai": "AI-generated diff",
            }
            source_label = label_map.get(patch_source, "stored diff")
            print(f"Patch preview ({source_label}):\n")
            print(patch)
            confirm = input("Apply this patch? [y/N]: ").strip().lower()
            if confirm != "y":
                print("Patch application cancelled.")
                continue
            if apply_patch(repo_root, patch):
                entry["status"] = "fixed"
                entry["last_patch_source"] = patch_source
                findings_state[finding.identifier] = entry
                index += 1
            state["current_index"] = index
            save_state(repo_root / "auto_code_review_state.json", state)
            continue

        if command in {"n", "next"}:
            entry["status"] = "acknowledged"
            findings_state[finding.identifier] = entry
            index += 1
            state["current_index"] = index
            save_state(repo_root / "auto_code_review_state.json", state)
            continue

        print(f"Unrecognised command: {command}")

    state["current_index"] = max(0, min(index, total))
    save_state(repo_root / "auto_code_review_state.json", state)

    if index >= total:
        print("All findings processed.")


def main() -> int:
    repo_root = find_repo_root()
    review_path = find_latest_review(repo_root)
    if not review_path:
        print("No auto_code_review.md file found. Run the pre-commit hook first.")
        return 1

    try:
        review_text = review_path.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"Failed to read {review_path}: {exc}")
        return 1

    findings = parse_bad_findings(review_text)
    if not findings:
        print("No BAD findings found in the latest review.")
        return 0

    review_hash = sha256((str(review_path) + review_text).encode("utf-8")).hexdigest()
    state_path = repo_root / "auto_code_review_state.json"
    state = load_state(state_path)
    state = ensure_state_for_findings(state, review_hash, findings)
    save_state(state_path, state)

    try:
        interactive_loop(repo_root, findings, state)
    except KeyboardInterrupt:
        print("\nInterrupted by user.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
