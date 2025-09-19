#!/usr/bin/env python3
"""Interactive helper for triaging BAD assessments from auto_code_review.md.

This utility scans the generated ``auto_code_review.md`` report, finds the
sections that were flagged as ``BAD`` by the reviewer, and walks through them
one by one. For every issue the user is asked whether it should be handed to an
AI assistant (Gemini or Cursor) in a manual approval mode. When the user agrees
the script prepares a rich prompt containing the review context and the
corresponding ``git diff`` and launches the configured AI CLI.

The script aims to provide a portable alternative to the requested "button" in
the Markdown file which is not technically feasible. It works on Linux, macOS
and Windows as long as Python 3.8+ is available.
"""

from __future__ import annotations

import argparse
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional


# ----------------------------------------------------------------------------
# Data model
# ----------------------------------------------------------------------------


@dataclass
class ReviewAssessment:
    """Container for a single assessment block from the review file."""

    index: int
    rating: str
    fields: Dict[str, str]
    raw_markdown: str

    @property
    def title(self) -> Optional[str]:
        return self.fields.get("title")

    @property
    def file(self) -> Optional[str]:
        return self.fields.get("file")

    @property
    def function(self) -> Optional[str]:
        return self.fields.get("function")

    @property
    def lines(self) -> Optional[str]:
        return self.fields.get("lines")

    @property
    def details(self) -> Optional[str]:
        return self.fields.get("details")

    @property
    def suggestion(self) -> Optional[str]:
        return self.fields.get("suggestion") or self.fields.get(
            "suggestion_if_bad"
        )

    @property
    def reasoning(self) -> Optional[str]:
        return self.fields.get("reasoning") or self.fields.get(
            "reasoning_if_bad"
        )


# ----------------------------------------------------------------------------
# Parsing helpers
# ----------------------------------------------------------------------------


ASSESSMENT_HEADER_RE = re.compile(
    r"^###\s+Assessment of the change:\s*(?P<rating>[A-Za-z]+)", re.IGNORECASE
)
FIELD_RE = re.compile(r"^\*\*(?P<name>[^:]+):\*\*\s*(?P<value>.*)$")


def _normalise_key(raw: str) -> str:
    """Convert field labels from markdown into stable dictionary keys."""

    cleaned = raw.lower()
    cleaned = re.sub(r"\(.*?\)", "", cleaned)  # remove parenthetical hints
    cleaned = re.sub(r"[^a-z0-9]+", "_", cleaned)
    return cleaned.strip("_")


def _clean_markdown_value(value: str) -> str:
    """Normalise markdown values by stripping trailing spaces used for line breaks."""

    lines = [line.rstrip() for line in value.splitlines()]
    return "\n".join(lines).strip()


def parse_review_file(text: str) -> List[ReviewAssessment]:
    """Extract assessment entries from the markdown review file."""

    assessments: List[ReviewAssessment] = []
    current_lines: List[str] = []
    current_rating: Optional[str] = None

    for line in text.splitlines():
        header_match = ASSESSMENT_HEADER_RE.match(line)
        if header_match:
            if current_rating is not None:
                assessment = _build_assessment(
                    len(assessments) + 1, current_rating, current_lines
                )
                assessments.append(assessment)
            current_rating = header_match.group("rating").strip().upper()
            current_lines = []
            continue

        if current_rating is not None:
            # Skip delimiter lines that just contain ---
            if line.strip() == "---" and not current_lines:
                continue
            current_lines.append(line)

    if current_rating is not None:
        assessment = _build_assessment(
            len(assessments) + 1, current_rating, current_lines
        )
        assessments.append(assessment)

    return assessments


def _build_assessment(
    index: int, rating: str, lines: Iterable[str]
) -> ReviewAssessment:
    field_map: Dict[str, str] = {}
    current_key: Optional[str] = None
    parts: List[str] = []

    for raw_line in lines:
        parts.append(raw_line)
        stripped = raw_line.strip()
        if not stripped:
            if current_key is not None:
                field_map[current_key] += "\n"
            continue

        field_match = FIELD_RE.match(stripped)
        if field_match:
            current_key = _normalise_key(field_match.group("name"))
            field_map[current_key] = field_match.group("value").strip()
            continue

        if current_key is not None:
            field_map[current_key] += "\n" + stripped

    cleaned_fields = {k: _clean_markdown_value(v) for k, v in field_map.items()}
    raw_markdown = "\n".join(parts).strip()

    return ReviewAssessment(
        index=index,
        rating=rating,
        fields=cleaned_fields,
        raw_markdown=raw_markdown,
    )


# ----------------------------------------------------------------------------
# Prompt building helpers
# ----------------------------------------------------------------------------


def collect_git_diff(repo_root: Path, file_path: Optional[str]) -> Optional[str]:
    if not file_path or file_path.upper() == "N/A":
        return None

    cmd = ["git", "diff", "HEAD", "--", file_path]
    try:
        result = subprocess.run(
            cmd,
            cwd=repo_root,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
    except OSError:
        return None

    if result.returncode != 0:
        return None

    diff = result.stdout.strip()
    return diff or None


def build_prompt(
    repo_root: Path,
    review_path: Path,
    assessment: ReviewAssessment,
    diff_text: Optional[str],
) -> str:
    summary_lines = [
        "You are assisting with a fix requested by an automated pre-commit code review.",
        "Work within the repository located at: {root}".format(root=repo_root),
    ]

    if assessment.file:
        summary_lines.append(
            "Primary file(s) of interest from the review: {file}".format(
                file=assessment.file
            )
        )

    summary_lines.extend(
        [
            "Focus on resolving the concrete issues highlighted in the review excerpt below while"
            " keeping unrelated code unchanged.",
            "Operate in a mode that requires explicit confirmation before applying any edits so"
            " the developer can approve each change.",
            "",
            "Key fields from the review:",
        ]
    )

    details = [
        ("Title", assessment.title),
        ("Function / Scope", assessment.function),
        ("Lines", assessment.lines),
        ("Details", assessment.details),
        ("Suggestion", assessment.suggestion),
        ("Reasoning", assessment.reasoning),
    ]

    for label, value in details:
        if value:
            summary_lines.append(f"- {label}: {value}")

    summary_lines.extend(
        [
            "",
            "Complete review block from auto_code_review.md (for reference):",
            assessment.raw_markdown,
        ]
    )

    if diff_text:
        summary_lines.extend(
            [
                "",
                "Relevant git diff for {file}:".format(
                    file=assessment.file or "the affected file"
                ),
                "```diff",
                diff_text,
                "```",
            ]
        )
    else:
        summary_lines.extend(
            [
                "",
                "No git diff was automatically detected. Inspect the repository to understand"
                " the necessary edits before proposing changes.",
            ]
        )

    summary_lines.extend(
        [
            "",
            "When you propose edits, ensure the resulting code builds/tests as expected and"
            " update or add tests when needed.",
            "Reference review source: {path}".format(path=review_path),
        ]
    )

    return "\n".join(summary_lines).strip() + "\n"


# ----------------------------------------------------------------------------
# Command launching
# ----------------------------------------------------------------------------


def detect_repo_root(start: Path) -> Path:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=start,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        return Path(result.stdout.strip())
    except (subprocess.CalledProcessError, FileNotFoundError):
        return start


def _shlex_split(command: str) -> List[str]:
    posix = os.name != "nt"
    return shlex.split(command, posix=posix)


def prepare_command(
    args: argparse.Namespace,
    assessment: ReviewAssessment,
    prompt_path: Path,
) -> tuple[List[str], bool]:
    """Return the command to execute and whether stdin should be used for the prompt."""

    formatting_context = {
        "prompt_file": str(prompt_path),
        "file": assessment.file or "",
        "title": assessment.title or "",
        "index": str(assessment.index),
    }

    if args.command:
        formatted = args.command.format(**formatting_context)
        use_stdin = "{prompt_file}" not in args.command
        command_list = _shlex_split(formatted)
        return command_list, use_stdin

    if args.provider in {"auto", "gemini"}:
        gemini_executable = shutil.which(args.gemini_executable)
        if gemini_executable:
            command_list = [
                gemini_executable,
                "--approval-mode",
                args.gemini_approval_mode,
                "-m",
                args.gemini_model,
            ]
            return command_list, True

        if args.provider == "gemini":
            raise RuntimeError(
                f"Gemini CLI '{args.gemini_executable}' was not found in PATH."
            )

    if args.provider in {"auto", "cursor"}:
        cursor_executable = shutil.which(args.cursor_executable)
        if cursor_executable and args.provider != "cursor":
            # We only warn by default; cursor usage requires custom command to ensure
            # manual approval behaviour which differs per installation.
            pass
        if args.provider == "cursor":
            raise RuntimeError(
                "Cursor CLI requires a custom command (--command) to describe how to"
                " launch interactive mode."
            )

    raise RuntimeError(
        "No AI CLI command is configured. Provide --command or install the Gemini CLI."
    )


def run_ai_command(
    args: argparse.Namespace,
    assessment: ReviewAssessment,
    prompt: str,
) -> int:
    """Execute the configured AI command with the generated prompt."""

    with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8") as handle:
        handle.write(prompt)
        prompt_path = Path(handle.name)

    if args.print_prompt:
        divider = "=" * 60
        print(divider)
        print(prompt)
        print(divider)

    try:
        command, use_stdin = prepare_command(args, assessment, prompt_path)
    except RuntimeError as exc:  # pragma: no cover - defensive user feedback
        print(f"[WARN] {exc}")
        print(f"Prompt saved to: {prompt_path}")
        return 1

    if args.verbose:
        cmd_repr = " ".join(shlex.quote(part) for part in command)
        print(f"[INFO] Launching: {cmd_repr}")

    stdin_handle = None
    try:
        if use_stdin:
            stdin_handle = prompt_path.open("r", encoding="utf-8")
        result = subprocess.run(
            command,
            stdin=stdin_handle,
            check=False,
        )
        return_code = result.returncode
    except FileNotFoundError as exc:
        print(f"[ERROR] Failed to launch AI CLI: {exc}")
        return_code = 1
    finally:
        if stdin_handle:
            stdin_handle.close()
        prompt_path.unlink(missing_ok=True)

    if return_code != 0:
        print(
            "[WARN] AI command exited with a non-zero status. Check the CLI output"
            " above for additional details."
        )
    return return_code


# ----------------------------------------------------------------------------
# Presentation helpers
# ----------------------------------------------------------------------------


def _print_section(title: str, content: Optional[str]) -> None:
    if not content:
        return
    print(f"{title}:")
    print(textwrap.indent(content.strip(), prefix="  "))


def display_assessment(assessment: ReviewAssessment, total: int) -> None:
    header = f"BAD assessment {assessment.index}/{total}"
    print("\n" + "=" * len(header))
    print(header)
    print("=" * len(header))
    if assessment.title:
        print(f"Title: {assessment.title}")
    if assessment.file:
        print(f"File: {assessment.file}")
    if assessment.function:
        print(f"Function: {assessment.function}")
    if assessment.lines:
        print(f"Lines: {assessment.lines}")

    _print_section("Details", assessment.details)
    _print_section("Suggestion", assessment.suggestion)
    _print_section("Reasoning", assessment.reasoning)


def prompt_user_choice() -> str:
    try:
        return input("Send issue to AI fixer? [y/N/q]: ").strip().lower()
    except EOFError:
        return "n"


# ----------------------------------------------------------------------------
# Command-line interface
# ----------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Interactively step through BAD assessments reported in"
            " auto_code_review.md and optionally hand them to an AI assistant."
        )
    )
    parser.add_argument(
        "--path",
        default="auto_code_review.md",
        help="Path to the review markdown file (default: auto_code_review.md).",
    )
    parser.add_argument(
        "--provider",
        choices=["auto", "gemini", "cursor"],
        default="auto",
        help=(
            "Preferred AI CLI provider. 'auto' picks Gemini when available."
            " For Cursor you must also provide --command to describe how to"
            " start an interactive session."
        ),
    )
    parser.add_argument(
        "--command",
        help=(
            "Custom command template for launching the AI CLI. The template can"
            " reference {prompt_file}, {file}, {title} and {index}. If the"
            " template omits {prompt_file}, the prompt content will be provided"
            " via standard input."
        ),
    )
    parser.add_argument(
        "--gemini-executable",
        default="gemini",
        help="Executable name for the Gemini CLI (default: gemini).",
    )
    parser.add_argument(
        "--gemini-model",
        default="gemini-2.5-pro",
        help="Model identifier passed to the Gemini CLI (default: gemini-2.5-pro).",
    )
    parser.add_argument(
        "--gemini-approval-mode",
        default="manual",
        help=(
            "Approval mode passed to the Gemini CLI. Use a mode that requires"
            " confirmation for edits (default: manual)."
        ),
    )
    parser.add_argument(
        "--cursor-executable",
        default="cursor-agent",
        help="Executable name for the Cursor CLI (default: cursor-agent).",
    )
    parser.add_argument(
        "--print-prompt",
        action="store_true",
        help="Echo the generated prompt before launching the AI command.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Show debug information such as the exact command being executed.",
    )
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    cwd = Path.cwd()
    repo_root = detect_repo_root(cwd)
    review_path = Path(args.path)
    if not review_path.is_absolute():
        review_path = repo_root / review_path

    if not review_path.exists():
        parser.error(f"Review file not found: {review_path}")

    text = review_path.read_text(encoding="utf-8")
    assessments = parse_review_file(text)
    bad_assessments = [a for a in assessments if a.rating == "BAD"]

    if not bad_assessments:
        print("No BAD assessments were found in the review file.")
        return 0

    total = len(bad_assessments)
    for idx, assessment in enumerate(bad_assessments, start=1):
        assessment.index = idx  # Ensure sequential numbering for display
        display_assessment(assessment, total)

        while True:
            choice = prompt_user_choice()
            if choice in {"", "n", "no"}:
                break
            if choice in {"q", "quit"}:
                print("Aborting at user request.")
                return 1
            if choice in {"y", "yes"}:
                diff = collect_git_diff(repo_root, assessment.file)
                prompt = build_prompt(repo_root, review_path, assessment, diff)
                run_ai_command(args, assessment, prompt)
                break
            print("Please answer with 'y', 'n', or 'q'.")

    print("All found issues addressed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
